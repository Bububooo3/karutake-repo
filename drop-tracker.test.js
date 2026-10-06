'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DropTracker, parseKaribbit, parseClaim, badgeLabels } = require('./drop-tracker');

const dropMessage = (id = '100', channelId = 'channel') => ({
  id, channelId, guildId: 'guild', createdTimestamp: 1000,
  content: '<@123> is dropping 3 cards!',
});
const info = (reference = '100') => ({
  id: '101', channelId: 'channel', guildId: 'guild', createdTimestamp: 1100,
  reference: reference ? { messageId: reference } : null,
  embeds: [{ description: [
    '- `1` `♡` `0` · **Lulu** · Turn A Gundam',
    '- `2` `♡` `1` · **Giant Deer** · Campfire Cooking in Another World with My Absurd Skill',
    '- `3` `♡` `0` · **Bentaro Kiyara** · Cute High Earth Defense Club Happy Kiss!',
  ].join('\n') }],
});
const claim = (name = 'Giant Deer', overrides = {}) => ({
  id: '102', channelId: 'channel', guildId: 'guild', createdTimestamp: 1200,
  content: `<@123> took the **${name}** card \`v817zd7\`! Great, it's in **excellent** condition!`,
  ...overrides,
});
function setup(overrides = {}) {
  const calls = [];
  const tracker = new DropTracker({ now: () => 1000,
    schedule: (_fn, delay) => { calls.push(['timer', delay]); return 1; }, unschedule: () => {},
    verify: async (_drop, options) => { calls.push(['verify', Boolean(options?.deleted)]); },
    remove: async () => { calls.push(['delete']); },
    record: (_drop, cards) => { calls.push(['record', cards.map((c) => c.name)]); },
    announce: async (_drop, cards) => { calls.push(['announce', cards.map((c) => c.name)]); },
    sleep: async () => {}, log: (message) => calls.push(['log', message]), ...overrides,
  });
  tracker.track(dropMessage());
  return { tracker, calls };
}

test('parses screenshot card names, slots, wishlists and successful claim', () => {
  const cards = parseKaribbit(info());
  assert.deepEqual(cards.map((c) => [c.slot, c.name, c.wishlists, c.condition]), [
    [1, 'Lulu', 0, 'Unknown'], [2, 'Giant Deer', 1, 'Unknown'], [3, 'Bentaro Kiyara', 0, 'Unknown'],
  ]);
  assert.equal(parseClaim(claim()).name, 'Giant Deer');
  assert.equal(parseClaim({ content: 'Someone tried to grab a card.' }), null);
});

const editionInfo = () => ({ ...info(), embeds: [{ description: [
  '<:k_dash:1293003756128047184> <:k_1:1292613071126134899> `♡` `0` · **Tokuko Hanada** · Hanada Shounen-shi',
  '<:k_dash:1293003756128047184> <:k_2:1292613048346185806> `♡` `1` · **Demikas** · Log Horizon · <:k_lp:1399163857145958450> · <:k_e8:1399163905615313339>',
  '<:k_dash:1293003756128047184> <:k_3:1292613016592385064> `♡` `0` · **Yuki** · Voice of Fox',
].join('\n') }] });

test('parses actual Karibbit custom emoji slots and trailing LP/edition fields', () => {
  assert.deepEqual(parseKaribbit(editionInfo()).map((c) => [c.slot, c.name, c.series, c.wishlists]), [
    [1, 'Tokuko Hanada', 'Hanada Shounen-shi', 0],
    [2, 'Demikas', 'Log Horizon', 1],
    [3, 'Yuki', 'Voice of Fox', 0],
  ]);
});

test('collects the logged drop and still excludes a claimed edition card', async () => {
  const { tracker, calls } = setup();
  tracker.observeInfo(editionInfo());
  assert.equal(tracker.drops.get('100').cards.length, 3);
  tracker.observeClaim(claim('Demikas'));
  await tracker.finish('100');
  assert.deepEqual(calls.find((c) => c[0] === 'record')[1], ['Tokuko Hanada', 'Yuki']);
});

test('arbitrary trailing badges never alter identity, wishlist, or claimed-card exclusion', async () => {
  const suffixes = [
    ' · <:never_seen_badge_932:999999999999999999>',
    ' · <a:animated_unknown:888888888888888888> · <:edition_200:777777777777777777>',
    ' · ✨ · 🏆 · ❤️ · 1️⃣',
    ' · LP · E99 · mysterious status · 12345',
    ' · <:badge_a:123> <a:badge_b:456> 🔥 · **Special**',
    ' · ' + Array.from({ length: 30 }, (_, n) => `<:future_${n}:123456789012345678>`).join(' · '),
  ];
  for (const suffix of suffixes) {
    const message = info();
    message.embeds[0].description = message.embeds[0].description.split('\n')
      .map((line) => line + suffix).join('\n');
    const parsed = parseKaribbit(message);
    assert.deepEqual(parsed.map(({ metadata, ...identity }) => identity), parseKaribbit(info()), suffix);
    for (const card of parsed) assert.deepEqual(card.metadata, suffix.split('·').map((s) => s.trim()).filter(Boolean));
    const { tracker, calls } = setup();
    tracker.observeInfo(message);
    tracker.observeClaim(claim());
    await tracker.finish('100');
    assert.deepEqual(calls.find((c) => c[0] === 'record')?.[1], ['Lulu', 'Bentaro Kiyara'], suffix);
  }
});

test('decorative prefix emoji digits do not corrupt slot or wishlist counts', () => {
  const message = { content: '<:badge99:99999> <a:k_2:88888> <:heart500:77777> `1,234` · **Demikas** · Log Horizon · 🏆' };
  assert.deepEqual(parseKaribbit(message), [{
    slot: 2, name: 'Demikas', series: 'Log Horizon', wishlists: 1234, condition: 'Unknown', metadata: ['🏆'],
  }]);
});

test('bold names containing middle dots retain their full identity', () => {
  const message = { content: '`1` ♡ `0` · **Name · Second Part** · Series · <:anything:123>' };
  assert.equal(parseKaribbit(message)[0].name, 'Name · Second Part');
  assert.equal(parseKaribbit(message)[0].series, 'Series');
});

test('missing name or series cannot be replaced by metadata', () => {
  for (const content of [
    '`1` ♡ 0 · **** · Series · <:badge:123>',
    '`1` ♡ 0 · **Name** · · <:badge:123>',
    '`1` ♡ 0 · **Name** · <:badge:123>',
  ]) assert.deepEqual(parseKaribbit({ content }), []);
});

test('badge descriptions decode documented print/edition types and preserve unfamiliar badges', () => {
  assert.deepEqual(badgeLabels([
    '<:k_sp:123>', '<:k_lp:124>', '<:k_mp:125>', '<a:k_e99:126>',
    '<:future_badge_123:127>', '🌟', 'new status',
  ]), ['Single print (SP)', 'Low print (LP)', 'Mid print (MP)', 'Edition 99',
    'future_badge_123', '🌟', 'new status']);
  assert.deepEqual(badgeLabels(), []);
});

test('waits 60 seconds, deletes only at finalization, excludes claimed card', async () => {
  const { tracker, calls } = setup();
  tracker.observeInfo(info());
  tracker.observeClaim(claim());
  assert.deepEqual(calls, [['timer', 60_000]]);
  await tracker.finish('100');
  assert.deepEqual(calls.slice(1), [
    ['verify', false], ['delete'], ['verify', true],
    ['record', ['Lulu', 'Bentaro Kiyara']], ['announce', ['Lulu', 'Bentaro Kiyara']],
  ]);
  assert.equal(tracker.drops.size, 0);
});

test('claims arriving before Karibbit information are retained', async () => {
  const { tracker, calls } = setup();
  tracker.observeClaim(claim());
  tracker.observeInfo(info());
  await tracker.finish('100');
  assert.deepEqual(calls.find((c) => c[0] === 'record')[1], ['Lulu', 'Bentaro Kiyara']);
});

test('all claimed cards leave the drop untouched and collection empty', async () => {
  const { tracker, calls } = setup();
  tracker.observeInfo(info());
  for (const name of ['Lulu', 'Giant Deer', 'Bentaro Kiyara']) tracker.observeClaim(claim(name));
  await tracker.finish('100');
  assert.ok(!calls.some((c) => ['delete', 'record', 'announce'].includes(c[0])));
});

test('missing, partial, and unrelated Karibbit information never cause deletion', async () => {
  for (const message of [info(null), info('other'), { ...info(), embeds: [{ description: '`1` ♡ 0 · Lulu · Gundam' }] }]) {
    const { tracker, calls } = setup();
    tracker.observeInfo(message);
    await tracker.finish('100');
    assert.ok(!calls.some((c) => c[0] === 'delete'));
  }
});

test('edited Karibbit embeds supply metadata without starting a new timer', async () => {
  const { tracker, calls } = setup();
  tracker.observeInfo({ ...info(), embeds: [] });
  tracker.observeInfo(info());
  tracker.observeInfo(info());
  tracker.track(dropMessage());
  await tracker.finish('100');
  assert.equal(calls.filter((c) => c[0] === 'timer').length, 1);
  assert.equal(calls.filter((c) => c[0] === 'record').length, 1);
});

test('failed verification or deletion never records or announces a theft', async () => {
  for (const phase of ['verify', 'remove']) {
    const { tracker, calls } = setup({ [phase]: async () => { throw new Error('Missing permissions'); } });
    tracker.observeInfo(info());
    await tracker.finish('100');
    assert.ok(!calls.some((c) => ['record', 'announce'].includes(c[0])));
  }
});

test('a claim received while deletion settles is excluded', async () => {
  const { tracker, calls } = setup({ sleep: async () => { tracker.observeClaim(claim()); } });
  tracker.observeInfo(info());
  await tracker.finish('100');
  assert.deepEqual(calls.find((c) => c[0] === 'record')[1], ['Lulu', 'Bentaro Kiyara']);
});

test('the final history scan can exclude an in-flight claim', async () => {
  const { tracker, calls } = setup({ verify: async (_drop, options) => {
    if (options?.deleted) tracker.observeClaim(claim());
  } });
  tracker.observeInfo(info());
  await tracker.finish('100');
  assert.deepEqual(calls.find((c) => c[0] === 'record')[1], ['Lulu', 'Bentaro Kiyara']);
});

test('ambiguous duplicate names are conservatively excluded across overlapping drops', () => {
  const { tracker } = setup();
  tracker.track(dropMessage('200'));
  tracker.observeInfo(info());
  tracker.observeInfo(info('200'));
  tracker.observeClaim(claim());
  for (const drop of tracker.drops.values()) {
    assert.deepEqual(tracker.remaining(drop).map((c) => c.name), ['Lulu', 'Bentaro Kiyara']);
  }
});

test('claims from other channels or preceding the drop are ignored', () => {
  const { tracker } = setup();
  tracker.observeInfo(info());
  tracker.observeClaim(claim('Giant Deer', { channelId: 'other' }));
  tracker.observeClaim(claim('Lulu', { createdTimestamp: 900 }));
  assert.equal(tracker.remaining(tracker.drops.get('100')).length, 3);
});

test('an unrecognized success format skips collection', async () => {
  const { tracker, calls } = setup();
  tracker.observeInfo(info());
  tracker.observeClaim(claim('unused', { content: '<@123> took the Giant Deer card [new format]' }));
  await tracker.finish('100');
  assert.ok(!calls.some((c) => c[0] === 'delete'));
});

test('disconnect cancellation during verification prevents deletion', async () => {
  const { tracker, calls } = setup({ verify: async () => tracker.cancelAll('disconnect') });
  tracker.observeInfo(info());
  await tracker.finish('100');
  assert.ok(!calls.some((c) => c[0] === 'delete'));
});

test('disconnect after deletion prevents unverifiable collection', async () => {
  const { tracker, calls } = setup({ sleep: async () => tracker.cancelAll('disconnect') });
  tracker.observeInfo(info());
  await tracker.finish('100');
  assert.ok(!calls.some((c) => c[0] === 'record'));
});

test('duplicate timer callbacks cannot double-record', async () => {
  const { tracker, calls } = setup();
  tracker.observeInfo(info());
  await Promise.all([tracker.finish('100'), tracker.finish('100')]);
  await tracker.finish('100');
  assert.equal(calls.filter((c) => c[0] === 'record').length, 1);
});

test('already-old drops are not collected after startup', () => {
  const { tracker } = setup({ now: () => 90_000 });
  assert.equal(tracker.drops.size, 0);
});
