'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const discord = require('discord.js');
const { DropTracker, badgeLabels } = require('./drop-tracker');

// Run the real entry point and Discord.js builders with mocked transport and
// storage. Never log in or touch a real data.json.
function boot({ canDelete = true, failHistory = false } = {}) {
  let client, tracker, saved;
  const sent = [], removed = [], timers = [];
  const history = new Map();
  const channel = {
    isTextBased: () => true, isThread: () => false,
    permissionsFor: () => ({ has: () => canDelete }),
    send: async (payload) => { sent.push(payload); },
    messages: {
      fetch: async (options) => {
        if (options.message) {
          if (!history.has(options.message)) throw new Error('Unknown Message');
          return history.get(options.message);
        }
        if (failHistory) throw new Error('Cannot read history');
        return new Map(history);
      },
      delete: async (id) => {
        const message = history.get(id);
        removed.push(id);
        history.delete(id);
        client.emit('messageDelete', message);
      },
    },
  };
  class MockClient extends EventEmitter {
    constructor() {
      super(); client = this;
      this.user = { id: 'bot' };
      this.channels = { fetch: async () => channel };
    }
    login() { return Promise.resolve(); }
  }
  class TestTracker extends DropTracker {
    constructor(options) {
      super({ ...options, schedule: (_fn, ms) => { timers.push(ms); return 1; },
        unschedule: () => {}, sleep: async () => {}, log: () => {} });
      tracker = this;
    }
  }
  const context = {
    require: (id) => {
      if (id === 'discord.js') return { ...discord, Client: MockClient };
      if (id === './drop-tracker') return { DropTracker: TestTracker, badgeLabels };
      if (id === 'dotenv') return { config() {} };
      if (id === 'fs') return {
        readFileSync: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
        writeFileSync: (_file, value) => { saved = JSON.parse(value); }, renameSync() {},
      };
      return require(id);
    },
    __dirname, console: { log() {}, error() {} },
    process: { env: { DISCORD_TOKEN: 'test-placeholder' }, on() {}, exit() { throw new Error('Unexpected exit'); } },
    setInterval() {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8'), context);
  const createdTimestamp = Date.now();
  const base = { channelId: 'channel', guildId: 'guild', createdTimestamp, embeds: [] };
  const drop = { ...base, id: '100', author: { id: '646937666251915264' }, content: '<@123> is dropping 3 cards!' };
  const info = { ...base, id: '101', author: { id: '1274445226064220273' }, reference: { messageId: '100' },
    embeds: [{ description: '`1` ♡ 0 · **Lulu** · Gundam\n`2` ♡ 1 · **Giant Deer** · Campfire Cooking\n`3` ♡ 0 · **Bentaro Kiyara** · Happy Kiss!' }] };
  const claim = { ...base, id: '102', author: drop.author,
    content: '<@123> took the **Giant Deer** card `v817zd7`! Great, it\'s in **excellent** condition!' };
  for (const message of [drop, info, claim]) history.set(message.id, message);
  return { client, tracker, sent, removed, timers, drop, info, claim, saved: () => saved,
    list: (events) => context.listView({ cards: context.aggregate(events), page: 0, sort: 'date' }),
  };
}

test('entry point reads claim history, announces and cleans up the linked Karibbit reply', async () => {
  const app = boot();
  app.client.emit('messageCreate', app.drop);
  app.client.emit('messageCreate', { ...app.info, embeds: [] });
  app.client.emit('messageUpdate', {}, app.info);
  assert.equal(app.timers.length, 1);
  assert.ok(app.timers[0] > 59_000 && app.timers[0] <= 60_000);
  // Claim intentionally not emitted live: history verification must find it.
  await app.tracker.finish('100');
  assert.deepEqual(app.removed, ['100', '101']);
  assert.equal(app.sent[0].content, 'Karutake stole **Lulu**, **Bentaro Kiyara**');
  assert.equal(app.sent[0].allowedMentions.parse.length, 0);
  assert.deepEqual(app.saved().stolen.map((c) => c.name), ['Lulu', 'Bentaro Kiyara']);
});

test('entry point leaves unrelated Karuta and Karibbit messages untouched', () => {
  const app = boot();
  app.client.emit('messageCreate', app.claim);
  app.client.emit('messageCreate', app.info);
  assert.equal(app.tracker.drops.size, 0);
  assert.equal(app.removed.length, 0);
});

test('entry point requires history access and delete permission before collecting', async () => {
  for (const options of [{ canDelete: false }, { failHistory: true }]) {
    const app = boot(options);
    app.client.emit('messageCreate', app.drop);
    app.client.emit('messageCreate', app.info);
    await app.tracker.finish('100');
    assert.equal(app.removed.length, 0);
    assert.equal(app.sent.length, 0);
    assert.equal(app.saved(), undefined);
  }
});

test('badges are saved with collected cards and shown in the collection', async () => {
  const app = boot();
  app.info.embeds[0].description = app.info.embeds[0].description.replace('· Gundam',
    '· Gundam · <:k_sp:123> · <a:k_e8:124> · <:future_badge:125>');
  app.client.emit('messageCreate', app.drop);
  await app.tracker.finish('100');
  const events = app.saved().stolen;
  assert.deepEqual(events[0].metadata, ['<:k_sp:123>', '<a:k_e8:124>', '<:future_badge:125>']);
  const description = app.list(events).embeds[0].toJSON().description;
  assert.match(description, /Single print \(SP\)/);
  assert.match(description, /Edition 8/);
  assert.ok(description.includes('future\\_badge'));
  assert.equal(events[0].series, 'Gundam');
});
