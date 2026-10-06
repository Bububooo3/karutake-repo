'use strict';

const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, MessageFlags, escapeMarkdown } = require('discord.js');
const { BattleEngine, cardStats } = require('./battle-engine');
const { badgeLabels } = require('./drop-tracker');
const esc = (s) => escapeMarkdown(String(s ?? ''));
const short = (s, n = 80) => String(s ?? '').slice(0, n);
const row = (...components) => new ActionRowBuilder().addComponents(...components);
const button = (id, text, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(text).setStyle(style);
const userInfo = (u) => ({ id: u.id, name: u.globalName || u.username, bot: u.bot });
const option = (o, name, description, required = false) => o.setName(name).setDescription(description).setRequired(required);

const builders = [
  new SlashCommandBuilder().setName('challenge').setDescription('Enter the Forgotten Realm or challenge a server member')
    .addStringOption((o) => option(o, 'characters', 'One to four names or card IDs, separated by commas; omit for one random enemy'))
    .addUserOption((o) => option(o, 'opponent', 'A server member to duel instead of realm characters'))
    .addStringOption((o) => option(o, 'stake', 'For a duel: the card ID/name you wager; omit for a friendly duel')),
  new SlashCommandBuilder().setName('duel').setDescription('Invite a server member to a friendly or wagered duel')
    .addUserOption((o) => option(o, 'opponent', 'The member to challenge', true))
    .addStringOption((o) => option(o, 'stake', 'Your card ID/name to wager; omit for a friendly duel')),
  new SlashCommandBuilder().setName('accept').setDescription('Accept a duel, offer your wager, or confirm the agreed stakes')
    .addStringOption((o) => option(o, 'card', 'Your owned card ID/name when responding to a wagered duel')),
  new SlashCommandBuilder().setName('battle').setDescription('Resume your active battle or view your most recent result'),
  new SlashCommandBuilder().setName('equip').setDescription('Equip one owned card; at most five copies can be equipped')
    .addStringOption((o) => option(o, 'card', 'Owned card ID or exact character name', true)),
  new SlashCommandBuilder().setName('unequip').setDescription('Unequip a card, or omit the card to unequip everything')
    .addStringOption((o) => option(o, 'card', 'Equipped card ID or exact name; omit to clear your team')),
  new SlashCommandBuilder().setName('collection').setDescription('Browse a personal collection and equipped team')
    .addUserOption((o) => option(o, 'user', 'Whose collection to view; defaults to you'))
    .addIntegerOption((o) => option(o, 'page', 'Page number').setMinValue(1)),
  new SlashCommandBuilder().setName('realm').setDescription('Browse the banished characters available to challenge')
    .addIntegerOption((o) => option(o, 'page', 'Page number').setMinValue(1)),
  new SlashCommandBuilder().setName('card').setDescription('Inspect a specific copy, combat stats, ownership, and badges')
    .addStringOption((o) => option(o, 'card', 'Card ID from /realm or /collection', true)),
  new SlashCommandBuilder().setName('battle-help').setDescription('Combat rules, rewards, wagers, and the stat formula'),
];

function createCombat({ data, save }) {
  const engine = new BattleEngine(data, save);
  const names = new Set(builders.map((c) => c.name));
  const cid = (m, action) => `battle:${m.id}:${m.revision}:${action}`;
  const updates = new Map();
  async function inOrder(id, work) {
    const previous = updates.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    updates.set(id, current);
    try { return await current; }
    finally { if (updates.get(id) === current) updates.delete(id); }
  }

  function panel(m) {
    const embed = new EmbedBuilder().setColor(m.status === 'ended' ? 0x607d8b : 0x7252ad)
      .setTitle(m.mode === 'realm' ? 'The Forgotten Realm' : 'Duel at the Realm’s Gate');
    const components = [];
    if (m.status === 'invite') {
      const cardName = (id) => {
        const c = data.stolen.find((c) => c.id === id);
        return c ? `**${esc(short(c.name))}** (${c.id})` : 'not selected';
      };
      embed.setDescription(`**${esc(short(m.names[0]))}** challenges **${esc(short(m.names[1]))}**.\n\n` +
        (m.stakes[0] ? `**Wagered duel — the loser gives up the agreed card.**\n${esc(short(m.names[0]))}: ${cardName(m.stakes[0])}\n${esc(short(m.names[1]))}: ${cardName(m.stakes[1])}\n\n` +
          (m.stakes[1] ? 'The challenger must confirm these exact stakes to begin.' : 'The challenged player can offer a card below, or use `/accept card:ID`. Selecting a card accepts the wager if the challenger confirms.\nUse `/collection` to see all your copies.')
          : '**Friendly duel:** no cards will change owners. The challenged player must accept.') +
        `\n\nInvitation expires <t:${Math.floor(m.expiresAt / 1000)}:R>.`);
      if (m.stakes[0] && !m.stakes[1]) {
        const available = engine.cards(m.guildId, m.users[1]).filter((c) => !engine.reserved(c.id)).slice(0, 25);
        if (available.length) components.push(row(new StringSelectMenuBuilder().setCustomId(cid(m, 'stake'))
          .setPlaceholder('Opponent: offer this card and accept the wager')
          .addOptions(available.map((c) => ({ label: short(`${c.name} · ${c.id}`, 100), value: c.id })))));
        else embed.addFields({ name: 'No card available to wager', value: 'Decline this invitation, or ask for a friendly duel with no stake.' });
      } else components.push(row(button(cid(m, 'accept'), m.stakes[0] ? 'Confirm wagers and begin' : 'Accept duel', ButtonStyle.Success)));
      components.push(row(button(cid(m, 'concede'), 'Decline / cancel', ButtonStyle.Danger)));
    } else {
      const teamText = (team) => team.map((f) => `${f.hp ? (f.guarding ? '🛡️' : '⚔️') : '☠️'} **${esc(short(f.name, 55))}**${f.legend ? ' ★ Legend' : ''}\nHP ${f.hp}/${f.health} · ATK ${f.attack} · DEF ${f.defense}`).join('\n');
      embed.addFields(
        { name: short(m.names[0], 100), value: teamText(m.teams[0]), inline: true },
        { name: short(m.names[1] ?? 'The banished', 100), value: teamText(m.teams[1]), inline: true },
      );
      const logs = m.log.slice(-4).map((line) => esc(short(line, 300))).join('\n');
      if (m.status === 'battle') {
        const picks = engine.selections(m);
        embed.setDescription(`**${esc(short(m.names[m.turn]))}’s turn.** Choose one fighter and one target, then Attack or Guard.\n` +
          `Action ${m.actions + 1}/100 · turn expires <t:${Math.floor(m.expiresAt / 1000)}:R>.\n\n${logs}`);
        for (const [field, side, placeholder] of [['actor', m.turn, 'Choose your fighter'], ['target', 1 - m.turn, 'Choose an enemy target']]) {
          const selected = field === 'actor' ? picks.actor.id : picks.target.id;
          components.push(row(new StringSelectMenuBuilder().setCustomId(cid(m, field)).setPlaceholder(placeholder)
            .addOptions(engine.alive(m, side).map((c) => ({ label: short(`${c.name} · HP ${c.hp}/${c.health}`, 100), value: c.id, default: c.id === selected })))));
        }
        components.push(row(button(cid(m, 'attack'), 'Attack', ButtonStyle.Primary), button(cid(m, 'guard'), 'Guard'),
          button(cid(m, 'concede'), m.mode === 'duel' && m.stakes[0] ? 'Surrender (lose wager)' : 'Surrender', ButtonStyle.Danger)));
      } else if (m.status === 'reward') {
        embed.setDescription(`**Victory!** The defeated characters become cards. Choose **1–${m.quota}** to keep.\n` +
          `The others return to the realm. Choose before <t:${Math.floor(m.expiresAt / 1000)}:R>.\n\n${logs}`);
        components.push(row(new StringSelectMenuBuilder().setCustomId(cid(m, 'collect')).setPlaceholder(`Collect up to ${m.quota} cards`)
          .setMinValues(1).setMaxValues(m.quota).addOptions(m.teams[1].map((c) => ({ label: short(`${c.name} · ${c.id}`, 100), value: c.id })))));
        components.push(row(button(cid(m, 'concede'), 'Leave without collecting')));
      } else embed.setDescription(`**${esc(m.result)}**\n\n${logs}\n\nHealth and battle effects reset for the next match.`);
    }
    embed.setFooter({ text: `Battle ${m.id} · /battle resumes this encounter · one action per side each turn` });
    return { embeds: [embed], components, allowedMentions: { parse: [] } };
  }

  function book(guildId, user, page) {
    const cards = engine.cards(guildId, user?.id ?? null);
    const pages = Math.max(1, Math.ceil(cards.length / 8));
    page = Math.min(page || 1, pages);
    const equipped = user ? engine.player(guildId, user.id).equipped : [];
    const description = user ? (equipped.length ? `Equipped: ${equipped.map((id) => `\`${id}\``).join(', ')}` :
      'Your self-card is equipped until you equip a collected card. Self: HP 105 · ATK 22 · DEF 8.') :
      'Forgotten by their worlds, these banished characters await a challenger. Defeat them to restore their card form.\nUse `/challenge characters:name, name` or supply their IDs.';
    const embed = new EmbedBuilder().setColor(0x7252ad).setTitle(user ? `${short(user.name, 70)}’s collection` : 'The Forgotten Realm')
      .setDescription(description).setFooter({ text: `Page ${page}/${pages} · ${cards.length} copies · use the page option to browse` });
    const slice = cards.slice((page - 1) * 8, page * 8);
    for (const c of slice) {
      const stats = cardStats(c, engine.now());
      const badges = badgeLabels(c.metadata).join(' · ');
      embed.addFields({ name: short(`${stats.legend ? '★ ' : ''}${equipped.includes(c.id) ? '✓ ' : ''}${c.name} · ${c.id}`, 180),
        value: `${esc(short(c.series, 150))}\nHP ${stats.health} · ATK ${stats.attack} · DEF ${stats.defense} · ♡ ${c.wishlists}` +
          (stats.legend ? '\n**Realm Legend** — a name whispered at the gate.' : '') +
          (badges ? `\n${esc(short(badges, 180))}` : '') + (engine.reserved(c.id) ? '\nReserved for a battle.' : '') });
    }
    if (!slice.length) embed.addFields({ name: 'No collected cards yet', value: user ? 'Use /challenge to enter the realm with your self-card.' : 'New unclaimed Karuta drops will arrive here after Karutake steals them.' });
    return { embeds: [embed], allowedMentions: { parse: [] } };
  }

  function inspect(guildId, query) {
    const card = engine.resolve(data.stolen.filter((c) => c.id && c.guildId === guildId), query);
    const s = cardStats(card, engine.now());
    const f = s.factors;
    return { embeds: [new EmbedBuilder().setColor(0x7252ad).setTitle(short(`${card.name} · ${card.id}`, 256))
      .setDescription(`${esc(short(card.series, 500))}\n${s.legend ? '**★ Realm Legend** — a name whispered at the gate.\n' : ''}${card.ownerId ? `Owner: <@${card.ownerId}>` : 'Unclaimed in the Forgotten Realm'}${engine.reserved(card.id) ? '\nReserved for a battle.' : ''}`)
      .addFields({ name: 'Fresh battle stats', value: `Health ${s.health} · Attack ${s.attack} · Defense ${s.defense}` },
        { name: 'Stat bonuses', value: `Print ${(f.print * 100).toFixed(1)}% · Wishlists ${(f.wishlist * 100).toFixed(1)}% · Condition ${(f.quality * 100).toFixed(1)}% · Age ${(f.age * 100).toFixed(1)}%` },
        { name: 'Badges', value: esc(short(badgeLabels(card.metadata).join(' · ') || 'None recorded', 500)) },
        { name: 'Recorded attributes', value: `Wishlists: ${card.wishlists} · Condition: ${esc(card.condition || 'Unknown')}\nBanished <t:${Math.floor(card.at / 1000)}:R>` })], allowedMentions: { parse: [] } };
  }

  const help = () => ({ embeds: [new EmbedBuilder().setColor(0x7252ad).setTitle('Laws of the Forgotten Realm')
    .setDescription('Unclaimed cards become banished characters. Enter the realm, defeat them, and restore them to your collection.\n\n' +
      '**Realm battles:** `/challenge` chooses one random available copy. Supply 1–4 exact names or IDs, separated by commas, to choose enemies. Win the whole battle, then choose up to half the enemies, rounded up. No win means no cards.\n\n' +
      '**Your team:** `/equip card:ID` adds a collected copy, up to five. `/unequip` clears the team; `/unequip card:ID` removes one. Your self-card fights alone when no cards are equipped.\n\n' +
      '**Turns:** choose one fighter and one target, then Attack or Guard. Guard halves the next incoming hit on that fighter. A side takes one action per turn. Damage is max(4, attack − 0.6 × defense), rounded; guarding halves it.\n\n' +
      '**Stats:** base HP 90, ATK 18, DEF 6, multiplied by 1 + bonuses. Print: SP +15%, LP +10%, MP +5%, absent +0%. Wishlist: log₁₀(1 + wishlists) / 4 × 20%, capped at +20%. Condition: Burned −4%, Damaged −2%, Poor +0%, Good/Unknown +2%, Excellent +5%, Mint +8%. Age since theft: up to +10% over 90 days. Editions and unknown badges add no guessed bonus. Stats freeze for each match; health and Guard reset afterward.\n\n' +
      '**Realm Legends:** single-print cards with at least +35% total bonuses earn a legend mark, even on arrival. The normal cap is +53%; legends obey the same damage rules and can be beaten with a prepared team. New legends and arrivals beating the server’s existing highest HP+ATK+DEF are announced. Ties with existing cards do not break the record.\n\n' +
      '**Duels:** `/duel opponent:@user` is friendly. Add `stake:ID` to wager one owned card; your opponent offers a card and you confirm both wagers. The loser of a completed duel—or someone who surrenders—loses that card. Self-cards cannot be wagered.\n\n' +
      '**Limits:** one battle/invitation per player, 2-minute invitations, 5-minute turns and reward selection, 100 actions max. Timeouts/draws transfer no cards. `/battle` resumes after restart; `/collection`, `/realm`, and `/card` show IDs and stats.')], allowedMentions: { parse: [] } });

  async function publish(i, m) {
    await i.editReply(panel(m));
    const message = await i.fetchReply();
    m.messageId = message.id;
    save();
  }

  async function handle(i) {
    const component = (i.isButton?.() || i.isStringSelectMenu?.()) && i.customId?.startsWith('battle:');
    const command = i.isChatInputCommand?.() && names.has(i.commandName);
    if (!component && !command) return false;
    try {
      if (!i.inGuild()) throw new Error('Battles are available inside servers only.');
      engine.expire(); engine.syncCards();
      if (component) {
        const [, id, revision, action] = i.customId.split(':');
        // Acknowledge promptly, then perform an entirely synchronous, persisted
        // state transition. Revisions prevent racing or replayed clicks.
        await i.deferUpdate();
        await inOrder(id, async () => {
          let m;
          if (['actor', 'target'].includes(action)) m = engine.choose(id, i.guildId, i.user.id, Number(revision), action, i.values[0]);
          else if (['attack', 'guard'].includes(action)) m = engine.act(id, i.guildId, i.user.id, Number(revision), action);
          else if (action === 'collect') m = engine.collect(id, i.guildId, i.user.id, Number(revision), i.values);
          else if (action === 'accept' || action === 'stake') m = engine.accept(id, i.guildId, i.user.id, Number(revision), i.values?.[0]);
          else if (action === 'concede') m = engine.concede(id, i.guildId, i.user.id, Number(revision));
          else throw new Error('Unknown battle control.');
          await i.editReply(panel(m));
        });
        return true;
      }
      if (['equip', 'unequip'].includes(i.commandName)) {
        const result = engine[i.commandName](i.guildId, i.user.id, i.options.getString('card'));
        await i.reply({ content: esc(result), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        return true;
      }
      if (i.commandName === 'battle-help') { await i.reply(help()); return true; }
      if (i.commandName === 'realm' || i.commandName === 'collection') {
        const user = i.commandName === 'collection' ? userInfo(i.options.getUser('user') ?? i.user) : null;
        await i.reply(book(i.guildId, user, i.options.getInteger('page'))); return true;
      }
      if (i.commandName === 'card') { await i.reply(inspect(i.guildId, i.options.getString('card'))); return true; }
      await i.deferReply();
      if (i.commandName === 'battle' || i.commandName === 'accept') {
        const current = engine.forUser(i.guildId, i.user.id);
        const last = Object.values(engine.state.matches).filter((m) => m.guildId === i.guildId && m.users.includes(i.user.id)).sort((a, b) => b.createdAt - a.createdAt)[0];
        if (!current && (i.commandName === 'accept' || !last)) throw new Error('You have no active battle. Use /challenge or /duel.');
        const m = i.commandName === 'accept' ? engine.accept(current.id, i.guildId, i.user.id, current.revision, i.options.getString('card')) : current ?? last;
        await publish(i, m); return true;
      }
      const opponent = i.options.getUser('opponent');
      const characters = i.commandName === 'challenge' ? i.options.getString('characters') : null;
      const stake = i.options.getString('stake');
      if (opponent && characters) throw new Error('Choose realm characters or a server opponent, not both.');
      if (stake && !opponent) throw new Error('Stakes are only for duels with another member.');
      if (opponent) await i.guild.members.fetch(opponent.id);
      const m = opponent ? engine.invite(i.guildId, i.channelId, userInfo(i.user), userInfo(opponent), stake) :
        engine.challenge(i.guildId, i.channelId, userInfo(i.user), characters);
      await publish(i, m);
    } catch (error) {
      console.error('Battle interaction:', error.message);
      const content = error.code ? 'The operation could not be completed. Check the bot log; your battle can be resumed with /battle.' : error.message;
      const payload = { content: esc(short(content, 1800)), allowedMentions: { parse: [] } };
      if (i.deferred || i.replied) {
        if (component) await i.followUp({ ...payload, flags: MessageFlags.Ephemeral }).catch(console.error);
        else await i.editReply(payload).catch(console.error);
      } else await i.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(console.error);
    }
    return true;
  }

  return { engine, commands: builders.map((b) => b.toJSON()), handle, panel, book, inspect, help };
}

module.exports = { createCombat };
