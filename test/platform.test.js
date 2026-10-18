'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

class Char {
  constructor(name) {
    this.name = name;
    this.get = () => this.name;
    this.set = null;
    this.value = undefined;
  }
  onGet(fn) { this.get = fn; return this; }
  onSet(fn) { this.set = fn; return this; }
  setProps() { return this; }
  updateValue(value) { this.value = value; return this; }
}

const Characteristic = {
  Active: Object.assign(new Char('Active'), { ACTIVE: 1, INACTIVE: 0 }),
  RotationSpeed: new Char('RotationSpeed'),
  SwingMode: Object.assign(new Char('SwingMode'), { SWING_ENABLED: 1, SWING_DISABLED: 0 }),
  StatusFault: Object.assign(new Char('StatusFault'), { NO_FAULT: 0, GENERAL_FAULT: 1 }),
  CurrentTemperature: new Char('CurrentTemperature'),
  On: new Char('On'),
  Name: new Char('Name'),
  Manufacturer: new Char('Manufacturer'),
  Model: new Char('Model'),
  SerialNumber: new Char('SerialNumber'),
  FirmwareRevision: new Char('FirmwareRevision'),
};

class ServiceBase {
  constructor(name, subtype) {
    this.name = name;
    this.subtype = subtype;
    this.chars = new Map();
  }
  getCharacteristic(char) {
    if (!this.chars.has(char)) this.chars.set(char, new Char(char.name || 'char'));
    return this.chars.get(char);
  }
  testCharacteristic(char) { return this.chars.has(char); }
  addCharacteristic(char) { const c = new Char(char.name || 'char'); this.chars.set(char, c); return c; }
  updateCharacteristic(char, value) { this.getCharacteristic(char).updateValue(value); return this; }
}

class Fanv2 extends ServiceBase {
  constructor(name) {
    super(name);
    this.getCharacteristic(Characteristic.Active);
    this.getCharacteristic(Characteristic.RotationSpeed);
    this.getCharacteristic(Characteristic.SwingMode);
  }
}
class TemperatureSensor extends ServiceBase {
  constructor(name, subtype) { super(name, subtype); this.getCharacteristic(Characteristic.CurrentTemperature); }
}
class SwitchService extends ServiceBase {
  constructor(name, subtype) { super(name, subtype); this.getCharacteristic(Characteristic.On); }
}
class AccessoryInformation extends ServiceBase {
  constructor() { super('AccessoryInformation'); }
  setCharacteristic() { return this; }
}

const Service = { Fanv2, TemperatureSensor, Switch: SwitchService, AccessoryInformation };

class PlatformAccessory {
  constructor(name, uuid) {
    this.displayName = name;
    this.UUID = uuid;
    this.context = {};
    this.services = [new AccessoryInformation()];
  }
  addService(ServiceType, name, subtype) {
    const service = new ServiceType(name, subtype);
    this.services.push(service);
    return service;
  }
  getService(ServiceType) {
    if (typeof ServiceType === 'string') return this.services.find((service) => service.name === ServiceType);
    return this.services.find((service) => service instanceof ServiceType);
  }
  getServiceById(ServiceType, subtype) {
    return this.services.find((service) => service instanceof ServiceType && service.subtype === subtype);
  }
  removeService(service) {
    const index = this.services.indexOf(service);
    if (index >= 0) this.services.splice(index, 1);
  }
}

const registered = [];
const api = {
  hap: {
    Service,
    Characteristic,
    uuid: { generate: (value) => value },
  },
  platformAccessory: PlatformAccessory,
  on: (event, callback) => { api._launch = callback; },
  registerPlatformAccessories: (plugin, platform, accessories) => registered.push(...accessories),
  updatePlatformAccessories: () => {},
  unregisterPlatformAccessories: () => {},
};

let Platform;
require('../index')({
  registerPlatform: (plugin, platform, constructor) => { Platform = constructor; },
});

test('platform creates a fan plus labeled switch accessories', async (t) => {
  registered.length = 0;
  const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const config = {
    host: '192.0.2.10',
    port: 6607,
    authKey: Buffer.alloc(16).toString('base64'),
    deviceKey: '001122334455',
    productKey: 'p11vkW',
    accessoryName: 'Test Fan',
    temperatureUnit: 'F',
    displaySwitch: true,
    soundSwitch: true,
    modeSwitches: true,
    discover: false,
    pollInterval: 15,
  };
  const platform = new Platform(log, config, api);
  platform.resolveHost = async () => config.host;
  platform.refresh = async () => {};
  api._launch();
  clearTimeout(platform.initialTimer);
  clearInterval(platform.pollTimer);
  t.after(() => {
    clearTimeout(platform.initialTimer);
    clearInterval(platform.pollTimer);
    clearTimeout(platform.speedTimer);
    platform.client.destroy();
  });

  assert.equal(registered.length, 6);
  const fanAccessory = registered.find((accessory) => accessory.UUID === 'wonderfree-fan:001122334455');
  assert(fanAccessory);
  assert.equal(fanAccessory.displayName, 'Test Fan');
  assert.equal(fanAccessory.services.length, 3); // AccessoryInformation + Fanv2 + TemperatureSensor
  const fan = fanAccessory.getService(Service.Fanv2);
  assert(fan);

  for (const name of ['Display', 'Sound', 'Natural', 'Sleep', 'Auto']) {
    const accessory = registered.find((candidate) => candidate.displayName === name);
    assert(accessory, `${name} accessory exists`);
    assert.equal(accessory.UUID, `wonderfree-fan:001122334455:${name.toLowerCase()}`);
    assert.equal(accessory.services.length, 2); // AccessoryInformation + Switch
    const service = accessory.getService(Service.Switch);
    assert(service, `${name} switch service exists`);
    assert.equal(service.getCharacteristic(Characteristic.Name).value, name);
  }

  platform.updateState({ power: true, mode: 2, speed: 4, oscillating: true, sound: false, display: true, temperature: 77 });
  assert.equal(fan.getCharacteristic(Characteristic.Active).value, 1);
  assert.equal(fan.getCharacteristic(Characteristic.RotationSpeed).value, 80);
  assert.equal(fan.getCharacteristic(Characteristic.SwingMode).value, 1);
  assert.equal(platform.temperatureC, 25);
  const switchOn = (name) => registered
    .find((accessory) => accessory.displayName === name)
    .getService(Service.Switch)
    .getCharacteristic(Characteristic.On);
  assert.equal(switchOn('Display').value, true);
  assert.equal(switchOn('Sound').value, false);
  assert.equal(switchOn('Natural').value, false);
  assert.equal(switchOn('Sleep').value, true);
  assert.equal(switchOn('Auto').value, false);

  const writes = [];
  platform.apply = async (values) => { writes.push(values); };
  await fan.getCharacteristic(Characteristic.Active).set(Characteristic.Active.ACTIVE);
  assert.deepEqual(writes.at(-1), [[1, true]]);
  await fan.getCharacteristic(Characteristic.SwingMode).set(1);
  assert.deepEqual(writes.at(-1), [[5, true]]);
  await fan.getCharacteristic(Characteristic.RotationSpeed).set(60);
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.deepEqual(writes.at(-1), [[1, true], [3, 3]]);
  await switchOn('Display').set(true);
  assert.deepEqual(writes.at(-1), [[15, true]]);
  await switchOn('Sound').set(false);
  assert.deepEqual(writes.at(-1), [[13, false]]);
  await switchOn('Natural').set(true);
  assert.deepEqual(writes.at(-1), [[2, 1]]);
  await switchOn('Auto').set(true);
  assert.deepEqual(writes.at(-1), [[2, 3]]);
  platform.updateState({ power: true, mode: 2, speed: 4, oscillating: true, sound: false, display: true, temperature: 77 });
  await switchOn('Sleep').set(false);
  assert.deepEqual(writes.at(-1), [[2, 0]]);
});
