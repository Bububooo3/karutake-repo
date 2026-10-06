'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCombat } = require('./battle-discord');

function setup() {
  const data = { stolen: Array.from({ length: 8 }, (_, n) => ({ name: `Hero ${n+1}`, series: 'World',
    guildId: 'g', at: Date.now(), wishlists: 0, condition: 'Unknown' })) };
  const combat = createCombat({ data, save: () => {} });
  const interaction = (name, values = {}, userId = 'a') => {
    const responses = [];
    const i = { guildId: 'g', channelId: 'ch', user: { id: userId, username: userId }, commandName: name,
      guild: { members: { fetch: async (id) => ({ id }) } },
      options: { getString: (key) => values[key] ?? null, getUser: (key) => values[key] ?? null, getInteger: (key) => values[key] ?? null },
      isChatInputCommand: () => true, isButton: () => false, isStringSelectMenu: () => false, inGuild: () => true,
      reply: async (payload) => { i.replied = true; responses.push(payload); },
      deferReply: async () => { i.deferred = true; },
      deferUpdate: async () => { i.deferred = true; },
      editReply: async (payload) => { responses.push(payload); },
      followUp: async (payload) => { responses.push(payload); },
      fetchReply: async () => ({ id: 'message' }), responses,
    };
    return i;
  };
  const click = (m, action, userId = 'a', values = []) => {
    const i = interaction(null, {}, userId);
    i.customId = `battle:${m.id}:${m.revision}:${action}`;
    i.values = values; i.isChatInputCommand = () => false;
    i.isButton = () => true;
    return i;
  };
  return { data, combat, interaction, click };
}

function validatePanel(panel) {
  const embeds = panel.embeds.map((e) => e.toJSON());
  const total = embeds.reduce((n, e) => n + (e.title?.length ?? 0) + (e.description?.length ?? 0) +
    (e.footer?.text.length ?? 0) + (e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0), 0);
  assert.ok(total <= 6000);
  assert.ok((panel.components ?? []).length <= 5);
  for (const r of panel.components ?? []) r.toJSON();
}

test('Discord commands and help serialize within Discord limits', () => {
  const { combat } = setup();
  assert.deepEqual(combat.commands.map((c) => c.name), ['challenge','duel','accept','battle','equip','unequip','collection','realm','card','battle-help']);
  validatePanel(combat.help());
  validatePanel(combat.book('g', null, 1));
});

test('full Discord challenge-to-reward flow persists ownership and renders valid controls', async () => {
  const { combat, interaction, click } = setup();
  const start = interaction('challenge');
  assert.equal(await combat.handle(start), true);
  let m = combat.engine.forUser('g', 'a');
  assert.equal(m.teams[1].length, 1);
  validatePanel(start.responses[0]);
  for (let n = 0; m.status === 'battle' && n < 50; n++) {
    const action = click(m, 'attack');
    await combat.handle(action);
    m = combat.engine.state.matches[m.id];
    validatePanel(action.responses[0]);
  }
  assert.equal(m.status, 'reward');
  const reward = click(m, 'collect', 'a', [m.reserved[0]]);
  await combat.handle(reward);
  assert.equal(combat.engine.cards('g', 'a').length, 1);
  validatePanel(reward.responses[0]);
  const equip = interaction('equip', { card: combat.engine.cards('g', 'a')[0].id });
  await combat.handle(equip);
  assert.match(equip.responses[0].content, /Equipped/);
});

test('one-to-four challenge controls include all enemies; a legend is visibly identified', async () => {
  const { combat, data, interaction } = setup();
  Object.assign(data.stolen[0], { wishlists: 10000, condition: 'Mint', metadata: ['<:k_sp:123>'], at: Date.now() - 100*86400000 });
  const i = interaction('challenge', { characters: 'Hero 1, Hero 2, Hero 3, Hero 4' });
  await combat.handle(i);
  const panel = i.responses[0]; validatePanel(panel);
  assert.equal(panel.components[1].toJSON().components[0].options.length, 4);
  assert.match(panel.embeds[0].toJSON().fields[1].value, /Legend/);
  assert.match(combat.inspect('g', data.stolen[0].id).embeds[0].toJSON().description, /Realm Legend/);
});

test('duel router supports explicit stakes, counteroffer, confirmation and surrender', async () => {
  const { combat, data, interaction, click } = setup();
  data.stolen[0].ownerId = 'a'; data.stolen[1].ownerId = 'b';
  await combat.handle(interaction('duel', { opponent: { id: 'b', username: 'Bob' }, stake: data.stolen[0].id }));
  let m = combat.engine.forUser('g', 'a');
  assert.equal(m.status, 'invite'); validatePanel(combat.panel(m));
  await combat.handle(click(m, 'stake', 'b', [data.stolen[1].id]));
  m = combat.engine.state.matches[m.id];
  assert.equal(m.status, 'invite'); validatePanel(combat.panel(m));
  await combat.handle(click(m, 'accept'));
  m = combat.engine.state.matches[m.id];
  assert.equal(m.status, 'battle');
  await combat.handle(click(m, 'concede', 'b'));
  assert.equal(combat.engine.cards('g', 'a').length, 2);
});

test('duplicate simultaneous clicks apply only one action; outsiders cannot take a turn', async () => {
  const { combat, interaction, click } = setup();
  await combat.handle(interaction('challenge'));
  const m = combat.engine.forUser('g', 'a');
  const clicks = [click(m, 'attack'), click(m, 'attack')];
  await Promise.all(clicks.map((i) => combat.handle(i)));
  const current = combat.engine.state.matches[m.id];
  assert.equal(current.actions, 2); // one player action plus one AI action
  assert.ok(clicks.some((i) => i.responses.some((r) => r.content?.includes('out of date'))));
  const outsider = click(current, 'attack', 'stranger');
  await combat.handle(outsider);
  assert.match(outsider.responses[0].content, /not yours/);
  assert.equal(combat.engine.state.matches[m.id].actions, 2);
});

test('collection, equipment, inspect and resume route correctly; unrelated controls are ignored', async () => {
  const { combat, data, interaction } = setup();
  data.stolen[0].ownerId = 'a';
  for (const [name, args] of [['equip', { card: data.stolen[0].id }], ['collection', {}], ['card', { card: data.stolen[0].id }], ['unequip', {}], ['realm', {}], ['battle-help', {}]]) {
    const i = interaction(name, args);
    await combat.handle(i);
    assert.ok(i.responses.length);
    if (i.responses[0].embeds) validatePanel(i.responses[0]);
  }
  await combat.handle(interaction('challenge'));
  const i = interaction('battle'); await combat.handle(i); validatePanel(i.responses[0]);
  assert.equal(await combat.handle(interaction('stats')), false);
});

test('long names and metadata fit the collection and battle embed limits', async () => {
  const { combat, data, interaction } = setup();
  for (const c of data.stolen) {
    c.name = '*'.repeat(120); c.series = '*'.repeat(1000);
    c.metadata = ['*'.repeat(2000)];
  }
  validatePanel(combat.book('g', null, 1));
  for (const c of data.stolen.slice(4)) { c.ownerId = 'a'; combat.engine.equip('g', 'a', c.id); }
  const i = interaction('challenge', { characters: data.stolen.slice(0,4).map((c) => c.id).join(',') });
  await combat.handle(i);
  validatePanel(i.responses[0]);
});
