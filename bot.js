const { Client, GatewayIntentBits, Events, ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder, REST, Routes } = require('discord.js');

// ── CONFIG ────────────────────────────────────────────────────────────
const TOKEN = process.env.BOT_TOKEN;
const GUILD_ID = '1041454652782280784';
const AUDIT_CHANNEL_ID = '1329418908234682428';

// Webhook channels — бот слідкує за цими каналами і додає кнопки
const REPORT_CHANNELS = {
  '': 'adrenaline', // замінити на реальні ID каналів
};

// Ролі які можуть схвалювати/відхиляти
const APPROVER_ROLES = [
  '1328668577082904630', // Головний лікар
  '1041467317353193472', // Заступник головного лікаря
];

// Saturday reminder time (Kyiv UTC+3) — 18:00
const REMINDER_HOUR_KYIV = 18;
const REMINDER_DAY = 6; // Saturday

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// ── READY ─────────────────────────────────────────────────────────────
client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot ready: ${client.user.tag}`);
  
  // Start reminder scheduler
  scheduleReminders();
  
  // Read audit channel on start
  await syncAuditChannel();
});

// ── ADD APPROVE BUTTONS TO REPORTS ────────────────────────────────────
client.on(Events.MessageCreate, async (message) => {
  if (!message.author.bot) return;
  if (!message.webhookId) return;
  
  // Check if message is in a report channel and has embeds
  if (!message.embeds.length) return;
  
  const embed = message.embeds[0];
  if (!embed.title) return;
  
  // Only add buttons to report types that need approval
  const needsApproval = [
    '📈 Запит на підвищення',
    '🌴 🟡 Відгул',
    '🌴 🌴 Відпустка', 
    '🚪 Запит на звільнення',
    '⚠️ Дисциплінарне стягнення',
    '✅ Зняття догани',
    '🏆 Запит на преміювання',
  ];
  
  const matches = needsApproval.some(t => embed.title.includes(t.replace(/^[^\w]*/, '').split(' ')[0]));
  if (!matches) return;
  
  // Add approve/reject buttons
  const approve = new ButtonBuilder()
    .setCustomId('approve')
    .setLabel('✅ Схвалено')
    .setStyle(ButtonStyle.Success);
    
  const reject = new ButtonBuilder()
    .setCustomId('reject')
    .setLabel('❌ Відхилено')
    .setStyle(ButtonStyle.Danger);
    
  const pending = new ButtonBuilder()
    .setCustomId('pending')
    .setLabel('⏳ На розгляді')
    .setStyle(ButtonStyle.Secondary);
    
  const row = new ActionRowBuilder().addComponents(pending, approve, reject);
  
  try {
    await message.edit({ components: [row] });
  } catch(e) {
    // If can't edit webhook message, send reply with buttons
    await message.reply({ components: [row], content: '**Статус запиту:**' });
  }
});

// ── BUTTON INTERACTIONS ────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  
  // Check if user has approver role
  const member = interaction.member;
  const hasRole = member.roles.cache.some(r => APPROVER_ROLES.includes(r.id));
  
  if (!hasRole) {
    await interaction.reply({ 
      content: '❌ У вас немає прав для схвалення/відхилення запитів.', 
      ephemeral: true 
    });
    return;
  }
  
  const action = interaction.customId;
  const user = interaction.user;
  const now = new Date().toLocaleString('uk-UA', { 
    day:'2-digit', month:'2-digit', year:'numeric',
    hour:'2-digit', minute:'2-digit',
    timeZone: 'Europe/Kyiv'
  });
  
  let statusText, statusColor, emoji;
  if (action === 'approve') {
    statusText = 'Схвалено';
    statusColor = 0x57f287;
    emoji = '✅';
  } else if (action === 'reject') {
    statusText = 'Відхилено';
    statusColor = 0xed4245;
    emoji = '❌';
  } else {
    statusText = 'На розгляді';
    statusColor = 0x99aab5;
    emoji = '⏳';
  }
  
  // Update buttons — disable approved/rejected
  const approve = new ButtonBuilder()
    .setCustomId('approve')
    .setLabel('✅ Схвалено')
    .setStyle(ButtonStyle.Success)
    .setDisabled(action !== 'approve' ? true : false);
    
  const reject = new ButtonBuilder()
    .setCustomId('reject')
    .setLabel('❌ Відхилено')
    .setStyle(ButtonStyle.Danger)
    .setDisabled(action !== 'reject' ? true : false);
    
  const statusBtn = new ButtonBuilder()
    .setCustomId('status')
    .setLabel(`${emoji} ${statusText} — ${user.username} · ${now}`)
    .setStyle(action === 'approve' ? ButtonStyle.Success : action === 'reject' ? ButtonStyle.Danger : ButtonStyle.Secondary)
    .setDisabled(true);
  
  const row = new ActionRowBuilder().addComponents(statusBtn, approve, reject);
  
  await interaction.update({ components: [row] });
  
  // Send DM to the reporter if possible
  try {
    // Try to find the reporter from embed description
    const embed = interaction.message.embeds[0];
    if (embed && action !== 'pending') {
      await interaction.followUp({
        content: `${emoji} **${statusText}** · Запит розглянуто: **${interaction.user.displayName}**`,
        ephemeral: false,
      });
    }
  } catch(e) {}
});

// ── SATURDAY REMINDER ─────────────────────────────────────────────────
function scheduleReminders() {
  // Check every minute
  setInterval(async () => {
    const now = new Date();
    // Convert to Kyiv time (UTC+3)
    const kyivHour = (now.getUTCHours() + 3) % 24;
    const kyivDay = new Date(now.getTime() + 3 * 3600000).getUTCDay();
    const kyivMin = now.getUTCMinutes();
    
    // Saturday 18:00 Kyiv — send reminder
    if (kyivDay === REMINDER_DAY && kyivHour === REMINDER_HOUR_KYIV && kyivMin === 0) {
      await sendSaturdayReminder();
    }
  }, 60000);
}

async function sendSaturdayReminder() {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const members = await guild.members.fetch();
    
    // Get all members with EMS roles (not bots)
    const emsMemberRoles = [...APPROVER_ROLES]; // Add all EMS roles here
    
    const embed = new EmbedBuilder()
      .setTitle('⏰ Нагадування про звіт на преміювання!')
      .setColor(0xfee75c)
      .setDescription([
        '**Сьогодні субота** — не забудь здати звіт на преміювання!',
        '',
        '⏳ Дедлайн: **20:00 за Київським часом**',
        '📋 Форма: **ems-reports.pages.dev**',
        '',
        '🚫 Якщо не здаси до 20:00 — премія анулюється',
      ].join('\n'))
      .setFooter({ text: 'EMS — Система Звітності' })
      .setTimestamp();
    
    // Send to members with EMS roles
    let sent = 0;
    for (const [, member] of members) {
      if (member.user.bot) continue;
      const hasEmsRole = member.roles.cache.some(r => emsMemberRoles.includes(r.id));
      if (!hasEmsRole) continue;
      try {
        await member.send({ embeds: [embed] });
        sent++;
        // Rate limit protection
        await new Promise(r => setTimeout(r, 500));
      } catch(e) {
        // DM disabled — skip
      }
    }
    console.log(`Saturday reminder sent to ${sent} members`);
  } catch(e) {
    console.error('Reminder error:', e);
  }
}

// ── AUDIT CHANNEL SYNC ────────────────────────────────────────────────
async function syncAuditChannel() {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.fetch(AUDIT_CHANNEL_ID);
    if (!channel) return;
    
    console.log(`📋 Audit channel: ${channel.name}`);
    // Fetch last 100 messages
    const messages = await channel.messages.fetch({ limit: 100 });
    console.log(`Found ${messages.size} messages in audit channel`);
    
    // Parse staff from messages — format depends on your audit channel structure
    // You can customize this parser based on how your audit channel is formatted
    const staff = [];
    messages.forEach(msg => {
      // Simple parser — adjust regex to match your audit format
      const match = msg.content.match(/([A-Za-zА-ЯҐЄІЇа-яґєії\s]+)\s*[|·]\s*#?(\d+)/);
      if (match) {
        staff.push({
          name: match[1].trim(),
          static: match[2].trim(),
        });
      }
    });
    
    if (staff.length) {
      console.log(`Parsed ${staff.length} staff from audit channel`);
    }
  } catch(e) {
    console.error('Audit sync error:', e);
  }
}

// ── LOGIN ──────────────────────────────────────────────────────────────
client.login(TOKEN);
