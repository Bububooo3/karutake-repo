'use strict';

const QUALITIES = ['Burned', 'Damaged', 'Poor', 'Good', 'Excellent', 'Mint'];
const stripMd = (s) => String(s).replace(/<a?:\w+:\d+>/g, '')
  .replace(/\*\*|__|~~|`/g, '').replace(/\\([\\*_~`])/g, '$1').trim();
const nameKey = (s) => stripMd(s).normalize('NFKC').replace(/\s+/g, ' ').toLowerCase();

function messageText(message) {
  return [message.content, ...(message.embeds ?? []).flatMap((e) =>
    [e.title, e.description, ...(e.fields ?? []).flatMap((f) => [f.name, f.value])])]
    .filter(Boolean).join('\n');
}

function parseKaribbit(message) {
  const cards = [];
  for (const line of messageText(message).split('\n')) {
    const separator = line.indexOf('·');
    if (separator < 0) continue;
    const rawPrefix = line.slice(0, separator);
    const body = line.slice(separator + 1).trim();
    // Parse from the left: position/wishlists · name · series · metadata...
    // Everything AFTER the series is metadata, regardless of emoji name,
    // animation, edition, plain text, or number of extra fields.
    // Bold names may themselves contain a middle dot.
    const fields = body.match(/^\*\*(.+?)\*\*\s*·\s*(.*)$/) ?? body.match(/^([^·]+)·\s*(.*)$/);
    if (!fields) continue;
    const name = stripMd(fields[1]);
    const [seriesField, ...extraFields] = fields[2].split('·');
    const series = stripMd(seriesField);
    const metadata = extraFields.map((field) => field.trim()).filter(Boolean);
    // Only slot emojis contribute numbers. Ignore digits in all other emoji
    // names and IDs, so decorative badges cannot change a slot or wishlist.
    const prefix = rawPrefix.replace(/<a?:(\w+):\d+>/g, (_emoji, label) => {
      const slotEmoji = label.match(/^k_(\d+)$/);
      return slotEmoji ? ` ${slotEmoji[1]} ` : ' ';
    });
    const numbers = prefix.match(/\d[\d,]*/g)?.map((n) => n.replace(/,/g, '')) ?? [];
    const slot = Number(numbers[0]);
    if (!Number.isInteger(slot) || slot < 1 || !name || !series) continue;
    const heart = prefix.match(/[♡♥❤]\D*(\d[\d,]*)/u);
    const wishlists = heart ? Number(heart[1].replace(/,/g, '')) : Number(numbers[1] ?? 0);
    const conditionText = rawPrefix.replace(/<a?:(\w+):\d+>/g, ' $1 ').replace(/_/g, ' ');
    const condition = QUALITIES.find((q) => new RegExp(`\\b${q}\\b`, 'i').test(conditionText)) ?? 'Unknown';
    cards.push({ slot, name, series, wishlists, condition, ...(metadata.length ? { metadata } : {}) });
  }
  return cards;
}

function parseClaim(message) {
  const text = stripMd(messageText(message));
  const match = text.match(/<@!?(\d+)>\s+took the\s+(.+?)\s+card\s+([a-z0-9]+)\s*!/i);
  return match ? { userId: match[1], name: match[2].trim(), code: match[3] } : null;
}

// Claims have no drop reference in the supplied example. Exclude matching names
// from ALL overlapping drops in that channel, including repeated names. This
// deliberately undercounts ambiguous cards instead of claiming a human's card.
class DropTracker {
  constructor({ waitMs = 60_000, graceMs = 3_000, verify, remove, record, announce,
    log = console.log, now = Date.now, schedule = setTimeout, unschedule = clearTimeout,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
    Object.assign(this, { waitMs, graceMs, verify, remove, record, announce,
      log, now, schedule, unschedule, sleep });
    this.drops = new Map();
  }

  track(message) {
    if (this.drops.has(message.id) || !message.guildId) return;
    const count = message.content?.match(/\bis dropping\s+(\d+)\s+cards?\b/i);
    if (!count) return;
    const expected = Number(count[1]);
    const createdAt = message.createdTimestamp;
    if (!Number.isInteger(expected) || expected < 1 || expected > 20 ||
        !Number.isFinite(createdAt) || this.now() >= createdAt + this.waitMs) return;
    const drop = { id: message.id, channelId: message.channelId, guildId: message.guildId,
      dropperId: message.content.match(/<@!?(\d+)>/)?.[1], expected, createdAt,
      cards: [], excluded: new Set(), uncertain: false, state: 'waiting' };
    this.drops.set(drop.id, drop);
    drop.timer = this.schedule(() => { void this.finish(drop.id); },
      Math.max(0, createdAt + this.waitMs - this.now()));
    return drop;
  }

  observeInfo(message) {
    // Never attach an unrelated Karibbit message to the latest drop.
    const drop = this.drops.get(message.reference?.messageId);
    if (!drop || drop.channelId !== message.channelId || drop.guildId !== message.guildId) return;
    const cards = parseKaribbit(message);
    if (!cards.length) return;
    const slots = new Set(cards.map((c) => c.slot));
    if (cards.length !== drop.expected || slots.size !== drop.expected ||
        cards.some((c) => c.slot > drop.expected)) return;
    cards.sort((a, b) => a.slot - b.slot);
    if (drop.cards.length && drop.cards.some((c, i) =>
      nameKey(c.name) !== nameKey(cards[i].name) || c.series !== cards[i].series)) {
      drop.uncertain = true;
      return;
    }
    drop.cards = cards;
  }

  observeClaim(message) {
    const claim = parseClaim(message);
    const looksLikeClaim = /\btook\s+the\b/i.test(messageText(message));
    if (!claim && !looksLikeClaim) return;
    const referencedDrop = this.drops.get(message.reference?.messageId);
    for (const drop of this.drops.values()) {
      if (drop.channelId !== message.channelId || drop.guildId !== message.guildId ||
          message.createdTimestamp < drop.createdAt ||
          (referencedDrop && referencedDrop.id !== drop.id)) continue;
      if (claim) drop.excluded.add(nameKey(claim.name));
      else drop.uncertain = true;
    }
  }

  remaining(drop) {
    return drop.cards.filter((card) => !drop.excluded.has(nameKey(card.name)));
  }

  cancel(id, reason = 'drop removed externally') {
    const drop = this.drops.get(id);
    if (!drop) return;
    this.unschedule(drop.timer);
    this.drops.delete(id);
    this.log(`Skipped drop ${id}: ${reason}`);
  }

  cancelAll(reason) {
    for (const id of this.drops.keys()) this.cancel(id, reason);
  }

  async finish(id) {
    const drop = this.drops.get(id);
    if (!drop || drop.state !== 'waiting') return;
    this.unschedule(drop.timer);
    drop.state = 'verifying';
    try {
      await this.verify(drop);
      if (!this.drops.has(id)) return;
      if (drop.uncertain || drop.cards.length !== drop.expected) {
        this.log(`Skipped drop ${id}: missing or ambiguous card/claim information`);
        return;
      }
      if (!this.remaining(drop).length) return;
      drop.state = 'deleting';
      await this.remove(drop); // No collection or announcement if deletion fails.
      if (!this.drops.has(id)) return;
      drop.state = 'settling';
      // Allow claims already being processed by Karuta to arrive after deletion.
      await this.sleep(this.graceMs);
      await this.verify(drop, { deleted: true });
      if (!this.drops.has(id) || drop.uncertain) return;
      const cards = this.remaining(drop);
      if (!cards.length) return;
      await this.record(drop, cards);
      await this.announce(drop, cards);
    } catch (error) {
      this.log(`Drop ${id} failed (${drop.state}): ${error.message}`);
    } finally {
      this.drops.delete(id);
    }
  }
}

// Use text labels so displaying another bot's badges needs no external-emoji
// permissions. Unknown emoji names and plain/Unicode metadata remain visible.
function badgeLabels(metadata = []) {
  const label = (value) => {
    const key = value.replace(/^k_/i, '').toLowerCase();
    const print = { sp: 'Single print (SP)', lp: 'Low print (LP)', mp: 'Mid print (MP)' }[key];
    if (print) return print;
    if (/^e\d+$/.test(key)) return `Edition ${key.slice(1)}`;
    return value;
  };
  return [...new Set(metadata.filter((field) => typeof field === 'string').map((field) => {
    const text = field.replace(/<a?:(\w+):\d+>/g, (_emoji, name) => label(name));
    return label(text.trim());
  }))];
}

module.exports = { DropTracker, parseKaribbit, parseClaim, nameKey, messageText, badgeLabels };
