const { Client, GatewayIntentBits, Events, ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder } = require('discord.js');
const http = require('http');

const TOKEN = process.env.BOT_TOKEN;
const GUILD_ID = '1041454652782280784';
const AUDIT_CHANNEL_ID = '1329418908234682428';
const PROXY = 'https://ems-proxy.mirely1234.workers.dev';
const SA_PASS = process.env.SA_PASS || 'YUSHA_SUPERADMIN';

const PORT = process.env.PORT || 10000;
http.createServer(async (req, res) => {
  // Keep-alive ping also checks bot status
  const status = client.isReady() ? 'online' : 'offline';
  res.writeHead(200, {'Content-Type':'application/json'});
  res.end(JSON.stringify({ status, uptime: process.uptime() }));
  
  // If bot disconnected - reconnect
  if (!client.isReady()) {
    console.log('[PING] Bot offline, reconnecting...');
    try { await client.login(TOKEN); } catch(e) { console.error('Reconnect failed:', e.message); }
  }
}).listen(PORT, () => console.log(`HTTP on ${PORT}`));

const APPROVER_ROLES = ['1328668577082904630','1041467317353193472'];

// Rank names map
const RANK_NAMES = {
  1:'Студент (1)', 2:'Інтерн (2)', 3:'Парамедик (3)',
  4:'Фельдшер (4)', 5:'Терапевт (5)', 6:'Хірург (6)',
  7:'Спеціаліст (7)', 8:'Заст. Завід. (8)', 9:'Завідувач (9)',
  10:'Заст. Гол. Лікаря (10)', 11:'Головний Лікар',
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// ── KV ────────────────────────────────────────────────────────────────
async function getStaff() {
  try {
    const r = await fetch(`${PROXY}/admin/staff`, { headers: { 'X-Admin-Password': SA_PASS } });
    const j = await r.json();
    return j.staff || [];
  } catch(e) { console.error('getStaff error:', e.message); return []; }
}

async function saveStaff(staff) {
  try {
    await fetch(`${PROXY}/admin/staff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Password': SA_PASS },
      body: JSON.stringify({ staff }),
    });
  } catch(e) { console.error('saveStaff error:', e.message); }
}

function parseNewFormat(embed) {
  const fields = embed.fields || [];
  if (!fields.length) return null;

  // Helper to clean markdown bold and backticks
  const clean = s => (s||'').replace(/\*\*/g,'').replace(/`/g,'').trim();

  // Find fields by partial name match (emoji prefix varies)
  const diaField    = fields.find(f => f.name?.includes('Дія') || f.name?.includes('Дiя'));
  const workerField = fields.find(f => f.name?.includes('Працівник') || f.name?.includes('Працiвник'));
  const rankField   = fields.find(f => f.name?.includes('Ранг'));

  if (!workerField) return null;

  // Parse action
  const dia = clean(diaField?.value || '');
  let action = null;
  if (dia.includes('Підвищив') || dia.includes('Пiдвищив')) action = 'promote';
  else if (dia.includes('Понизив')) action = 'demote';
  else if (dia.includes('Прийняв')) action = 'hire';
  else if (dia.includes('Звільнив') || dia.includes('Звiльнив')) action = 'fire';
  if (!action) return null;

  // Parse worker — clean bold: "**Artem Win #847**" → "Artem Win #847"
  const workerText = clean(workerField.value || '');
  const workerMatch = workerText.match(/^(.+?)\s*#(\d+)$/);
  if (!workerMatch) return null;
  const name = workerMatch[1].trim();
  const staticId = workerMatch[2].trim();

  // Parse rank — "З **2 ранг** на **3 ранг**" → toRank=3
  // "Звільнений(-а) з **3 ранг**" → fromRank=3
  const rankText = clean(rankField?.value || '');
  let toRank = null;
  const rankToMatch = rankText.match(/на\s+(\d+)\s+ранг/i);
  if (rankToMatch) {
    toRank = parseInt(rankToMatch[1]);
  } else {
    // For hire: get any rank number
    const nums = rankText.match(/\d+/g);
    if (nums && action === 'hire') toRank = parseInt(nums[0]);
  }

  return { action, name, staticId, toRank, rankText };
}

// ── PARSE OLD FORMAT (title-based) ────────────────────────────────────
function parseOldFormat(embed) {
  const title = embed.title || '';
  const fields = embed.fields || [];

  let action = null;
  if (title.includes('ПРИЙНЯТО')) action = 'hire';
  else if (title.includes('ЗВІЛЬНЕНО')) action = 'fire';
  else if (title.includes('ПЕРЕВЕДЕНО') || title.includes('ДОВІРЕНА')) action = 'promote';
  if (!action) return null;

  // Find rank change field "🔁 Зміна посади" or "🔄 Зміна посади"
  const changeField = fields.find(f => f.name && (f.name.includes('Зміна') || f.name.includes('Змiна')));
  if (!changeField) return null;

  // Extract rank number from "[N] Name"
  const rankNums = (changeField.value || '').match(/\[(\d+)\]\s*[^`]+`?\s*(?:➡️|🟢|🔴)/g);
  let toRank = null;
  // Get the LAST rank mentioned (destination)
  const allNums = [...(changeField.value || '').matchAll(/\[(\d+)\]/g)];
  if (allNums.length > 0) {
    toRank = parseInt(allNums[allNums.length - 1][1]);
  }

  // No name/static in old format - skip for staff updates
  // Old format doesn't have worker identity - we can't update staff
  return null;
}

// ── PROCESS MESSAGE ────────────────────────────────────────────────────
async function processAuditMessage(message) {
  if (!message.embeds || !message.embeds.length) return;

  for (const embed of message.embeds) {
    // Try new format first (has Працівник field)
    let parsed = parseNewFormat(embed);

    // Log every parsed result
    if (parsed) {
      console.log(`[AUDIT] ${parsed.action} | ${parsed.name} #${parsed.staticId} | rank=${parsed.toRank}`);
    }

    if (!parsed || !parsed.name || !parsed.staticId) continue;

    try {
      const staff = await getStaff();
      const idx = staff.findIndex(s => {
        const sStatic = (s.static||'').replace('#','').trim();
        return sStatic === parsed.staticId;
      });

      if (parsed.action === 'fire') {
        // Remove from staff
        if (idx >= 0) {
          staff.splice(idx, 1);
          await saveStaff(staff);
          console.log(`[AUDIT] ✅ Removed: ${parsed.name} #${parsed.staticId}`);
        }
      } else if (parsed.action === 'hire') {
        if (idx < 0) {
          // Add new worker - only save rank if 8+
          const rankName = parsed.toRank >= 8 ? (RANK_NAMES[parsed.toRank] || `Ранг ${parsed.toRank}`) : '';
          staff.push({
            name: parsed.name,
            static: parsed.staticId,
            rank: rankName || (RANK_NAMES[parsed.toRank] || 'Студент (1)'),
            added: new Date().toLocaleDateString('uk-UA'),
          });
          await saveStaff(staff);
          console.log(`[AUDIT] ✅ Added: ${parsed.name} #${parsed.staticId} rank=${rankName}`);
        } else {
          // Update rank if rehired
          if (parsed.toRank) {
            staff[idx].rank = RANK_NAMES[parsed.toRank] || staff[idx].rank;
            await saveStaff(staff);
          }
        }
      } else if (parsed.action === 'promote' || parsed.action === 'demote') {
        if (idx >= 0) {
          if (parsed.toRank) {
            staff[idx].rank = RANK_NAMES[parsed.toRank] || `Ранг ${parsed.toRank}`;
            await saveStaff(staff);
            console.log(`[AUDIT] ✅ Rank updated: ${parsed.name} → ${staff[idx].rank}`);
          }
        } else {
          // Not found - add them
          if (parsed.toRank) {
            staff.push({
              name: parsed.name,
              static: parsed.staticId,
              rank: RANK_NAMES[parsed.toRank] || `Ранг ${parsed.toRank}`,
              added: new Date().toLocaleDateString('uk-UA'),
            });
            await saveStaff(staff);
            console.log(`[AUDIT] ✅ Added (from promote): ${parsed.name} #${parsed.staticId}`);
          }
        }
      }
    } catch(e) {
      console.error('[AUDIT] Error:', e.message);
    }
  }
}

// ── READY ──────────────────────────────────────────────────────────────
client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot ready: ${client.user.tag}`);
  scheduleReminders();
  await syncAuditChannel();
});

// ── NEW MESSAGES ───────────────────────────────────────────────────────
client.on(Events.MessageCreate, async (message) => {
  if (message.channelId === AUDIT_CHANNEL_ID) {
    await processAuditMessage(message);
    return;
  }

  if (!message.author.bot || !message.webhookId) return;
  if (!message.embeds.length) return;
  const embed = message.embeds[0];
  if (!embed?.title) return;

  const needsApproval = ['підвищення','відпустк','відгул','звільнення','стягнення','зняття','преміювання'];
  if (!needsApproval.some(t => embed.title.toLowerCase().includes(t))) return;

  const approve = new ButtonBuilder().setCustomId('approve').setLabel('✅ Схвалено').setStyle(ButtonStyle.Success);
  const reject  = new ButtonBuilder().setCustomId('reject').setLabel('❌ Відхилено').setStyle(ButtonStyle.Danger);
  const pending = new ButtonBuilder().setCustomId('pending').setLabel('⏳ На розгляді').setStyle(ButtonStyle.Secondary).setDisabled(true);
  const row = new ActionRowBuilder().addComponents(pending, approve, reject);
  try { await message.reply({ components: [row], content: '**Статус запиту:**' }); } catch(e) {}
});

// ── BUTTONS ─────────────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  if (interaction.customId === 'pending') return;
  const member = interaction.member;
  const hasRole = member.roles.cache.some(r => APPROVER_ROLES.includes(r.id));
  if (!hasRole) { await interaction.reply({ content:'❌ Немає прав.', ephemeral:true }); return; }

  const action = interaction.customId;
  const user = interaction.user;
  const now = new Date().toLocaleString('uk-UA',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',timeZone:'Europe/Kyiv'});
  const emoji = action==='approve'?'✅':'❌';
  const label = action==='approve'?'Схвалено':'Відхилено';

  const approve = new ButtonBuilder().setCustomId('approve').setLabel('✅ Схвалено').setStyle(ButtonStyle.Success).setDisabled(action!=='approve');
  const reject  = new ButtonBuilder().setCustomId('reject').setLabel('❌ Відхилено').setStyle(ButtonStyle.Danger).setDisabled(action!=='reject');
  const statusBtn = new ButtonBuilder().setCustomId('status').setLabel(`${emoji} ${label} — ${user.username} · ${now}`).setStyle(action==='approve'?ButtonStyle.Success:ButtonStyle.Danger).setDisabled(true);
  await interaction.update({ components:[new ActionRowBuilder().addComponents(statusBtn,approve,reject)] });
});

// ── SYNC ───────────────────────────────────────────────────────────────
async function syncAuditChannel() {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.fetch(AUDIT_CHANNEL_ID);
    if (!channel) { console.log('Channel not found'); return; }
    console.log(`📋 Syncing: ${channel.name}`);

    // Collect ALL new-format messages first
    const allMessages = [];
    let lastId = null;
    while (true) {
      const opts = { limit: 100 };
      if (lastId) opts.before = lastId;
      const messages = await channel.messages.fetch(opts);
      if (!messages.size) break;
      for (const [, msg] of messages) {
        if (msg.embeds?.length && msg.embeds.some(e => e.fields?.find(f => f.name?.includes('Працівник')))) {
          allMessages.push(msg);
        }
      }
      lastId = messages.last()?.id;
      if (messages.size < 100) break;
      await new Promise(r => setTimeout(r, 500));
    }

    // Sort oldest → newest and process in order
    allMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    console.log(`Found ${allMessages.length} new-format messages, processing oldest→newest`);

    for (const msg of allMessages) {
      await processAuditMessage(msg);
    }

    console.log(`✅ Sync done: ${allMessages.length} messages processed`);
  } catch(e) { console.error('Sync error:', e.message); }
}

// ── REMINDERS ─────────────────────────────────────────────────────────
function scheduleReminders() {
  setInterval(async () => {
    const now = new Date();
    const kyivHour = (now.getUTCHours() + 3) % 24;
    const kyivDay = new Date(now.getTime() + 3*3600000).getUTCDay();
    if (kyivDay === 6 && kyivHour === 18 && now.getUTCMinutes() === 0) {
      await sendReminder();
    }
  }, 60000);
}

async function sendReminder() {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const members = await guild.members.fetch();
    const embed = new EmbedBuilder()
      .setTitle('⏰ Нагадування про звіт!')
      .setColor(0xfee75c)
      .setDescription('**Сьогодні субота** — здай звіт до 20:00!\n📋 **ems-reports.pages.dev**')
      .setTimestamp();
    let sent = 0;
    for (const [, m] of members) {
      if (m.user.bot) continue;
      if (!m.roles.cache.some(r => APPROVER_ROLES.includes(r.id))) continue;
      try { await m.send({ embeds:[embed] }); sent++; await new Promise(r=>setTimeout(r,500)); } catch(e){}
    }
    console.log(`Reminder sent to ${sent}`);
  } catch(e) { console.error('Reminder error:', e); }
}

client.login(TOKEN);
