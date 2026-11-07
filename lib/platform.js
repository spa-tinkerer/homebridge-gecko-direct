'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { GeckoClient, WATERCARE_NAMES } = require('./gecko-client');

const PLUGIN_NAME = 'homebridge-gecko-direct';
const PLATFORM_NAME = 'GeckoSpaDirect';
const VERSION = require('../package.json').version;

const PUMP_TO_SPEED = { OFF: 0, LO: 50, HI: 100 };

class GeckoSpaPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.hap = api.hap;
    this.cached = new Map();   // uuid -> PlatformAccessory
    this.handlers = [];        // functions(status) called on every update
    this.pumpTimers = {};
    this.pumpDesired = {};

    this.spaIp = String(this.config.spaIp || '').trim();
    this.baseName = this.config.name || 'Spa';
    this.pumpCount = Math.max(0, Math.min(2, Number(this.config.pumps ?? 2)));
    this.hasBlower = this.config.blower === true;
    this.hasWatercare = this.config.watercareSwitches !== false;
    this.minSetpoint = Number(this.config.minSetpoint ?? 20);
    this.maxSetpoint = Number(this.config.maxSetpoint ?? 40);

    if (!this.spaIp) {
      this.log.error('Set "spaIp" in the plugin settings. The plugin will stay idle until then.');
      return;
    }

    const debug = this.config.debug === true;
    const clientLog = {
      info: (m) => this.log.info(m),
      warn: (m) => this.log.warn(m),
      error: (m) => this.log.error(m),
      debug: (m) => (debug ? this.log.info(`[debug] ${m}`) : this.log.debug(m)),
    };
    this.client = new GeckoClient({ host: this.spaIp, clientId: this._clientId(), log: clientLog });

    this.api.on('didFinishLaunching', () => {
      this._buildAccessories();
      this.client.on('update', (s) => this._push(s));
      this.client.on('disconnected', () => this._markNoResponse());
      this.client.on('connected', () => {
        const s = this.client.getStatus();
        if (s) this._push(s);
      });
      this.client.start();
    });
    this.api.on('shutdown', () => this.client && this.client.stop());
  }

  configureAccessory(accessory) {
    this.cached.set(accessory.UUID, accessory);
  }

  // ------------------------------------------------------------------ helpers
  _clientId() {
    const file = path.join(this.api.user.storagePath(), 'gecko-direct.json');
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.clientId) return saved.clientId;
    } catch (e) { /* first run */ }
    const id = 'IOS' + crypto.randomUUID();
    try { fs.writeFileSync(file, JSON.stringify({ clientId: id }, null, 2)); } catch (e) {
      this.log.warn(`Could not save client id: ${e.message}`);
    }
    return id;
  }

  _commFailure() {
    return new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  _status() {
    if (!this.client || !this.client.connected) throw this._commFailure();
    return this.client.getStatus();
  }

  // Send a command; wait up to 2.5 s so the Home app sees failures, never longer.
  async _run(promise) {
    promise.catch((e) => this.log.warn(e.message));
    const timeout = new Promise((resolve) => setTimeout(resolve, 2500));
    try {
      await Promise.race([promise, timeout]);
    } catch (e) {
      throw this._commFailure();
    }
  }

  _accessory(key, displayName, category) {
    const uuid = this.hap.uuid.generate(`${PLUGIN_NAME}:${this.spaIp}:${key}`);
    let acc = this.cached.get(uuid);
    if (!acc) {
      acc = new this.api.platformAccessory(displayName, uuid, category);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
      this.log.info(`Added accessory: ${displayName}`);
    }
    this.cached.delete(uuid);
    acc.getService(this.hap.Service.AccessoryInformation)
      .setCharacteristic(this.hap.Characteristic.Manufacturer, 'Gecko Alliance')
      .setCharacteristic(this.hap.Characteristic.Model, 'in.touch2')
      .setCharacteristic(this.hap.Characteristic.SerialNumber, `${this.spaIp}-${key}`)
      .setCharacteristic(this.hap.Characteristic.FirmwareRevision, VERSION);
    return acc;
  }

  _service(acc, type, name, subtype) {
    const svc = (subtype ? acc.getServiceById(type, subtype) : acc.getService(type)) ||
      acc.addService(type, name, subtype);
    svc.setCharacteristic(this.hap.Characteristic.Name, name);
    if (this.hap.Characteristic.ConfiguredName) {
      if (!svc.testCharacteristic(this.hap.Characteristic.ConfiguredName)) {
        svc.addOptionalCharacteristic(this.hap.Characteristic.ConfiguredName);
      }
      svc.setCharacteristic(this.hap.Characteristic.ConfiguredName, name);
    }
    return svc;
  }

  // ------------------------------------------------------------------ accessories
  _buildAccessories() {
    const { Service, Characteristic: C, Categories } = this.hap;

    // Thermostat ----------------------------------------------------------
    {
      const acc = this._accessory('thermostat', this.baseName, Categories.THERMOSTAT);
      const svc = this._service(acc, Service.Thermostat, this.baseName);
      svc.getCharacteristic(C.CurrentTemperature)
        .setProps({ minValue: 0, maxValue: 50, minStep: 0.1 })
        .onGet(() => round1(this._status().waterTemp));
      svc.getCharacteristic(C.TargetTemperature)
        .setProps({ minValue: this.minSetpoint, maxValue: this.maxSetpoint, minStep: 0.5 })
        .onGet(() => clamp(round05(this._status().setpoint), this.minSetpoint, this.maxSetpoint))
        .onSet(async (v) => { this._status(); await this._run(this.client.setSetpoint(v)); });
      svc.getCharacteristic(C.CurrentHeatingCoolingState)
        .setProps({ validValues: [C.CurrentHeatingCoolingState.OFF, C.CurrentHeatingCoolingState.HEAT] })
        .onGet(() => (this._status().heating ? C.CurrentHeatingCoolingState.HEAT : C.CurrentHeatingCoolingState.OFF));
      svc.getCharacteristic(C.TargetHeatingCoolingState)
        .setProps({ validValues: [C.TargetHeatingCoolingState.HEAT] })
        .onGet(() => { this._status(); return C.TargetHeatingCoolingState.HEAT; })
        .onSet(() => { /* the spa always heats to its setpoint */ });
      const units = this.config.units === 'F'
        ? C.TemperatureDisplayUnits.FAHRENHEIT : C.TemperatureDisplayUnits.CELSIUS;
      svc.getCharacteristic(C.TemperatureDisplayUnits).onGet(() => units).onSet(() => {});
      this.thermo = svc;
      this.handlers.push((s) => {
        svc.updateCharacteristic(C.CurrentTemperature, round1(s.waterTemp));
        svc.updateCharacteristic(C.TargetTemperature, clamp(round05(s.setpoint), this.minSetpoint, this.maxSetpoint));
        svc.updateCharacteristic(C.CurrentHeatingCoolingState,
          s.heating ? C.CurrentHeatingCoolingState.HEAT : C.CurrentHeatingCoolingState.OFF);
        svc.updateCharacteristic(C.TargetHeatingCoolingState, C.TargetHeatingCoolingState.HEAT);
      });
    }

    // Pumps ----------------------------------------------------------------
    this.pumpServices = {};
    for (let n = 1; n <= this.pumpCount; n++) {
      const name = `${this.baseName} Pump ${n}`;
      const acc = this._accessory(`pump${n}`, name, Categories.FAN);
      const svc = this._service(acc, Service.Fanv2, name);
      svc.getCharacteristic(C.Active)
        .onGet(() => (this._pumpShown(n) === 'OFF' ? 0 : 1))
        .onSet((v) => {
          this._status();
          if (v === 0) this._schedulePump(n, 'OFF', 'active');
          else if (this._pumpShown(n) === 'OFF') this._schedulePump(n, 'HI', 'active');
        });
      svc.getCharacteristic(C.RotationSpeed)
        .setProps({ minValue: 0, maxValue: 100, minStep: 50 })
        .onGet(() => PUMP_TO_SPEED[this._pumpShown(n)])
        .onSet((v) => {
          this._status();
          this._schedulePump(n, v <= 0 ? 'OFF' : v <= 50 ? 'LO' : 'HI', 'speed');
        });
      this.pumpServices[n] = svc;
      this.handlers.push(() => this._pushPump(n));
    }

    // Lights ---------------------------------------------------------------
    {
      const name = `${this.baseName} Lights`;
      const acc = this._accessory('lights', name, Categories.LIGHTBULB);
      const svc = this._service(acc, Service.Lightbulb, name);
      svc.getCharacteristic(C.On)
        .onGet(() => this._status().lights)
        .onSet(async (v) => { this._status(); await this._run(this.client.setLights(!!v)); });
      this.handlers.push((s) => svc.updateCharacteristic(C.On, s.lights));
    }

    // Blower (optional) ----------------------------------------------------
    if (this.hasBlower) {
      const name = `${this.baseName} Blower`;
      const acc = this._accessory('blower', name, Categories.SWITCH);
      const svc = this._service(acc, Service.Switch, name);
      svc.getCharacteristic(C.On)
        .onGet(() => { const s = this._status(); return s.blower || s.blowerDemand; })
        .onSet(async (v) => { this._status(); await this._run(this.client.setBlower(!!v)); });
      this.handlers.push((s) => svc.updateCharacteristic(C.On, s.blower || s.blowerDemand));
    }

    // Watercare (one switch per mode, behaves like radio buttons) -----------
    if (this.hasWatercare) {
      const name = `${this.baseName} Watercare`;
      const acc = this._accessory('watercare', name, Categories.SWITCH);
      const switches = WATERCARE_NAMES.map((label, i) => {
        const svc = this._service(acc, Service.Switch, label, `wc${i}`);
        svc.getCharacteristic(C.On)
          .onGet(() => this._status().watercare === i)
          .onSet(async (v) => {
            const s = this._status();
            if (v) {
              await this._run(this.client.setWatercare(i));
            } else if (s.watercare === i) {
              // A mode can't be switched off, only replaced by another mode
              setTimeout(() => svc.updateCharacteristic(C.On, true), 300);
            }
          });
        return svc;
      });
      this.handlers.push((s) => switches.forEach((svc, i) => svc.updateCharacteristic(C.On, s.watercare === i)));
    }

    // Remove accessories that are no longer configured
    const stale = [...this.cached.values()];
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      stale.forEach((a) => this.log.info(`Removed accessory: ${a.displayName}`));
    }
    this.cached.clear();
  }

  // ------------------------------------------------------------------ pumps
  // A pump shows its demand when one is set, otherwise what it is actually
  // doing (so a filter cycle shows the pump running at low speed).
  _pumpShown(n) {
    const s = this._status();
    if (this.pumpDesired[n]) return this.pumpDesired[n];
    const demand = n === 1 ? s.pump1Demand : s.pump2Demand;
    const actual = n === 1 ? s.pump1 : s.pump2;
    return demand !== 'OFF' ? demand : actual;
  }

  // The Home app often sends Active and RotationSpeed together. Wait 300 ms
  // and send one command with the final value; a speed beats an on/off tap.
  _schedulePump(n, state, source) {
    const prev = this.pumpDesired[n];
    if (!(source === 'active' && state !== 'OFF' && prev && this.pumpTimers[n])) {
      this.pumpDesired[n] = state;
    }
    clearTimeout(this.pumpTimers[n]);
    this.pumpTimers[n] = setTimeout(() => {
      const want = this.pumpDesired[n];
      this.pumpTimers[n] = null;
      this.client.setPump(n, want)
        .catch((e) => this.log.warn(e.message))
        .finally(() => {
          this.pumpDesired[n] = null;
          this._pushPump(n);
        });
    }, 300);
  }

  _pushPump(n) {
    const svc = this.pumpServices && this.pumpServices[n];
    if (!svc || !this.client.connected) return;
    const shown = this._pumpShown(n);
    svc.updateCharacteristic(this.hap.Characteristic.Active, shown === 'OFF' ? 0 : 1);
    svc.updateCharacteristic(this.hap.Characteristic.RotationSpeed, PUMP_TO_SPEED[shown]);
  }

  // ------------------------------------------------------------------ updates
  _push(s) {
    if (!s) return;
    if (s.checkFlow && !this.lastCheckFlow) this.log.warn('Spa reports CHECK FLOW');
    this.lastCheckFlow = s.checkFlow;
    for (const h of this.handlers) {
      try { h(s); } catch (e) { this.log.debug(`update skipped: ${e.message}`); }
    }
  }

  _markNoResponse() {
    if (!this.thermo) return;
    try {
      this.thermo.updateCharacteristic(this.hap.Characteristic.CurrentTemperature, this._commFailure());
    } catch (e) { /* older Homebridge: Home app will show No Response on next read */ }
  }
}

function round1(v) { return Math.round(v * 10) / 10; }
function round05(v) { return Math.round(v * 2) / 2; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

module.exports = { GeckoSpaPlatform, PLUGIN_NAME, PLATFORM_NAME };
