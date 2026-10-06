'use strict';

const { randomBytes } = require('node:crypto');
const MINUTE = 60_000;
const DAY = 86_400_000;
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const key = (s) => String(s).normalize('NFKC').trim().toLowerCase();

// All combatants use the same bounded formula. Metadata does not fabricate an
// exact print, creation date, or market value. Snapshot stats at battle start.
function cardStats(card, now = Date.now()) {
  const tags = (Array.isArray(card.metadata) ? card.metadata : []).flatMap((field) => {
    const raw = String(field);
    return [raw.trim(), ...[...raw.matchAll(/<a?:(\w+):\d+>/g)].map((m) => m[1])]
      .map((tag) => tag.replace(/^k_/i, '').toLowerCase());
  });
  const print = tags.includes('sp') ? 0.15 : tags.includes('lp') ? 0.10 : tags.includes('mp') ? 0.05 : 0;
  const wishlist = Math.min(1, Math.log10(1 + Math.max(0, Number(card.wishlists) || 0)) / 4) * 0.20;
  const quality = { Burned: -0.04, Damaged: -0.02, Poor: 0, Good: 0.02, Excellent: 0.05, Mint: 0.08 }[card.condition] ?? 0.02;
  const stolenAt = card.at != null && Number.isFinite(Number(card.at)) ? Number(card.at) : now;
  const age = clamp((now - stolenAt) / (90 * DAY), 0, 1) * 0.10;
  const multiplier = 1 + print + wishlist + quality + age;
  return { health: Math.round(90 * multiplier), attack: Math.round(18 * multiplier),
    defense: Math.round(6 * multiplier), legend: print === 0.15 && multiplier >= 1.35,
    factors: { print, wishlist, quality, age } };
}

class BattleEngine {
  constructor(data, save, { now = Date.now, random = Math.random } = {}) {
    this.data = data; this.save = save; this.now = now; this.random = random;
    this.data.game ??= { nextCard: 1, players: {}, matches: {}, notices: [] };
    if (!this.data.game.players || !this.data.game.matches || !Number.isInteger(this.data.game.nextCard)) {
      throw new Error('Invalid game state in data.json. Restore a backup instead of resetting collections.');
    }
    this.state.notices ??= [];
    if (!Array.isArray(this.state.notices)) throw new Error('Invalid arrival announcements in data.json.');
    this.syncCards();
  }

  get state() { return this.data.game; }

  queueArrivalNotices(drop, arrivals) {
    const ids = new Set(arrivals.map((c) => c.id));
    const at = this.now();
    const snapshot = (card) => {
      const stats = cardStats(card, at);
      return { id: card.id, name: card.name, ...stats, power: stats.health + stats.attack + stats.defense };
    };
    const incoming = arrivals.map(snapshot);
    const previous = this.data.stolen.filter((c) => c.id && !c.unknown && c.guildId === drop.guildId && !ids.has(c.id)).map(snapshot);
    const enqueue = (suffix, type, cards) => {
      const id = `${drop.id}:${suffix}`;
      if (!this.state.notices.some((n) => n.id === id)) this.state.notices.push({ id, type, cards,
        guildId: drop.guildId, channelId: drop.channelId, at });
    };
    for (const card of incoming.filter((c) => c.legend)) enqueue(`legend:${card.id}`, 'legend', [card]);
    const oldPower = previous.length ? Math.max(...previous.map((c) => c.power)) : null;
    const bestPower = incoming.length ? Math.max(...incoming.map((c) => c.power)) : null;
    // The first arrival establishes a benchmark. Compare against ALL recorded
    // copies in this server (including owned ones) at the same timestamp.
    if (oldPower !== null && bestPower > oldPower) {
      enqueue('strongest', 'strongest', incoming.filter((c) => c.power === bestPower));
    }
  }

  transaction(fn) {
    const snapshot = JSON.stringify({ stolen: this.data.stolen, game: this.state });
    try { const result = fn(); this.save(); return result; }
    catch (error) {
      const old = JSON.parse(snapshot);
      this.data.stolen = old.stolen; this.data.game = old.game;
      throw error;
    }
  }

  syncCards() {
    const existing = this.data.stolen.filter((c) => c.id).map((c) => c.id);
    const used = new Set(existing);
    if (used.size !== existing.length) throw new Error('Duplicate card IDs in data.json. Restore a valid backup before continuing.');
    for (const card of this.data.stolen) {
      if (card.unknown || !card.name || !card.guildId) continue;
      if (!card.id) {
        do { card.id = `kt${String(this.state.nextCard++).padStart(6, '0')}`; } while (used.has(card.id));
        used.add(card.id);
      }
      card.ownerId ??= null;
    }
  }

  player(guildId, userId) {
    const id = `${guildId}:${userId}`;
    return this.state.players[id] ??= { equipped: [], wins: 0, losses: 0 };
  }

  cards(guildId, ownerId = null) {
    return this.data.stolen.filter((c) => c.id && c.guildId === guildId && c.ownerId === ownerId && !c.unknown);
  }

  active(match) { return ['invite', 'battle', 'reward'].includes(match.status); }
  forUser(guildId, userId) {
    return Object.values(this.state.matches).find((m) => m.guildId === guildId && this.active(m) && m.users.includes(userId));
  }
  reserved(id) {
    return Object.values(this.state.matches).some((m) => this.active(m) && m.reserved.includes(id));
  }

  resolve(cards, query) {
    const exactId = cards.find((c) => c.id === key(query));
    if (exactId) return exactId;
    const matches = cards.filter((c) => key(c.name) === key(query));
    if (!matches.length) throw new Error(`No available card matches “${String(query).slice(0,100)}”. Use /realm or /collection for card IDs.`);
    if (matches.length > 1) throw new Error(`Multiple copies match “${String(query).slice(0,100)}”. Use a card ID: ${matches.slice(0,5).map((c) => c.id).join(', ')}.`);
    return matches[0];
  }

  equip(guildId, userId, query) {
    return this.transaction(() => {
      if (this.forUser(guildId, userId)) throw new Error('Finish your current battle or invitation before changing equipment.');
      const p = this.player(guildId, userId);
      if (!query) { p.equipped = []; return 'All cards unequipped. Your self-card will fight for you.'; }
      const card = this.resolve(this.cards(guildId, userId), query);
      if (p.equipped.includes(card.id)) throw new Error('That copy is already equipped.');
      if (p.equipped.length >= 5) throw new Error('You can equip at most five cards. Use /unequip first.');
      p.equipped.push(card.id);
      return `Equipped ${card.name} (${card.id}).`;
    });
  }

  unequip(guildId, userId, query) {
    if (!query) return this.equip(guildId, userId, null);
    return this.transaction(() => {
      if (this.forUser(guildId, userId)) throw new Error('Finish your current battle or invitation before changing equipment.');
      const p = this.player(guildId, userId);
      const card = this.resolve(this.cards(guildId, userId).filter((c) => p.equipped.includes(c.id)), query);
      p.equipped = p.equipped.filter((id) => id !== card.id);
      return `Unequipped ${card.name} (${card.id}).`;
    });
  }

  fighter(card) {
    const stats = cardStats(card, this.now());
    return { id: card.id, name: card.name, ...stats, hp: stats.health, guarding: false };
  }

  team(guildId, user) {
    const equipped = this.player(guildId, user.id).equipped;
    const cards = this.cards(guildId, user.id).filter((c) => equipped.includes(c.id));
    if (cards.length) return cards.map((c) => this.fighter(c));
    return [{ id: `self-${user.id}`, name: `${user.name} (self)`, health: 105, hp: 105, attack: 22, defense: 8, guarding: false }];
  }

  createMatch(guildId, channelId, users, mode) {
    for (const u of users) if (this.forUser(guildId, u.id)) throw new Error(`${u.name} already has a battle or invitation. Use /battle to resume yours.`);
    const id = randomBytes(6).toString('hex');
    const match = { id, guildId, channelId, users: users.map((u) => u.id), names: users.map((u) => u.name),
      mode, status: 'battle', reserved: [], createdAt: this.now(), expiresAt: this.now() + 5 * MINUTE,
      revision: 0, turn: 0, actions: 0, log: [], teams: [], choices: {}, messageId: null };
    this.state.matches[id] = match;
    return match;
  }

  challenge(guildId, channelId, user, query) {
    this.expire();
    return this.transaction(() => {
      this.syncCards();
      const pool = this.cards(guildId).filter((c) => !this.reserved(c.id));
      if (!pool.length) throw new Error('The realm has no available characters. Wait for Karutake to steal another drop.');
      const names = query ? query.split(',').map((s) => s.trim()).filter(Boolean) : [];
      if (query && !names.length) throw new Error('Enter one to four character names or card IDs, separated by commas.');
      if (names.length > 4) throw new Error('Challenge at most four characters at once.');
      const opponents = names.length ? names.map((name) => this.resolve(pool, name)) : [pool[Math.min(pool.length - 1, Math.floor(this.random() * pool.length))]];
      if (new Set(opponents.map((c) => c.id)).size !== opponents.length) throw new Error('Each challenged copy must be different.');
      const m = this.createMatch(guildId, channelId, [user], 'realm');
      m.reserved = opponents.map((c) => c.id);
      m.teams = [this.team(guildId, user), opponents.map((c) => this.fighter(c))];
      m.quota = Math.ceil(opponents.length / 2);
      m.log = ['You cross into the Forgotten Realm. Defeat its banished characters to restore them to cards.'];
      return m;
    });
  }

  invite(guildId, channelId, user, opponent, stakeQuery) {
    this.expire();
    return this.transaction(() => {
      if (user.id === opponent.id || opponent.bot) throw new Error('Choose another human member of this server.');
      const stake = stakeQuery ? this.resolve(this.cards(guildId, user.id), stakeQuery) : null;
      const m = this.createMatch(guildId, channelId, [user, opponent], 'duel');
      m.status = 'invite'; m.expiresAt = this.now() + 2 * MINUTE;
      m.stakes = [stake?.id ?? null, null]; m.reserved = stake ? [stake.id] : [];
      m.teams = [this.team(guildId, user), this.team(guildId, opponent)];
      m.log = [stake ? `${user.name} offers ${stake.name} (${stake.id}). Both players must agree to the exact wagers before fighting.` : 'Friendly duel: no cards change owners. The challenged player must accept.'];
      return m;
    });
  }

  check(id, guildId, userId, revision) {
    const m = this.state.matches[id];
    if (!m || m.guildId !== guildId || !m.users.includes(userId)) throw new Error('This battle is not yours.');
    if (!this.active(m)) throw new Error(`This battle has ended (${m.result ?? m.status}). Use /battle to view it or start a new challenge.`);
    if (this.now() >= m.expiresAt) throw new Error('This battle has timed out. Use /battle to refresh.');
    if (revision !== m.revision) throw new Error('Those controls are out of date. Use the latest battle message or /battle.');
    return m;
  }

  // The opponent selects a counter-wager; the initiator then confirms the exact
  // offered copy. Selecting a card alone never transfers ownership.
  accept(id, guildId, userId, revision, stakeId) {
    return this.transaction(() => {
      const m = this.check(id, guildId, userId, revision);
      if (m.status !== 'invite') throw new Error('This invitation is no longer open.');
      if (m.stakes[0]) {
        if (!m.stakes[1]) {
          if (userId !== m.users[1]) throw new Error('Waiting for your opponent to select a wager.');
          const card = this.resolve(this.cards(guildId, userId), stakeId ?? '');
          if (this.reserved(card.id)) throw new Error('That card is already reserved.');
          m.stakes[1] = card.id; m.reserved.push(card.id);
          m.log.push(`${m.names[1]} offers ${card.name} (${card.id}). ${m.names[0]} must confirm to begin.`);
          m.revision++; m.expiresAt = this.now() + 2 * MINUTE;
          return m;
        }
        if (userId !== m.users[0]) throw new Error('Waiting for the challenger to confirm the wagers.');
      } else if (userId !== m.users[1]) throw new Error('Only the challenged player can accept.');
      m.status = 'battle'; m.turn = this.random() < 0.5 ? 0 : 1;
      m.revision++; m.expiresAt = this.now() + 5 * MINUTE;
      m.log.push('The duel begins. All combatants start at full health.');
      return m;
    });
  }

  alive(m, side) { return m.teams[side].filter((f) => f.hp > 0); }
  selections(m) {
    const living = this.alive(m, m.turn), enemies = this.alive(m, 1 - m.turn);
    return { actor: living.find((c) => c.id === m.choices.actor) ?? living[0],
      target: enemies.find((c) => c.id === m.choices.target) ?? enemies[0] };
  }

  choose(id, guildId, userId, revision, field, value) {
    return this.transaction(() => {
      const m = this.check(id, guildId, userId, revision);
      if (m.status !== 'battle' || m.users[m.turn] !== userId) throw new Error('It is not your turn.');
      const side = field === 'actor' ? m.turn : 1 - m.turn;
      if (!['actor', 'target'].includes(field) || !this.alive(m, side).some((c) => c.id === value)) throw new Error('That combatant is unavailable.');
      m.choices[field] = value; m.revision++;
      return m;
    });
  }

  hit(m, actor, target) {
    const damage = Math.max(1, Math.round(Math.max(4, actor.attack - target.defense * 0.6) * (target.guarding ? 0.5 : 1)));
    target.guarding = false; target.hp = Math.max(0, target.hp - damage);
    m.log.push(`${actor.name} hits ${target.name} for ${damage}${target.hp === 0 ? ' — defeated!' : '.'}`);
  }

  act(id, guildId, userId, revision, action) {
    return this.transaction(() => {
      const m = this.check(id, guildId, userId, revision);
      if (m.status !== 'battle' || m.users[m.turn] !== userId) throw new Error('It is not your turn.');
      const { actor, target } = this.selections(m);
      if (action === 'attack') this.hit(m, actor, target);
      else if (action === 'guard') { actor.guarding = true; m.log.push(`${actor.name} guards: the next hit deals half damage.`); }
      else throw new Error('Unknown battle action.');
      m.actions++;
      if (!this.alive(m, 1 - m.turn).length) this.victory(m, m.turn);
      else if (m.actions >= 100) this.close(m, 'draw: turn limit');
      else {
        m.turn = 1 - m.turn;
        if (m.mode === 'realm') {
          // Rotate among survivors so the encounter isn't always the same enemy.
          const enemies = this.alive(m, 1);
          const enemy = enemies[Math.floor(m.actions / 2) % enemies.length];
          const targets = this.alive(m, 0);
          const chosen = targets[Math.min(targets.length - 1, Math.floor(this.random() * targets.length))];
          this.hit(m, enemy, chosen); m.actions++;
          if (!this.alive(m, 0).length) this.victory(m, 1);
          else if (m.actions >= 100) this.close(m, 'draw: turn limit');
          else m.turn = 0;
        }
      }
      m.choices = {}; m.log = m.log.slice(-5); m.revision++;
      if (this.active(m)) m.expiresAt = this.now() + 5 * MINUTE;
      return m;
    });
  }

  close(m, result) { m.status = 'ended'; m.result = result; m.finishedAt = this.now(); m.reserved = []; }

  transfer(id, guildId, oldOwner, newOwner) {
    const card = this.cards(guildId, oldOwner).find((c) => c.id === id);
    if (!card) throw new Error('Card ownership changed; no reward was transferred.');
    if (oldOwner) {
      const p = this.player(guildId, oldOwner);
      p.equipped = p.equipped.filter((equipped) => equipped !== id);
    }
    card.ownerId = newOwner; card.claimedAt = this.now();
    return card;
  }

  victory(m, side) {
    m.winner = side;
    if (m.mode === 'realm' && side === 0) {
      m.status = 'reward'; m.log.push(`Victory! Choose up to ${m.quota} restored card${m.quota === 1 ? '' : 's'}.`);
      this.player(m.guildId, m.users[0]).wins++;
      return;
    }
    if (m.users[side]) this.player(m.guildId, m.users[side]).wins++;
    if (m.users[1 - side]) this.player(m.guildId, m.users[1 - side]).losses++;
    if (m.mode === 'duel' && m.stakes[0] && m.stakes[1]) {
      const card = this.transfer(m.stakes[1 - side], m.guildId, m.users[1 - side], m.users[side]);
      m.log.push(`${m.names[side]} wins ${card.name} (${card.id}).`);
      m.awarded = [card.id];
    }
    this.close(m, `${m.names[side] ?? 'The realm'} wins`);
  }

  collect(id, guildId, userId, revision, ids) {
    return this.transaction(() => {
      const m = this.check(id, guildId, userId, revision);
      if (m.status !== 'reward' || m.users[0] !== userId) throw new Error('You cannot collect rewards from this battle.');
      if (!ids.length || ids.length > m.quota || new Set(ids).size !== ids.length || ids.some((id) => !m.reserved.includes(id))) throw new Error('Choose distinct defeated cards within the reward limit.');
      const cards = ids.map((id) => this.transfer(id, guildId, null, userId));
      m.awarded = ids;
      m.log.push(`Collected: ${cards.map((c) => `${c.name} (${c.id})`).join(', ')}. The other characters remain in the realm.`);
      this.close(m, 'victory: rewards collected'); m.revision++;
      return m;
    });
  }

  concede(id, guildId, userId, revision) {
    return this.transaction(() => {
      const m = this.check(id, guildId, userId, revision);
      if (m.status === 'battle' && m.mode === 'duel') this.victory(m, 1 - m.users.indexOf(userId));
      else this.close(m, m.status === 'invite' ? 'invitation declined/cancelled' : 'left the realm without rewards');
      m.revision++;
      return m;
    });
  }

  expire() {
    const expired = Object.values(this.state.matches).filter((m) => this.active(m) && this.now() >= m.expiresAt);
    if (!expired.length) return;
    this.transaction(() => {
      for (const m of expired) {
        // Timeouts never transfer cards: a host outage must not steal wagers.
        this.close(m, 'expired: no cards transferred'); m.revision++;
      }
    });
  }
}

module.exports = { BattleEngine, cardStats };
