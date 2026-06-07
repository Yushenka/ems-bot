const { Client, GatewayIntentBits, Events, ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder } = require('discord.js');
const http = require('http');

// Keep-alive HTTP server for Render
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('EMS Bot running');
}).listen(PORT, () => console.log(`HTTP server on port ${PORT}`));

const TOKEN = process.env.BOT_TOKEN;
const GUILD_ID = '1041454652782280784';
const AUDIT_CHANNEL_ID = '1329418908234682428';
const PROXY = 'https://ems-proxy.mirely1234.workers.dev';

// SA password for KV writes
const SA_PASS = process.env.SA_PASS || 'YUSHA_SUPERADMIN';

const APPROVER_ROLES = [
  '1328668577082904630', // Головний лікар
  '1041467317353193472', // Заступник головного лікаря
];

// Rank map — number to name
const RANK_NAMES = {
  1: 'Студент (1)', 2: 'Інтерн (2)', 3: 'Парамедик (3)',
  4: 'Фельдшер (4)', 5: 'Терапевт (5)', 6: 'Хірург (6)',
  7: 'Спеціаліст (7)', 8: 'Заст. Завід. (8)', 9: 'Завідувач (9)',
  10: 'Заст. Гол. Лікаря (10)', 11: 'Головний Лікар',
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// ── KV HELPERS ─────────────────────────────────────────────────────
async function getStaff() {
  const r = await fetch(`${PROXY}/admin/staff`, {
    headers: { 'X-Admin-Password': SA_PASS }
  });
  const j = await r.json();
  return j.staff || [];
}

async function saveStaff(staff) {
  await fetch(`${PROXY}/admin/staff`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Password': SA_PASS },
    body: JSON.stringify({ staff }),
  });
}

// ── PARSE AUDIT EMBED ───────────────────────────────────────────────
// Cutoff date: May 22, 2026
const SYNC_CUTOFF = new Date('2026-05-22T00:00:00+03:00').getTime();

function parseAuditEmbed(embed, messageTimestamp) {
  // Only process messages after May 22, 2026
  if (messageTimestamp && messageTimestamp < SYNC_CUTOFF) return null;

  const fields = embed.fields || [];

  // New format: has "Дія" and "Працівник" fields (Swarovski bot)
  const diaField = fields.find(f => f.name?.includes('Дія') || f.name?.includes('Дiя'));
  const workerField = fields.find(f => f.name?.includes('Працівник') || f.name?.includes('Працiвник'));
  const rankField = fields.find(f => f.name?.includes('Ранг'));

  if (!diaField || !workerField) return null;

  // Parse action
  const diaText = diaField.value || '';
  let action = null;
  if (diaText.includes('Підвищив') || diaText.includes('Пiдвищив')) action = 'promote';
  else if (diaText.includes('Понизив')) action = 'demote';
  else if (diaText.includes('Прийняв')) action = 'hire';
  else if (diaText.includes('Звільнив') || diaText.includes('Звiльнив')) action = 'fire';
  if (!action) return null;

  // Parse worker name and static from "Artem Win #847"
  const workerText = (workerField.value || '').trim();
  const workerMatch = workerText.match(/^(.+?)\s*#(\d+)$/);
  if (!workerMatch) return null;
  const name = workerMatch[1].trim();
  const staticId = workerMatch[2].trim();

  // Parse rank from rank field
  const rankText = (rankField?.value || '').trim();
  // "3 4 ранг на 5 ранг" → toRank=5
  // "Звільнений(-а) з 3 ранг" → fromRank=3
  // "Прийнятий(-а) на 1 ранг" → toRank=1
  let toRank = null;
  const rankToMatch = rankText.match(/на\s*(\d+)\s*ранг/i);
  const rankDirectMatch = rankText.match(/(\d+)\s*ранг\s*$/i);
  if (rankToMatch) toRank = parseInt(rankToMatch[1]);
  else if (rankDirectMatch && (action === 'hire' || action === 'promote' || action === 'demote')) {
    // Try to get the last rank number
    const nums = rankText.match(/\d+/g);
    if (nums) toRank = parseInt(nums[nums.length - 1]);
  }

  return { action, name, staticId, toRank, rankText };
}

// ── PROCESS AUDIT MESSAGE ───────────────────────────────────────────
async function processAuditMessage(message) {
  if (!message.embeds || !message.embeds.length) return;

  const msgTs = message.createdTimestamp;

  for (const embed of message.embeds) {
    const parsed = parseAuditEmbed(embed, msgTs);
    if (!parsed || !parsed.name || !parsed.staticId) continue;

    const { action, name, staticId, toRank } = parsed;
    console.log(`[AUDIT] ${action} | ${name} #${staticId} | rank→${toRank}`);

    try {
      const staff = await getStaff();

      if (action === 'hire') {
        // Add new worker
        const exists = staff.find(s => s.static === staticId);
        if (!exists) {
          staff.push({
            name,
            static: staticId,
            rank: RANK_NAMES[toRank || 1] || 'Студент (1)',
            added: new Date().toLocaleDateString('uk-UA'),
          });
          await saveStaff(staff);
          console.log(`[AUDIT] ✅ Added: ${name} #${staticId}`);
        }
      } else if (action === 'promote' || action === 'demote') {
        // Update rank
        const idx = staff.findIndex(s => s.static === staticId);
        if (idx >= 0 && toRank) {
          staff[idx].rank = RANK_NAMES[toRank] || `Ранг ${toRank}`;
          await saveStaff(staff);
          console.log(`[AUDIT] ✅ Updated rank: ${name} → ${staff[idx].rank}`);
        } else if (idx < 0) {
          // Not found — add them
          staff.push({
            name, static: staticId,
            rank: RANK_NAMES[toRank] || `Ранг ${toRank}`,
            added: new Date().toLocaleDateString('uk-UA'),
          });
          await saveStaff(staff);
        }
      } else if (action === 'fire') {
        // Remove worker
        const filtered = staff.filter(s => s.static !== staticId);
        if (filtered.length < staff.length) {
          await saveStaff(filtered);
          console.log(`[AUDIT] ✅ Removed: ${name} #${staticId}`);
        }
      }
    } catch (e) {
      console.error('[AUDIT] Error processing:', e);
    }
  }
}

// ── READY ──────────────────────────────────────────────────────────
client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot ready: ${client.user.tag}`);
  scheduleReminders();
  await syncAuditChannel();
});

// ── LISTEN TO NEW AUDIT MESSAGES ───────────────────────────────────
client.on(Events.MessageCreate, async (message) => {
  // Process new audit entries
  if (message.channelId === AUDIT_CHANNEL_ID) {
    await processAuditMessage(message);
    return;
  }

  // Add approve buttons to report webhooks
  if (!message.author.bot || !message.webhookId) return;
  if (!message.embeds.length) return;

  const embed = message.embeds[0];
  if (!embed?.title) return;

  const needsApproval = ['підвищення', 'відпустк', 'відгул', 'звільнення', 'стягнення', 'зняття', 'преміювання'];
  const matches = needsApproval.some(t => embed.title.toLowerCase().includes(t));
  if (!matches) return;

  const approve = new ButtonBuilder().setCustomId('approve').setLabel('✅ Схвалено').setStyle(ButtonStyle.Success);
  const reject = new ButtonBuilder().setCustomId('reject').setLabel('❌ Відхилено').setStyle(ButtonStyle.Danger);
  const pending = new ButtonBuilder().setCustomId('pending').setLabel('⏳ На розгляді').setStyle(ButtonStyle.Secondary).setDisabled(true);
  const row = new ActionRowBuilder().addComponents(pending, approve, reject);

  try { await message.reply({ components: [row], content: '**Статус запиту:**' }); }
  catch(e) { console.log('Could not add buttons:', e.message); }
});

// ── BUTTON INTERACTIONS ────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  if (interaction.customId === 'pending') return;

  const member = interaction.member;
  const hasRole = member.roles.cache.some(r => APPROVER_ROLES.includes(r.id));
  if (!hasRole) {
    await interaction.reply({ content: '❌ У вас немає прав для цієї дії.', ephemeral: true });
    return;
  }

  const action = interaction.customId;
  const user = interaction.user;
  const now = new Date().toLocaleString('uk-UA', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit', timeZone:'Europe/Kyiv' });

  const approve = new ButtonBuilder().setCustomId('approve').setLabel('✅ Схвалено').setStyle(ButtonStyle.Success).setDisabled(action !== 'approve');
  const reject = new ButtonBuilder().setCustomId('reject').setLabel('❌ Відхилено').setStyle(ButtonStyle.Danger).setDisabled(action !== 'reject');
  const statusBtn = new ButtonBuilder()
    .setCustomId('status')
    .setLabel(`${action === 'approve' ? '✅' : '❌'} ${action === 'approve' ? 'Схвалено' : 'Відхилено'} — ${user.username} · ${now}`)
    .setStyle(action === 'approve' ? ButtonStyle.Success : ButtonStyle.Danger)
    .setDisabled(true);

  const row = new ActionRowBuilder().addComponents(statusBtn, approve, reject);
  await interaction.update({ components: [row] });
});

// ── SYNC AUDIT CHANNEL ON START ────────────────────────────────────
async function syncAuditChannel() {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.fetch(AUDIT_CHANNEL_ID);
    if (!channel) { console.log('Audit channel not found'); return; }

    console.log(`📋 Syncing audit channel: ${channel.name}`);
    let lastId = null;
    let totalProcessed = 0;

    // Fetch in batches of 100
    while (true) {
      const options = { limit: 100 };
      if (lastId) options.before = lastId;
      const messages = await channel.messages.fetch(options);
      if (!messages.size) break;

      for (const [, msg] of messages) {
        await processAuditMessage(msg);
        totalProcessed++;
      }

      lastId = messages.last()?.id;
      if (messages.size < 100) break;
      // Rate limit protection
      await new Promise(r => setTimeout(r, 1000));
    }

    console.log(`✅ Audit sync done: processed ${totalProcessed} messages`);
  } catch (e) {
    console.error('Audit sync error:', e);
  }
}

// ── SATURDAY REMINDER ──────────────────────────────────────────────
function scheduleReminders() {
  setInterval(async () => {
    const now = new Date();
    const kyivHour = (now.getUTCHours() + 3) % 24;
    const kyivDay = new Date(now.getTime() + 3 * 3600000).getUTCDay();
    const kyivMin = now.getUTCMinutes();
    if (kyivDay === 6 && kyivHour === 18 && kyivMin === 0) {
      await sendSaturdayReminder();
    }
  }, 60000);
}

async function sendSaturdayReminder() {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const members = await guild.members.fetch();
    const embed = new EmbedBuilder()
      .setTitle('⏰ Нагадування про звіт на преміювання!')
      .setColor(0xfee75c)
      .setDescription('**Сьогодні субота** — не забудь здати звіт!\n\n⏳ Дедлайн: **20:00 Київ**\n📋 Форма: **ems-reports.pages.dev**')
      .setTimestamp();

    let sent = 0;
    for (const [, member] of members) {
      if (member.user.bot) continue;
      const hasRole = member.roles.cache.some(r => APPROVER_ROLES.includes(r.id));
      if (!hasRole) continue;
      try { await member.send({ embeds: [embed] }); sent++; await new Promise(r => setTimeout(r, 500)); }
      catch(e) {}
    }
    console.log(`Saturday reminder sent to ${sent} members`);
  } catch (e) { console.error('Reminder error:', e); }
}

client.login(TOKEN);
