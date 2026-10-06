'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BattleEngine, cardStats } = require('./battle-engine');
const NOW = 1_800_000_000_000;
const alice = { id: 'a', name: 'Alice' }, bob = { id: 'b', name: 'Bob' };
function setup(count = 8) {
  const data = { stolen: Array.from({ length: count }, (_, i) => ({ name: `Hero ${i + 1}`, series: 'World',
    guildId: 'g', at: NOW, wishlists: 0, condition: 'Unknown' })) };
  let clock = NOW, fail = false, saves = 0;
  const save = () => { if (fail) throw new Error('disk full'); saves++; };
  const engine = new BattleEngine(data, save, { now: () => clock, random: () => 0 });
  return { data, engine, save, advance: (ms) => { clock += ms; }, failSave: () => { fail = true; }, saves: () => saves };
}
function winRealm(engine, m) {
  for (let n = 0; m.status === 'battle' && n < 100; n++) m = engine.act(m.id, 'g', 'a', m.revision, 'attack');
  assert.equal(m.status, 'reward');
  return m;
}
function grant(engine, owner, count = 1, strong = false) {
  const cards = engine.cards('g').slice(-count);
  for (const c of cards) {
    c.ownerId = owner;
    if (strong) { c.wishlists = 10000; c.condition = 'Mint'; c.metadata = ['<:k_sp:123>']; c.at -= 90 * 86400000; }
  }
  return cards;
}

test('migration assigns stable IDs without losing existing card metadata or duplicate copies', () => {
  const { data, engine, save } = setup();
  data.stolen[1].name = data.stolen[0].name;
  data.stolen[0].metadata = ['🌟'];
  const ids = engine.cards('g').map((c) => c.id);
  new BattleEngine(data, save);
  assert.deepEqual(data.stolen.map((c) => c.id), ids);
  assert.equal(new Set(ids).size, 8);
  assert.deepEqual(data.stolen[0].metadata, ['🌟']);
});

test('stats increase monotonically with known factors, cap bonuses, and keep unknown attributes neutral', () => {
  const base = { at: NOW, condition: 'Unknown', wishlists: 0 };
  const ordinary = cardStats(base, NOW);
  assert.deepEqual(ordinary, cardStats({ ...base, metadata: ['<:unknown_rarity:123>','<:k_e99:456>'] }, NOW));
  const elite = cardStats({ ...base, wishlists: 10000, metadata: ['<:k_sp:123>'], condition: 'Mint', at: NOW - 90*86400000 }, NOW);
  assert.ok(elite.health > ordinary.health && elite.attack > ordinary.attack && elite.defense > ordinary.defense);
  assert.deepEqual(elite, cardStats({ ...base, wishlists: 999999999, metadata: ['<:k_sp:123>'], condition: 'Mint', at: 0 }, NOW));
  assert.equal(cardStats({ ...base, at: NOW + 999999 }, NOW).factors.age, 0);
  assert.equal(cardStats({ ...base, condition: 'Good' }, NOW).health, ordinary.health);
  assert.equal(cardStats({ ...base, metadata: ['not single print', '<:spooky_badge:123>'] }, NOW).factors.print, 0);
});

test('realm legends are exceptional but bounded and beatable by a prepared team', () => {
  const { engine } = setup(8);
  const legend = engine.cards('g')[0];
  Object.assign(legend, { wishlists: 10000, condition: 'Mint', metadata: ['<:k_sp:123>'], at: NOW - 100*86400000 });
  const stats = cardStats(legend, NOW);
  assert.equal(stats.legend, true);
  assert.ok(stats.health <= 138 && stats.attack <= 28 && stats.defense <= 9);
  for (const c of grant(engine, 'a', 3)) engine.equip('g', 'a', c.id);
  assert.equal(winRealm(engine, engine.challenge('g', 'ch', alice, legend.id)).status, 'reward');
});

test('duplicate card IDs stop migration instead of allowing duplicate rewards', () => {
  const { data, save } = setup();
  data.stolen[1].id = data.stolen[0].id;
  assert.throws(() => new BattleEngine(data, save), /Duplicate card IDs/);
});

test('starter can win a basic encounter and select its unique card reward exactly once', () => {
  const { engine, data } = setup();
  let m = engine.challenge('g', 'channel', alice);
  assert.equal(m.teams[0][0].id, 'self-a');
  assert.equal(m.teams[1].length, 1);
  assert.equal(engine.cards('g', 'a').length, 0);
  m = winRealm(engine, m);
  const id = m.reserved[0], revision = m.revision;
  engine.collect(m.id, 'g', 'a', revision, [id]);
  assert.equal(engine.cards('g', 'a')[0].id, id);
  assert.throws(() => engine.collect(m.id, 'g', 'a', revision, [id]), /ended/);
  assert.ok(data.stolen.every((c) => c.hp === undefined));
});

test('realm reserves copies across users and rejects duplicate selections and over-four challenges', () => {
  const { engine } = setup();
  assert.throws(() => engine.challenge('g', 'ch', alice, 'Hero 1, Hero 1'), /different/);
  assert.throws(() => engine.challenge('g', 'ch', alice, 'Hero 1, Hero 2, Hero 3, Hero 4, Hero 5'), /at most four/);
  const m = engine.challenge('g', 'ch', alice, 'Hero 1');
  assert.throws(() => engine.challenge('g', 'ch', bob, 'Hero 1'), /No available/);
  assert.throws(() => engine.challenge('g', 'ch', alice, 'Hero 2'), /already has/);
  engine.concede(m.id, 'g', 'a', m.revision);
  assert.doesNotThrow(() => engine.challenge('g', 'ch', bob, 'Hero 1'));
});

test('names with multiple copies require IDs; guild ownership boundaries are enforced', () => {
  const { engine, data } = setup();
  data.stolen[1].name = 'Hero 1';
  assert.throws(() => engine.challenge('g', 'ch', alice, 'Hero 1'), /Multiple copies/);
  assert.throws(() => engine.challenge('other', 'ch', alice, data.stolen[0].id), /no available/);
  const owned = grant(engine, 'b')[0];
  assert.throws(() => engine.equip('g', 'a', owned.id), /No available/);
});

test('reward quota is ceil(opponents/2), full victory is required, leftovers return to realm', () => {
  for (const count of [1, 2, 3, 4]) {
    const { engine } = setup(12);
    for (const c of grant(engine, 'a', 5, true)) engine.equip('g', 'a', c.id);
    let m = engine.challenge('g', 'ch', alice, Array.from({ length: count }, (_, i) => `Hero ${i+1}`).join(', '));
    assert.equal(m.quota, Math.ceil(count / 2));
    assert.throws(() => engine.collect(m.id, 'g', 'a', m.revision, [m.reserved[0]]), /cannot collect/);
    // A failed transaction restores canonical state; get the current reference.
    m = engine.state.matches[m.id];
    m = winRealm(engine, m);
    const ids = [...m.reserved];
    if (count > m.quota) {
      assert.throws(() => engine.collect(m.id, 'g', 'a', m.revision, ids), /reward limit/);
      m = engine.state.matches[m.id];
    }
    engine.collect(m.id, 'g', 'a', m.revision, ids.slice(0, m.quota));
    assert.equal(engine.cards('g', 'a').length, 5 + Math.ceil(count/2));
    for (const id of ids.slice(Math.ceil(count/2))) assert.equal(engine.reserved(id), false);
  }
});

test('loss returns all realm opponents without a reward', () => {
  const { engine } = setup();
  const m = engine.challenge('g', 'ch', alice, 'Hero 1, Hero 2');
  m.teams[1].forEach((c) => { c.attack = 999; });
  engine.act(m.id, 'g', 'a', m.revision, 'attack');
  assert.equal(m.status, 'ended');
  assert.equal(engine.cards('g', 'a').length, 0);
  assert.equal(m.reserved.length, 0);
});

test('equipment caps at five distinct owned copies, locks in battle, and falls back to self', () => {
  const { engine } = setup(10);
  const owned = grant(engine, 'a', 6);
  for (const c of owned.slice(0, 5)) engine.equip('g', 'a', c.id);
  assert.throws(() => engine.equip('g', 'a', owned[5].id), /at most five/);
  assert.throws(() => engine.equip('g', 'a', owned[0].id), /already equipped/);
  let m = engine.challenge('g', 'ch', alice);
  assert.equal(m.teams[0].length, 5);
  assert.throws(() => engine.unequip('g', 'a'), /Finish/);
  m = engine.state.matches[m.id];
  engine.concede(m.id, 'g', 'a', m.revision);
  engine.unequip('g', 'a');
  assert.equal(engine.team('g', alice)[0].id, 'self-a');
});

test('stale, outsider, other-server and wrong-turn actions cannot mutate battle state', () => {
  const { engine } = setup();
  const m = engine.challenge('g', 'ch', alice);
  const before = JSON.stringify(engine.state.matches);
  assert.throws(() => engine.act(m.id, 'g', 'b', m.revision, 'attack'), /not yours/);
  assert.throws(() => engine.act(m.id, 'other', 'a', m.revision, 'attack'), /not yours/);
  assert.throws(() => engine.act(m.id, 'g', 'a', 999, 'attack'), /out of date/);
  assert.equal(JSON.stringify(engine.state.matches), before);
});

test('guard halves the next hit and damage state stays in the match snapshot', () => {
  const { engine } = setup();
  const m = engine.challenge('g', 'ch', alice);
  engine.act(m.id, 'g', 'a', m.revision, 'guard');
  assert.equal(m.teams[0][0].hp, 98); // round((18 - 8*.6)/2) = 7
  assert.equal(m.teams[0][0].guarding, false);
  engine.concede(m.id, 'g', 'a', m.revision);
  const next = engine.challenge('g', 'ch', alice);
  assert.equal(next.teams[0][0].hp, 105);
});

function wager(engine) {
  const a = grant(engine, 'a')[0], b = grant(engine, 'b')[0];
  engine.equip('g', 'a', a.id); engine.equip('g', 'b', b.id);
  let m = engine.invite('g', 'ch', alice, bob, a.id);
  m = engine.accept(m.id, 'g', 'b', m.revision, b.id);
  m = engine.accept(m.id, 'g', 'a', m.revision);
  return { m, a, b };
}

test('wager requires both exact card offers and challenger confirmation before battle', () => {
  const { engine } = setup();
  const a = grant(engine, 'a')[0], b = grant(engine, 'b')[0];
  let m = engine.invite('g', 'ch', alice, bob, a.id);
  assert.equal(m.status, 'invite');
  assert.throws(() => engine.accept(m.id, 'g', 'a', m.revision), /Waiting/);
  m = engine.state.matches[m.id];
  m = engine.accept(m.id, 'g', 'b', m.revision, b.id);
  assert.equal(m.status, 'invite');
  assert.equal(engine.cards('g', 'a').length, 1);
  m = engine.accept(m.id, 'g', 'a', m.revision);
  assert.equal(m.status, 'battle');
  assert.throws(() => engine.act(m.id, 'g', 'b', m.revision, 'attack'), /not your turn/);
});

test('duel surrender transfers only the agreed losing card and removes it from equipment', () => {
  const { engine } = setup();
  const { m, b } = wager(engine);
  engine.concede(m.id, 'g', 'b', m.revision);
  assert.equal(engine.cards('g', 'a').length, 2);
  assert.equal(engine.cards('g', 'b').length, 0);
  assert.ok(!engine.player('g', 'b').equipped.includes(b.id));
  assert.equal(engine.team('g', bob)[0].id, 'self-b');
});

test('a completed wagered battle transfers the losers card once', () => {
  const { engine } = setup();
  let { m } = wager(engine);
  for (let turn = 0; m.status === 'battle' && turn < 100; turn++) m = engine.act(m.id, 'g', m.users[m.turn], m.revision, 'attack');
  assert.equal(m.status, 'ended');
  assert.equal(engine.cards('g', m.users[m.winner]).length, 2);
  assert.equal(m.awarded.length, 1);
  assert.throws(() => engine.concede(m.id, 'g', 'b', m.revision), /ended/);
});

test('friendly starter duels require acceptance and never transfer cards', () => {
  const { engine } = setup();
  let m = engine.invite('g', 'ch', alice, bob);
  assert.equal(m.status, 'invite');
  m = engine.accept(m.id, 'g', 'b', m.revision);
  assert.equal(m.teams[1][0].id, 'self-b');
  engine.concede(m.id, 'g', 'b', m.revision);
  assert.equal(engine.cards('g', 'a').length, 0);
});

test('timeout releases reservations without moving wagered cards', () => {
  const { engine, advance } = setup();
  const { m } = wager(engine);
  advance(6 * 60000); engine.expire();
  assert.equal(engine.cards('g', 'a').length, 1);
  assert.equal(engine.cards('g', 'b').length, 1);
  assert.equal(m.status, 'ended');
  assert.equal(m.reserved.length, 0);
});

test('persistent battle resumes on restart with health, revision and reservations intact', () => {
  const { engine, data } = setup();
  let m = engine.challenge('g', 'ch', alice);
  m = engine.act(m.id, 'g', 'a', m.revision, 'attack');
  const clone = JSON.parse(JSON.stringify(data));
  const resumed = new BattleEngine(clone, () => {}, { now: () => NOW, random: () => 0 });
  assert.deepEqual(resumed.forUser('g', 'a'), m);
  assert.equal(resumed.reserved(m.reserved[0]), true);
  assert.equal(resumed.act(m.id, 'g', 'a', m.revision, 'attack').revision, m.revision + 1);
});

test('storage failure rolls back reward transfer, stats and match completion', () => {
  const { engine, data, failSave } = setup();
  const m = winRealm(engine, engine.challenge('g', 'ch', alice));
  const before = JSON.stringify(data);
  failSave();
  assert.throws(() => engine.collect(m.id, 'g', 'a', m.revision, [m.reserved[0]]), /disk full/);
  assert.equal(JSON.stringify(data), before);
});
