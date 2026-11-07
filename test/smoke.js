'use strict';

// Smoke test: the plugin loads, registers its platform, and stays idle
// (no network, no files written) until a spa IP is configured.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-gecko-'));
const registered = [];
const listeners = [];
const logs = [];

const api = {
  hap: {},
  user: { storagePath: () => storage },
  on: (event) => listeners.push(event),
  registerPlatform: (plugin, platform, ctor) => registered.push({ plugin, platform, ctor }),
};

require('../index.js')(api);
assert.strictEqual(registered.length, 1, 'registers exactly one platform');
assert.strictEqual(registered[0].plugin, 'homebridge-gecko-direct');
assert.strictEqual(registered[0].platform, 'GeckoSpaDirect');

const log = (m) => logs.push(m);
log.info = log; log.warn = log; log.error = log; log.debug = log;

const schema = require('../config.schema.json');
assert.strictEqual(schema.pluginAlias, registered[0].platform, 'schema alias matches platform name');

const Platform = registered[0].ctor;
const p = new Platform(log, { platform: 'GeckoSpaDirect' }, api);
assert.ok(!p.client, 'no client created without spaIp');
assert.strictEqual(listeners.length, 0, 'no lifecycle hooks without spaIp');
assert.deepStrictEqual(fs.readdirSync(storage), [], 'nothing written to storage without spaIp');
assert.ok(logs.some((m) => /spaIp/.test(m)), 'tells the user to set spaIp');

fs.rmSync(storage, { recursive: true, force: true });
console.log('smoke test passed');
