require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder,
  SlashCommandBuilder, ComponentType, MessageFlags, PermissionsBitField, escapeMarkdown,
} = require('discord.js');

// ==== CONFIG ====
const KARUTA_ID = '646937666251915264'; // verify: Developer Mode > right-click Karuta > Copy User ID
const KARIBBIT_ID = '1274445226064220273';

const { DropTracker, badgeLabels } = require('./drop-tracker');
const { createCombat } = require('./battle-discord');
const STEAL_AFTER_SECONDS = Number(process.env.STEAL_AFTER_SECONDS ?? 60);
if (!Number.isInteger(STEAL_AFTER_SECONDS) || STEAL_AFTER_SECONDS < 5 || STEAL_AFTER_SECONDS > 3600) {
  throw new Error('STEAL_AFTER_SECONDS must be a whole number between 5 and 3600.');
}
const CHANNEL_IDS = new Set((process.env.CHANNEL_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean));
const PAGE_SIZE = 10;
const DEBUG = process.env.DEBUG === '1'; // DEBUG=1 in .env prints raw Karibbit messages
const DATA_FILE = path.join(__dirname, 'data.json');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged: enable it in the Developer Portal
    GatewayIntentBits.GuildMessageReactions,
  ],
  allowedMentions: { parse: [] },
});

// ==== HELPERS START ====
const QUALITIES = ['Burned', 'Damaged', 'Poor', 'Good', 'Excellent', 'Mint']; // worst -> best

// Retain the old sort key for compatibility. Wishlists measure popularity;
// print/edition badges are displayed separately, without inventing a value rank.
const rarity = (c) => c.wishlists;
const qRank = (c) => QUALITIES.indexOf(c.condition); // -1 = Unknown

const SORTS = {
  rarity:     { label: 'Wishlists',   cmp: (a, b) => rarity(b) - rarity(a) || b.last - a.last },
  condition:  { label: 'Condition',   cmp: (a, b) => qRank(b) - qRank(a) || rarity(b) - rarity(a) },
  duplicates: { label: 'Duplicates',  cmp: (a, b) => b.count - a.count || b.last - a.last },
  date:       { label: 'Date stolen', cmp: (a, b) => b.last - a.last },
};


// "1y-20d-10h-2m-4s" (leading zero units are dropped)
function fmtUptime(ms) {
  let s = Math.floor(ms / 1000);
  const y = Math.floor(s / 31_536_000); s %= 31_536_000;
  const d = Math.floor(s / 86_400); s %= 86_400;
  const h = Math.floor(s / 3_600); s %= 3_600;
  const m = Math.floor(s / 60); s %= 60;
  const parts = [[y, 'y'], [d, 'd'], [h, 'h'], [m, 'm'], [s, 's']];
  const first = parts.findIndex(([v]) => v > 0);
  const used = first === -1 ? parts.slice(-1) : parts.slice(first);
  return used.map(([v, u]) => `${v}${u}`).join('-');
}

// Merge stolen events into unique cards (name + series) with duplicate counts.
function aggregate(events) {
  const map = new Map();
  for (const e of events) {
    if (e.unknown) continue;
    const key = `${e.name}\u0000${e.series}`.toLowerCase();
    const c = map.get(key) ?? {
      name: e.name, series: e.series, wishlists: 0, condition: 'Unknown', metadata: [], count: 0, first: e.at, last: e.at,
    };
    c.count++;
    c.wishlists = e.wishlists; // latest value
    c.metadata = [...new Set([...c.metadata, ...(Array.isArray(e.metadata) ? e.metadata : [])])];
    c.first = Math.min(c.first, e.at);
    c.last = Math.max(c.last, e.at);
    if (QUALITIES.indexOf(e.condition) > QUALITIES.indexOf(c.condition)) c.condition = e.condition;
    map.set(key, c);
  }
  return [...map.values()];
}
// ==== HELPERS END ====

const esc = (t) => escapeMarkdown(String(t ?? ''));
const badgesText = (card, limit) => esc(badgeLabels(card.metadata).join(' · ')).slice(0, limit);

// ==== STORAGE + UPTIME ====
function loadData() {
  const fresh = { schemaVersion: 2, startedAt: Date.now(), uptimeMs: 0, stolen: [] };
  try {
    const stored = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!stored || !Array.isArray(stored.stolen)) throw new Error('Invalid data.json: stolen must be an array.');
    if (stored.schemaVersion !== 2) {
      // The old bot counted entire drops, including unknown/claimed cards.
      // Preserve that history but do not mix it into the new collection.
      return { ...fresh, legacyData: stored };
    }
    if (!Number.isFinite(stored.startedAt) || !Number.isFinite(stored.uptimeMs)) {
      throw new Error('Invalid data.json: invalid uptime metadata.');
    }
    return { ...fresh, ...stored };
  } catch (error) {
    if (error.code === 'ENOENT') return fresh;
    throw error; // Never silently overwrite unreadable or corrupt history.
  }
}
const data = loadData();

function save() {
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, DATA_FILE);
}

const combat = createCombat({ data, save });

let lastTick = Date.now();
function tick() {
  const now = Date.now();
  const dt = now - lastTick;
  if (dt < 120_000) data.uptimeMs += dt; // ignore big gaps (e.g. laptop asleep)
  lastTick = now;
}
setInterval(() => { combat.engine.expire(); tick(); save(); void flushRealmNotices(); }, 30_000);

function shutdown() { tick(); save(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ==== DROP TRACKING ====
let sendingRealmNotices = false;
async function flushRealmNotices() {
  if (sendingRealmNotices || !client.isReady?.()) return;
  sendingRealmNotices = true;
  try {
    for (const notice of [...combat.engine.state.notices].slice(0, 25)) {
      try {
        const channel = await client.channels.fetch(notice.channelId);
        const title = notice.type === 'legend' ? 'A new Realm Legend has taken the stage!' :
          notice.cards.length > 1 ? 'New strongest cards have entered the realm!' : 'A new strongest card has entered the realm!';
        const lines = notice.cards.slice(0, 8).map((c) => `**${esc(c.name.slice(0, 100))}** · \`${c.id}\`\nHP ${c.health} · ATK ${c.attack} · DEF ${c.defense} · Power ${c.power}`);
        const embed = new EmbedBuilder().setColor(notice.type === 'legend' ? 0xf0b949 : 0xb26bf5).setTitle(title)
          .setDescription(lines.join('\n\n') + (notice.cards.length > 8 ? `\n…and ${notice.cards.length - 8} equally strong arrivals.` : '') + '\n\nDare to face them with `/challenge`.')
          .setFooter({ text: 'Arrival stats · combat power = HP + ATK + DEF' });
        await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
        const index = combat.engine.state.notices.findIndex((n) => n.id === notice.id);
        if (index >= 0) combat.engine.state.notices.splice(index, 1);
        save();
      } catch (error) {
        console.error(`Realm announcement ${notice.id} failed; will retry:`, error.message);
      }
    }
  } finally { sendingRealmNotices = false; }
}

const requiredPermissions = [
  PermissionsBitField.Flags.ViewChannel,
  PermissionsBitField.Flags.ReadMessageHistory,
  PermissionsBitField.Flags.ManageMessages,
];

function observe(message) {
  if (!message.guildId || (CHANNEL_IDS.size && !CHANNEL_IDS.has(message.channelId))) return;
  if (message.author?.id === KARIBBIT_ID) {
    if (DEBUG) console.log('Karibbit:', message.content, JSON.stringify(message.embeds));
    tracker.observeInfo(message);
    const drop = tracker.drops.get(message.reference?.messageId);
    if (DEBUG) {
      console.log(`[Karutake] Karibbit reply=${message.id} reference=${message.reference?.messageId ?? 'none'} tracked=${Boolean(drop)} cards=${drop?.cards.length ?? 0}/${drop?.expected ?? 0}`);
    }
    if (drop && drop.channelId === message.channelId && drop.guildId === message.guildId) {
      drop.karibbitMessageIds ??= new Set();
      drop.karibbitMessageIds.add(message.id);
    }
  } else if (message.author?.id === KARUTA_ID) {
    tracker.observeClaim(message);
  }
}

// Read back through the drop's lifetime before deleting it, then again after
// the grace period. Fail closed if the bounded history scan cannot cover it.
async function verifyDrop(drop, { deleted = false } = {}) {
  if (DEBUG) console.log(`[Karutake] Checking drop=${drop.id} afterDeletion=${deleted} at=${new Date().toISOString()}`);
  const channel = await client.channels.fetch(drop.channelId);
  if (!channel?.isTextBased() || !channel.messages) throw new Error('Channel is unavailable.');
  const permissions = channel.permissionsFor(client.user);
  const sendPermission = channel.isThread()
    ? PermissionsBitField.Flags.SendMessagesInThreads : PermissionsBitField.Flags.SendMessages;
  if (!permissions?.has([...requiredPermissions, sendPermission])) {
    throw new Error('Missing channel permissions (view, history, manage messages, or send).');
  }
  if (!deleted) {
    const original = await channel.messages.fetch({ message: drop.id, force: true });
    if (original.author.id !== KARUTA_ID || !/\bis dropping\s+\d+\s+cards?\b/i.test(original.content)) {
      throw new Error('Original message is no longer a recognized Karuta drop.');
    }
  }
  let before;
  for (let page = 0; page < 20; page++) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}), cache: false });
    const messages = [...batch.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
    for (const message of messages) {
      if (BigInt(message.id) > BigInt(drop.id)) observe(message);
    }
    if (messages.length < 100 || BigInt(messages[0].id) <= BigInt(drop.id)) return;
    before = messages[0].id;
  }
  throw new Error('Channel too busy to verify all claims; skipping collection.');
}

const tracker = new DropTracker({
  waitMs: STEAL_AFTER_SECONDS * 1000,
  verify: verifyDrop,
  remove: async (drop) => {
    const channel = await client.channels.fetch(drop.channelId);
    await channel.messages.delete(drop.id);
  },
  record: (drop, cards) => {
    const base = { at: Date.now(), guildId: drop.guildId, channelId: drop.channelId,
      dropperId: drop.dropperId, dropId: drop.id };
    const arrivals = cards.map((card) => ({ ...base, ...card }));
    data.stolen.push(...arrivals);
    combat.engine.syncCards();
    combat.engine.queueArrivalNotices(drop, arrivals);
    save();
  },
  announce: async (drop, cards) => {
    const channel = await client.channels.fetch(drop.channelId);
    let content = 'Karutake stole ';
    for (const card of cards) {
      const name = `**${esc(card.name)}**`;
      if (name.length > 1900) throw new Error('Card name exceeds Discord message limits.');
      const separator = content === 'Karutake stole ' ? '' : ', ';
      if (content.length + separator.length + name.length > 2000) {
        await channel.send({ content, allowedMentions: { parse: [] } });
        content = 'Karutake stole ' + name;
      } else content += separator + name;
    }
    await channel.send({ content, allowedMentions: { parse: [] } });
    await flushRealmNotices();
    // Keep metadata available through both claim checks and the announcement.
    for (const id of drop.karibbitMessageIds ?? []) {
      await channel.messages.delete(id).catch((error) => {
        if (error.code !== 10008) {
          console.error(`Could not delete Karibbit reply ${id}:`, error.message);
        }
      });
    }
  },
});

// ==== VIEWS ====
const FIRST = '⏪', PREV = '◀️', NEXT = '▶️', LAST = '⏩', BACK = '↩️';
const norm = (s) => (s ?? '').replace(/\uFE0F/g, '');
const NAV = new Set([FIRST, PREV, NEXT, LAST, BACK].map(norm));
const REACTS = { list: [FIRST, PREV, NEXT, LAST], card: [PREV, NEXT, BACK] };

function listView(s) {
  const pages = Math.ceil(s.cards.length / PAGE_SIZE);
  const start = s.page * PAGE_SIZE;
  const slice = s.cards.slice(start, start + PAGE_SIZE);

  const lines = slice.map((c, k) =>
    `\`${String(start + k + 1).padStart(2, '0')}\` **${esc(c.name)}** · ${esc(c.series)}\n` +
    `┗ ♡ ${c.wishlists}` +
    (c.condition && c.condition !== 'Unknown' ? ` · ${c.condition}` : '') +
    ` · ×${c.count} · <t:${Math.floor(c.last / 1000)}:R>` +
    (c.metadata?.length ? `\n┗ Badges seen: ${badgesText(c, 150)}` : ''));

  const embed = new EmbedBuilder()
    .setTitle('Karutake’s stolen cards')
    .setDescription(lines.join('\n'))
    .setColor(0x9b59b6)
    .setFooter({ text: `Page ${s.page + 1}/${pages} · ${s.cards.length} cards · Sorted by ${SORTS[s.sort].label}` });

  const menu = new StringSelectMenuBuilder()
    .setCustomId('view-card')
    .setPlaceholder('View a card on this page…')
    .addOptions(slice.map((c, k) => ({
      label: `${start + k + 1}. ${c.name}`.slice(0, 100),
      description: (c.series || '—').slice(0, 100),
      value: String(start + k),
    })));

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] };
}

function cardView(s) {
  const c = s.cards[s.index];
  const ts = (ms, f) => `<t:${Math.floor(ms / 1000)}:${f}>`;
  const embed = new EmbedBuilder()
    .setTitle(c.name)
    .setDescription(`*${esc(c.series || '—')}*`)
    .setColor(0x9b59b6)
    .addFields(
      { name: 'Wishlists', value: `♡ ${c.wishlists}`, inline: true },
      { name: 'Condition', value: c.condition, inline: true },
      { name: 'Times stolen', value: `×${c.count}`, inline: true },
      { name: 'First stolen', value: ts(c.first, 'f'), inline: true },
      { name: 'Last stolen', value: ts(c.last, 'f'), inline: true },
    )
    .setFooter({ text: `Card ${s.index + 1}/${s.cards.length} · ${SORTS[s.sort].label} · ${BACK} to go back` });
  if (c.metadata?.length) embed.addFields({ name: 'Badges seen across collected copies', value: badgesText(c, 1024) || '—' });
  return { embeds: [embed], components: [] };
}

const render = (s) => (s.mode === 'list' ? listView(s) : cardView(s));

async function setReactions(msg, list) {
  await msg.reactions.removeAll().catch(() => {});
  for (const e of list) await msg.react(e).catch(() => {});
}

// ==== COMMANDS ====
const commands = [
  new SlashCommandBuilder()
    .setName('get')
    .setDescription('Browse theft history; use /realm for unclaimed copies and /collection for owned cards')
    .addStringOption((o) => o
      .setName('sort-mode')
      .setDescription('How to sort (default: date)')
      .addChoices(
        { name: 'Wishlists', value: 'rarity' },
        { name: 'Condition', value: 'condition' },
        { name: 'Duplicates', value: 'duplicates' },
        { name: 'Date stolen', value: 'date' },
      )),
  new SlashCommandBuilder().setName('stats').setDescription('Show theft stats'),
].map((c) => c.toJSON()).concat(combat.commands);

async function handleGet(i) {
  const sort = i.options.getString('sort-mode') ?? 'date';
  const cards = aggregate(data.stolen.filter((e) => e.guildId === i.guildId)).sort(SORTS[sort].cmp);
  if (!cards.length) {
    return i.reply({ content: 'Nothing stolen yet.', flags: MessageFlags.Ephemeral });
  }

  const s = { cards, sort, mode: 'list', page: 0, index: 0 };
  await i.reply(render(s));
  const msg = await i.fetchReply();

  const isOwner = (u) => u.id === i.user.id;
  const rc = msg.createReactionCollector({
    filter: (r, u) => !u.bot && isOwner(u) && NAV.has(norm(r.emoji.name)),
    time: 10 * 60_000,
  });
  const sc = msg.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    filter: (x) => {
      if (isOwner(x.user)) return true;
      x.reply({ content: 'Run /get yourself to browse.', flags: MessageFlags.Ephemeral }).catch(() => {});
      return false;
    },
    time: 10 * 60_000,
  });

  // run reaction work one at a time
  let chain = Promise.resolve();
  const run = (fn) => { chain = chain.then(fn).catch(console.error); };

  async function onNav(e) {
    const n = s.cards.length;
    const pages = Math.ceil(n / PAGE_SIZE);
    if (s.mode === 'list') {
      if (e === norm(FIRST)) s.page = 0;
      else if (e === norm(PREV)) s.page = Math.max(0, s.page - 1);
      else if (e === norm(NEXT)) s.page = Math.min(pages - 1, s.page + 1);
      else if (e === norm(LAST)) s.page = pages - 1;
      else return;
      await i.editReply(render(s));
    } else {
      if (e === norm(PREV)) s.index = (s.index - 1 + n) % n;
      else if (e === norm(NEXT)) s.index = (s.index + 1) % n;
      else if (e === norm(BACK)) { s.mode = 'list'; s.page = Math.floor(s.index / PAGE_SIZE); }
      else return;
      await i.editReply(render(s));
      if (s.mode === 'list') await setReactions(msg, REACTS.list);
    }
  }

  rc.on('collect', (reaction, user) => {
    reaction.users.remove(user.id).catch(() => {});
    run(() => onNav(norm(reaction.emoji.name)));
  });

  sc.on('collect', async (x) => {
    s.mode = 'card';
    s.index = Number(x.values[0]);
    await x.update(render(s)).catch(console.error);
    run(() => setReactions(msg, REACTS.card));
  });

  rc.on('end', () => {
    sc.stop();
    i.editReply({ components: [] }).catch(() => {});
    msg.reactions.removeAll().catch(() => {});
  });

  run(() => setReactions(msg, REACTS.list));
}

async function handleStats(i) {
  tick();
  const now = Date.now();
  const events = data.stolen.filter((e) => e.guildId === i.guildId);
  const known = events.filter((e) => !e.unknown);
  const best = known.reduce((b, c) => (!b || rarity(c) > rarity(b) ? c : b), null);
  const days = Math.max((now - data.startedAt) / 86_400_000, 1);
  const last24 = events.filter((e) => now - e.at < 86_400_000).length;

  const total = events.length === known.length
    ? String(events.length)
    : `${events.length} (${known.length} identified)`;

  const embed = new EmbedBuilder()
    .setTitle('Karutake stats')
    .setColor(0x9b59b6)
    .addFields(
      { name: 'Cards stolen', value: total, inline: true },
      { name: 'Total uptime', value: fmtUptime(data.uptimeMs), inline: true },
      { name: 'Cards stolen per day', value: `${(events.length / days).toFixed(2)} (last 24h: ${last24})`, inline: true },
      {
        name: 'Most wishlisted card stolen',
        value: best ? `**${esc(best.name)}** · ${esc(best.series)}\n♡ ${best.wishlists}` : '—',
      },
    );
  return i.reply({ embeds: [embed] });
}

// ==== EVENTS ====
async function registerCommands(guild) {
  await guild.commands.set(commands).catch((err) =>
    console.error(`Command registration failed in ${guild.name}:`, err.message));
}

client.once('ready', async () => {
  console.log(`Online as ${client.user.tag}`);
  console.log(`[Karutake] Started at=${new Date().toISOString()} pid=${process.pid} wait=${STEAL_AFTER_SECONDS}s channels=${[...CHANNEL_IDS].join(',') || 'all visible'} debug=${DEBUG}`);
  for (const g of client.guilds.cache.values()) await registerCommands(g);
  await flushRealmNotices();
});
client.on('guildCreate', registerCommands);

client.on('interactionCreate', async (i) => {
  if (await combat.handle(i)) return;
  if (!i.isChatInputCommand() || !i.inGuild()) return;
  try {
    if (i.commandName === 'get') await handleGet(i);
    else if (i.commandName === 'stats') await handleStats(i);
  } catch (err) {
    console.error(err);
  }
});

client.on('messageCreate', (message) => {
  if (DEBUG && message.author?.bot) {
    console.log(`[Karutake] Bot message=${message.id} author=${message.author.id} channel=${message.channelId} contentLength=${message.content?.length ?? 0}`);
  }
  if (DEBUG && message.guildId && CHANNEL_IDS.size && !CHANNEL_IDS.has(message.channelId) &&
      [KARUTA_ID, KARIBBIT_ID].includes(message.author?.id)) {
    console.log(`[Karutake] Ignored message=${message.id}: channel ${message.channelId} is not in CHANNEL_IDS`);
  }
  if (!message.guildId || (CHANNEL_IDS.size && !CHANNEL_IDS.has(message.channelId))) return;
  if (message.author.id === KARUTA_ID) {
    const drop = tracker.track(message);
    if (DEBUG) {
      console.log(`[Karutake] Karuta message=${message.id} recognizedDrop=${/\bis dropping\s+\d+\s+cards?\b/i.test(message.content ?? '')} ageMs=${Date.now() - message.createdTimestamp} tracked=${Boolean(drop)} pending=${tracker.drops.size}`);
      if (drop) console.log(`[Karutake] Scheduled drop=${drop.id} due=${new Date(drop.createdAt + STEAL_AFTER_SECONDS * 1000).toISOString()}`);
    }
  }
  observe(message);
});

client.on('messageUpdate', (_old, message) => {
  // Karibbit can add its embed by editing its reply. Do not start timers on
  // edited old drops; only drops seen live from their creation are eligible.
  if (!message.partial) observe(message);
});

client.on('messageDelete', (message) => {
  const drop = tracker.drops.get(message.id);
  if (drop && !['deleting', 'settling'].includes(drop.state)) tracker.cancel(message.id);
});
client.on('messageDeleteBulk', (messages) => {
  for (const id of messages.keys()) tracker.cancel(id);
});
for (const event of ['shardDisconnect', 'shardReconnecting', 'invalidated']) {
  client.on(event, () => tracker.cancelAll('Discord connection interrupted; claims may have been missed'));
}
client.on('error', console.error);

if (!process.env.DISCORD_TOKEN) throw new Error('Set DISCORD_TOKEN in .env before starting Karutake.');
client.login(process.env.DISCORD_TOKEN).catch((error) => {
  console.error('Discord login failed:', error.message);
  process.exit(1);
});
