'use strict';

// Direct UDP client for Gecko in.touch2 spa modules (port 10022).
// Implements the same protocol as geckolib (https://github.com/gazoodle/geckolib):
// HELLO, AVERS, CURCH, SFILE, STATU, APING,
// STATP/STATQ, SPACK, GETWC/SETWC.
//
// Supported packs: inXE, inYT, inYE, inYJ. Their status blocks share the
// same offsets for every value read or written here.

const dgram = require('dgram');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const SPA_PORT = 10022;

const LAYOUT_STANDARD = {
  SetpointG: 1,          // word, raw = degC * 18
  RealSetPointG: 275,
  DisplayedTempG: 277,
  RhWaterTemp: 317,
  UdBL: { pos: 258, bit: 1, mask: 1 },
  UdP1: { pos: 259, bit: 0, mask: 3 },
  UdP2: { pos: 259, bit: 2, mask: 3 },
  BL: { pos: 260, bit: 1, mask: 1 },
  Heat: { pos: 260, bit: 5, mask: 3 },
  P1: { pos: 261, bit: 0, mask: 3 },
  P2: { pos: 261, bit: 2, mask: 3 },
  CheckFlo: { pos: 280, bit: 2, mask: 1 },
  UdLi: 307,
};

// Log version 50: every log offset one lower
const LAYOUT_LOG50 = {
  SetpointG: 1,
  RealSetPointG: 274,
  DisplayedTempG: 276,
  RhWaterTemp: 317,
  UdBL: { pos: 257, bit: 1, mask: 1 },
  UdP1: { pos: 258, bit: 0, mask: 3 },
  UdP2: { pos: 258, bit: 2, mask: 3 },
  BL: { pos: 259, bit: 1, mask: 1 },
  Heat: { pos: 259, bit: 5, mask: 3 },
  P1: { pos: 260, bit: 0, mask: 3 },
  P2: { pos: 260, bit: 2, mask: 3 },
  CheckFlo: { pos: 279, bit: 2, mask: 1 },
  UdLi: 307,
};

const VERIFIED_LOGS = {
  inxe: [51, 52, 53, 54, 55, 56, 57, 58, 60],
  inye: [80, 81, 82, 83],
  inyj: [53, 54, 55, 56, 57, 58, 59],
  inyt: [51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 80, 81, 82, 83],
};

const PACK_TYPES = { inxe: 1, inyt: 10, inye: 10, inyj: 12 };

const UD_PUMP_NAMES = ['OFF', 'LO', 'HI'];
const UD_PUMP_VALUES = { OFF: 0, LO: 1, HI: 2 };
const DEV_PUMP_NAMES = ['OFF', 'HI', 'LO']; // device byte: 1 = high, 2 = low

const WATERCARE_NAMES = ['Away From Home', 'Standard', 'Energy Saving', 'Super Energy Saving', 'Weekender'];

const STEP_TIMEOUT = { HELLO: 3, VERSION: 4, CHANNEL: 4, FILES: 8, BLOCK: 10 };
const STEP_RETRIES = 5;

function getBits(value, bit, mask) {
  return (value >> bit) & mask;
}

function setBits(value, bit, mask, v) {
  return (value & ~(mask << bit) & 0xff) | ((v & mask) << bit);
}

class GeckoClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.host     spa IP address
   * @param {string} opts.clientId persistent client id ("IOS" + uuid)
   * @param {object} opts.log      logger with info/warn/error/debug
   */
  constructor(opts) {
    super();
    this.host = opts.host;
    this.port = opts.port || SPA_PORT;
    this.clientId = opts.clientId || ('IOS' + crypto.randomUUID());
    this.log = opts.log || console;

    this.state = 'IDLE';
    this.stateSince = 0;
    this.attempts = 0;
    this.now = 0;
    this.tickTimer = null;
    this.socket = null;

    this.spaId = null;
    this.spaName = null;
    this.firmware = null;
    this.platform = null;
    this.packType = null;
    this.cfgVer = null;
    this.logVer = null;
    this.layout = null;

    this.block = Buffer.alloc(1024);
    this.blockLoaded = false;
    this.watercare = null;

    this.seqProto = 0;
    this.seqCmd = 191;
    this.lastPingSent = -100;
    this.lastPingRx = 0;
    this.lastRx = 0;
    this.lastFullRefresh = 0;
    this.lastWcPoll = 0;
    this.pingLost = false;
    this.segments = null;
    this.nextSegment = 0;
    this.cmdQueue = [];
    this.cmdPending = null;
  }

  // ---------------------------------------------------------------- lifecycle
  start() {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this._tick(), 1000);
    this._connect('startup');
  }

  stop() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this._closeSocket();
    this.state = 'IDLE';
  }

  get connected() {
    return this.state === 'RUNNING' && this.blockLoaded && !this.pingLost;
  }

  // ---------------------------------------------------------------- network
  _openSocket() {
    this._closeSocket();
    const sock = dgram.createSocket('udp4');
    sock.on('message', (msg, rinfo) => {
      if (rinfo.address !== this.host) return;
      this.lastRx = this.now;
      this._onDatagram(msg);
    });
    sock.on('error', (err) => this.log.warn(`UDP socket error: ${err.message}`));
    sock.bind(0);
    this.socket = sock;
  }

  _closeSocket() {
    if (this.socket) {
      try { this.socket.close(); } catch (e) { /* already closed */ }
    }
    this.socket = null;
  }

  _send(buf) {
    if (!this.socket) return;
    this.log.debug(`TX ${buf.toString('latin1').replace(/[^\x20-\x7e]/g, '.')}`);
    this.socket.send(buf, this.port, this.host);
  }

  _sendPacket(datas) {
    this._send(Buffer.concat([
      Buffer.from(`<PACKT><SRCCN>${this.clientId}</SRCCN><DESCN>${this.spaId}</DESCN><DATAS>`, 'latin1'),
      datas,
      Buffer.from('</DATAS></PACKT>', 'latin1'),
    ]));
  }

  _verb(verb, ...parts) {
    return Buffer.concat([Buffer.from(verb, 'latin1'), ...parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p)))]);
  }

  _onDatagram(buf) {
    let rest = buf;
    for (;;) {
      const hs = rest.indexOf('<HELLO>');
      const ps = rest.indexOf('<PACKT>');
      if (hs < 0 && ps < 0) return;
      if (hs >= 0 && (ps < 0 || hs < ps)) {
        const he = rest.indexOf('</HELLO>', hs);
        if (he < 0) return;
        this._onHello(rest.subarray(hs + 7, he).toString('latin1'));
        rest = rest.subarray(he + 8);
      } else {
        const pe = rest.indexOf('</DATAS></PACKT>', ps);
        if (pe < 0) return;
        const ds = rest.indexOf('<DATAS>', ps);
        if (ds >= 0 && ds < pe) this._onPacket(rest.subarray(ds + 7, pe));
        rest = rest.subarray(pe + 16);
      }
    }
  }

  _onPacket(datas) {
    const verb = datas.subarray(0, 5).toString('latin1');
    const rest = datas.subarray(5);
    this.log.debug(`RX ${verb} (${rest.length} bytes)`);
    switch (verb) {
      case 'APING': this._onPing(); break;
      case 'SVERS': this._onVersion(rest); break;
      case 'CHCUR': this._onChannel(rest); break;
      case 'FILES': this._onFiles(rest); break;
      case 'STATV': this._onStatusSegment(rest); break;
      case 'STATP': this._onPartialStatus(rest); break;
      case 'PACKS': this._onPackCommandAck(); break;
      case 'WCGET':
      case 'WCSET': this._onWatercare(rest); break;
      case 'WCERR': this.log.warn('Spa reported a watercare error'); break;
      case 'RFERR':
        this.log.warn('Spa reported RFERR: the home module cannot reach the spa pack');
        break;
      default: this.log.debug(`Unhandled verb ${verb}`);
    }
  }

  // ---------------------------------------------------------------- state machine
  _setState(s) {
    if (this.state !== s) this.log.debug(`State ${this.state} -> ${s}`);
    this.state = s;
    this.stateSince = this.now;
    this.attempts = 0;
  }

  _connect(reason) {
    const wasConnected = this.connected;
    this.log.info(`Connecting to spa at ${this.host} (${reason})`);
    this.blockLoaded = false;
    this.cmdQueue.forEach((c) => c.reject(new Error('reconnecting')));
    this.cmdQueue = [];
    if (this.cmdPending) this.cmdPending.reject(new Error('reconnecting'));
    this.cmdPending = null;
    this.pingLost = false;
    this._openSocket();
    this._setState('HELLO');
    if (wasConnected) this.emit('disconnected');
    this._stepSend();
  }

  _stepSend() {
    this.attempts += 1;
    this.stateSince = this.now;
    switch (this.state) {
      case 'HELLO': this._send(Buffer.from('<HELLO>1</HELLO>')); break;
      case 'VERSION': this._sendPacket(this._verb('AVERS', [this._nextSeqProto()])); break;
      case 'CHANNEL': this._sendPacket(this._verb('CURCH', [this._nextSeqProto()])); break;
      case 'FILES': this._sendPacket(this._verb('SFILE', [this._nextSeqProto()])); break;
      case 'BLOCK': this._requestFullBlock(); break;
      default: break;
    }
  }

  _onHello(content) {
    if (content === '1' || content.startsWith('IOS') || content.startsWith('AND')) return;
    const bar = content.indexOf('|');
    this.spaId = bar >= 0 ? content.slice(0, bar) : content;
    this.spaName = bar >= 0 ? content.slice(bar + 1) : 'Spa';
    if (this.state === 'HELLO') {
      this.log.info(`Found spa "${this.spaName}" (${this.spaId})`);
      this._setState('VERSION');
      this._stepSend();
    }
  }

  _onVersion(rest) {
    if (rest.length >= 8) {
      this.firmware = `EN ${rest.readUInt16BE(0)} v${rest[2]}.${rest[3]} / CO ${rest.readUInt16BE(4)} v${rest[6]}.${rest[7]}`;
    }
    if (this.state === 'VERSION') { this._setState('CHANNEL'); this._stepSend(); }
  }

  _onChannel(rest) {
    if (rest.length >= 2) this.rf = { channel: rest[0], signal: rest[1] };
    if (this.state === 'CHANNEL') { this._setState('FILES'); this._stepSend(); }
  }

  _onFiles(rest) {
    const parts = rest.toString('latin1').split(',').filter((p) => p.length > 0);
    if (parts.length < 2) {
      this.log.warn(`Bad FILES response: ${rest.toString('latin1')}`);
      return;
    }
    const cm = parts[0].match(/^(.*?)_C(\d+)/);
    const sm = parts[1].match(/^(.*?)_S(\d+)/);
    if (!cm || !sm) {
      this.log.warn(`Bad FILES response: ${parts.join(',')}`);
      return;
    }
    this.platform = cm[1];
    this.cfgVer = parseInt(cm[2], 10);
    this.logVer = parseInt(sm[2], 10);
    const fam = this.platform.toLowerCase().slice(0, 4);
    this.packType = PACK_TYPES[fam];
    this.log.info(`Spa pack: ${this.platform} config ${this.cfgVer} log ${this.logVer}`);

    if (this.packType === undefined) {
      this._setState('UNSUPPORTED');
      this.log.error(`Unsupported spa pack "${this.platform}". Report this line to the plugin author.`);
      this.emit('unsupported', this.platform);
      return;
    }
    this.layout = this.logVer === 50 ? LAYOUT_LOG50 : LAYOUT_STANDARD;
    if (this.logVer !== 50 && !(VERIFIED_LOGS[fam] || []).includes(this.logVer)) {
      this.log.warn(`Log version ${this.logVer} for ${this.platform} is not in the verified list. ` +
        'Using the standard layout. Compare the temperature with the spa keypad.');
    }
    if (this.state === 'FILES') { this._setState('BLOCK'); this._stepSend(); }
  }

  _requestFullBlock() {
    this.lastFullRefresh = this.now;
    this.segments = [];
    this.nextSegment = 0;
    const range = Buffer.alloc(4);
    range.writeUInt16BE(0, 0);
    range.writeUInt16BE(1024, 2);
    this._sendPacket(this._verb('STATU', [this._nextSeqProto()], range));
  }

  _onStatusSegment(rest) {
    if (rest.length < 3 || this.segments === null) return;
    const idx = rest[0];
    const nxt = rest[1];
    const len = rest[2];
    if (idx !== this.nextSegment) {
      this.log.debug(`Out-of-order segment ${idx} (wanted ${this.nextSegment})`);
      return;
    }
    this.segments.push(Buffer.from(rest.subarray(3, 3 + len)));
    this.nextSegment = nxt;
    if (nxt !== 0) return;

    const all = Buffer.concat(this.segments);
    this.segments = null;
    all.copy(this.block, 0, 0, Math.min(all.length, this.block.length));
    this.blockLoaded = true;
    this.lastFullRefresh = this.now;
    if (this.state === 'BLOCK') {
      this._setState('RUNNING');
      this.lastPingRx = this.now;
      this.lastPingSent = this.now - 100;
      this.log.info(`Connected to ${this.spaName}`);
      this._requestWatercare();
      this.emit('connected');
    }
    this._changed();
  }

  _onPartialStatus(rest) {
    if (rest.length < 1) return;
    this._sendPacket(this._verb('STATQ', [this._nextSeqCmd()]));
    const count = rest[0];
    for (let i = 0; i < count; i++) {
      const o = 1 + i * 4;
      if (o + 3 >= rest.length) break;
      const pos = rest.readUInt16BE(o);
      if (pos + 1 < this.block.length) {
        this.block[pos] = rest[o + 2];
        this.block[pos + 1] = rest[o + 3];
      }
    }
    this._changed();
  }

  _onPing() {
    this.lastPingRx = this.now;
    if (this.pingLost && this.state === 'RUNNING') {
      this.pingLost = false;
      this.log.info('Spa answering again. Re-reading the full status block.');
      this._requestFullBlock();
      this._requestWatercare();
      this.emit('connected');
    }
  }

  _requestWatercare() {
    if (this.state !== 'RUNNING') return;
    this.lastWcPoll = this.now;
    this._sendPacket(this._verb('GETWC', [this._nextSeqProto()]));
  }

  _onWatercare(rest) {
    if (rest.length >= 1) {
      this.watercare = rest[0] % 5;
      this._changed();
    }
    if (this.cmdPending && this.cmdPending.kind === 'WC') this._completePending();
  }

  _changed() {
    if (this.blockLoaded) this.emit('update', this.getStatus());
  }

  // ---------------------------------------------------------------- tick
  _tick() {
    this.now += 1;
    if (this.state === 'IDLE' || this.state === 'UNSUPPORTED') return;

    if (this.state === 'WAIT') {
      if (this.now - this.stateSince >= 30) this._connect('retry');
      return;
    }

    if (this.state !== 'RUNNING') {
      if (this.now - this.stateSince >= (STEP_TIMEOUT[this.state] || 4)) {
        if (this.attempts >= STEP_RETRIES) {
          this.log.warn(`No answer to ${this.state} after ${this.attempts} tries. Retrying in 30s.`);
          if (this.state === 'HELLO' && this.lastRx === 0) {
            this.log.warn(`Nothing received from ${this.host}:${this.port}. ` +
              'Check the spa IP, and that Homebridge shares a subnet with the spa (Docker: use host networking).');
          }
          this.state = 'WAIT';
          this.stateSince = this.now;
        } else {
          this._stepSend();
        }
      }
      return;
    }

    // RUNNING
    if (this.now - this.lastPingSent >= 2) {
      this.lastPingSent = this.now;
      this._sendPacket(Buffer.from('APING'));
    }
    if (!this.pingLost && this.now - this.lastPingRx > 15) {
      this.pingLost = true;
      this.log.warn('Spa not answering pings for 15s');
      this.emit('disconnected');
    }
    if (this.now - this.lastPingRx > 60) {
      this.log.warn('Spa stopped answering pings for 60s. Reconnecting.');
      this._connect('ping timeout');
      return;
    }
    if (this.pingLost) return;

    if (this.cmdPending && this.now - this.cmdPending.sentAt >= 2) {
      if (this.cmdPending.tries >= 4) {
        const c = this.cmdPending;
        this.cmdPending = null;
        this.log.warn(`Spa did not accept ${c.label}`);
        c.reject(new Error(`Spa did not accept ${c.label}`));
        this._pumpCommands();
      } else {
        this._sendPending();
      }
    }
    if (this.now - this.lastWcPoll >= 60) this._requestWatercare();
    if (this.now - this.lastFullRefresh >= 600 && !this.cmdPending) this._requestFullBlock();
  }

  // ---------------------------------------------------------------- sequences
  _nextSeqProto() {
    if (this.seqProto >= 191) this.seqProto = 0;
    this.seqProto += 1;
    return this.seqProto;
  }

  _nextSeqCmd() {
    if (this.seqCmd >= 255) this.seqCmd = 191;
    this.seqCmd += 1;
    return this.seqCmd;
  }

  // ---------------------------------------------------------------- commands
  _queue(cmd) {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error('Spa not connected'));
        return;
      }
      cmd.resolve = resolve;
      cmd.reject = reject;
      this.cmdQueue.push(cmd);
      this._pumpCommands();
    });
  }

  _pumpCommands() {
    if (this.cmdPending || this.cmdQueue.length === 0) return;
    this.cmdPending = this.cmdQueue.shift();
    this.cmdPending.tries = 0;
    this._sendPending();
  }

  _sendPending() {
    const c = this.cmdPending;
    if (!c) return;
    c.tries += 1;
    c.sentAt = this.now;
    if (c.kind === 'SET') {
      // Bit fields share bytes: build the byte from the CURRENT block at send time.
      if (c.field) {
        c.value = setBits(this.block[c.field.pos], c.field.bit, c.field.mask, c.fieldValue);
      }
      const data = Buffer.alloc(c.len);
      if (c.len === 2) data.writeUInt16BE(c.value & 0xffff, 0); else data[0] = c.value & 0xff;
      const head = Buffer.from([this._nextSeqCmd(), this.packType, 5 + c.len, 70, this.cfgVer & 0xff, this.logVer & 0xff, 0, 0]);
      head.writeUInt16BE(c.pos, 6);
      this._sendPacket(this._verb('SPACK', head, data));
    } else {
      this._sendPacket(this._verb('SETWC', [this._nextSeqProto(), c.value]));
    }
    this.log.debug(`Sent ${c.label} (try ${c.tries})`);
  }

  _onPackCommandAck() {
    const c = this.cmdPending;
    if (!c || c.kind !== 'SET') return;
    if (c.len === 2) this.block.writeUInt16BE(c.value & 0xffff, c.pos);
    else this.block[c.pos] = c.value & 0xff;
    this._completePending();
    this._changed();
  }

  _completePending() {
    const c = this.cmdPending;
    this.cmdPending = null;
    this.log.info(`Spa accepted ${c.label}`);
    c.resolve();
    this._pumpCommands();
  }

  _setField(field, value, label) {
    return this._queue({ kind: 'SET', pos: field.pos, len: 1, value: 0, field, fieldValue: value, label });
  }

  setSetpoint(celsius) {
    const c = Math.max(15, Math.min(40, Number(celsius)));
    const raw = Math.round(c * 18);
    return this._queue({ kind: 'SET', pos: this.layout.SetpointG, len: 2, value: raw, label: `setpoint ${c.toFixed(1)}C` });
  }

  setPump(n, state) {
    let s = String(state || 'OFF').toUpperCase();
    if (s === 'LOW') s = 'LO';
    if (s === 'HIGH') s = 'HI';
    if (!(s in UD_PUMP_VALUES)) return Promise.reject(new Error(`Bad pump state ${state}`));
    const field = n === 1 ? this.layout.UdP1 : this.layout.UdP2;
    return this._setField(field, UD_PUMP_VALUES[s], `pump ${n} ${s}`);
  }

  setLights(on) {
    return this._queue({ kind: 'SET', pos: this.layout.UdLi, len: 1, value: on ? 1 : 0, label: `lights ${on ? 'ON' : 'OFF'}` });
  }

  setBlower(on) {
    return this._setField(this.layout.UdBL, on ? 1 : 0, `blower ${on ? 'ON' : 'OFF'}`);
  }

  setWatercare(mode) {
    const m = Math.max(0, Math.min(4, Math.round(Number(mode))));
    return this._queue({ kind: 'WC', value: m, label: `watercare ${WATERCARE_NAMES[m]}` });
  }

  // ---------------------------------------------------------------- decoded state
  _field(f) {
    return getBits(this.block[f.pos], f.bit, f.mask);
  }

  getStatus() {
    if (!this.blockLoaded) return null;
    const L = this.layout;
    const udP1 = UD_PUMP_NAMES[this._field(L.UdP1)] || 'OFF';
    const udP2 = UD_PUMP_NAMES[this._field(L.UdP2)] || 'OFF';
    return {
      waterTemp: this.block.readUInt16BE(L.DisplayedTempG) / 18,
      setpoint: this.block.readUInt16BE(L.SetpointG) / 18,
      realSetpoint: this.block.readUInt16BE(L.RealSetPointG) / 18,
      heating: this._field(L.Heat) !== 0,
      pump1: DEV_PUMP_NAMES[this._field(L.P1)] || 'OFF',
      pump2: DEV_PUMP_NAMES[this._field(L.P2)] || 'OFF',
      pump1Demand: udP1,
      pump2Demand: udP2,
      lights: this.block[L.UdLi] !== 0,
      blower: this._field(L.BL) !== 0,
      blowerDemand: this._field(L.UdBL) !== 0,
      checkFlow: this._field(L.CheckFlo) !== 0,
      watercare: this.watercare,
      watercareName: this.watercare === null ? null : WATERCARE_NAMES[this.watercare],
    };
  }
}

module.exports = { GeckoClient, WATERCARE_NAMES, getBits, setBits };
