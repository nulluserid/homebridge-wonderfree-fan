'use strict';

const { version } = require('./package.json');

const {
  WonderfreeClient,
  WonderfreeAuthenticationError,
  DP_POWER,
  DP_SPEED,
  DP_MODE,
  DP_OSCILLATION,
  DP_SOUND,
  DP_DISPLAY,
  DP_TEMPERATURE,
  discoverFan,
} = require('./protocol');

const PLUGIN_NAME = 'homebridge-wonderfree-fan';
const PLATFORM_NAME = 'WonderfreeFan';
const SPEED_MIN = 1;
const SPEED_MAX = 5;
const LEGACY_SWITCH_SUBTYPES = ['display', 'sound', 'natural', 'sleep', 'auto'];

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, WonderfreeFanPlatform);
};

class WonderfreeFanPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = [];
    this.client = null;
    this.currentHost = null;
    this.state = { power: false, mode: 0, speed: 1, oscillating: false, sound: true, display: true, temperature: 0 };
    this.fault = 0;
    this.temperatureC = 0;
    this.connectedLogged = false;
    this.pollTimer = null;
    this.initialTimer = null;
    this.refreshing = false;
    this.writeChain = Promise.resolve();
    this.speedTimer = null;
    this.service = null;
    this.tempService = null;
    this.switchAccessories = {};
    this.accessory = null;

    this.api.on('didFinishLaunching', () => this.start());
  }

  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }

  start() {
    const cfg = this.config;
    if (!cfg.host || !cfg.authKey || !cfg.deviceKey) {
      this.log.error('WonderfreeFan: "host", "deviceKey" and "authKey" are required; fan accessory not created.');
      return;
    }

    const deviceKey = cfg.deviceKey;
    const fan = this.upsertAccessory(
      this.api.hap.uuid.generate(`wonderfree-fan:${deviceKey}`),
      cfg.accessoryName || 'Wonderfree Fan',
      { deviceKey, kind: 'fan' },
    );
    this.accessory = fan.accessory;
    this.setupFanServices(this.accessory);
    this.registerOrUpdate(this.accessory, fan.isNew, 'fan');

    this.switchAccessories = {};
    const defs = this.switchDefinitions();
    for (const def of defs) {
      const entry = this.upsertAccessory(
        this.api.hap.uuid.generate(`wonderfree-fan:${deviceKey}:${def.subtype}`),
        def.name,
        { deviceKey, kind: 'switch', subtype: def.subtype },
      );
      const service = this.setupSwitchService(entry.accessory, def);
      this.switchAccessories[def.subtype] = { accessory: entry.accessory, service, def };
      this.registerOrUpdate(entry.accessory, entry.isNew, def.subtype);
    }
    this.pruneSwitches(defs);

    this.currentHost = cfg.host;
    this.client = new WonderfreeClient({
      host: cfg.host,
      port: cfg.port || 6607,
      authKey: cfg.authKey,
      log: this.log,
    });

    const pollSeconds = Math.max(5, Number(cfg.pollInterval) || 15);
    this.pollTimer = setInterval(() => this.refresh(), pollSeconds * 1000);
    this.initialTimer = setTimeout(async () => {
      await this.resolveHost();
      await this.refresh();
    }, 1000);
  }

  upsertAccessory(uuid, name, context) {
    const existing = this.accessories.find((candidate) => candidate.UUID === uuid);
    if (existing) {
      existing.context = { ...existing.context, ...context };
      existing.displayName = name;
      return { accessory: existing, isNew: false };
    }
    const accessory = new this.api.platformAccessory(name, uuid);
    accessory.context = { ...context };
    return { accessory, isNew: true };
  }

  registerOrUpdate(accessory, isNew, label) {
    if (isNew) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.log.info('Registered %s accessory "%s"', label, accessory.displayName);
    } else {
      this.api.updatePlatformAccessories([accessory]);
      this.log.info('Updated %s accessory "%s"', label, accessory.displayName);
    }
  }

  pruneSwitches(defs) {
    const enabled = new Set(defs.map((def) => def.subtype));
    for (const accessory of [...this.accessories]) {
      if (accessory.context && accessory.context.kind === 'switch' && !enabled.has(accessory.context.subtype)) {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories = this.accessories.filter((candidate) => candidate !== accessory);
      }
    }

    // Older versions exposed the switches as secondary services on the fan.
    let changed = false;
    for (const subtype of LEGACY_SWITCH_SUBTYPES) {
      const service = this.accessory.getServiceById(this.api.hap.Service.Switch, subtype);
      if (service) {
        this.accessory.removeService(service);
        changed = true;
      }
    }
    if (changed) this.api.updatePlatformAccessories([this.accessory]);
  }

  switchDefinitions() {
    const cfg = this.config;
    const defs = [];
    if (cfg.displaySwitch !== false) {
      defs.push({ subtype: 'display', name: 'Display', kind: 'dp', dp: DP_DISPLAY, stateKey: 'display' });
    }
    if (cfg.soundSwitch !== false) {
      defs.push({ subtype: 'sound', name: 'Sound', kind: 'dp', dp: DP_SOUND, stateKey: 'sound' });
    }
    if (cfg.modeSwitches !== false) {
      defs.push({ subtype: 'natural', name: 'Natural', kind: 'mode', mode: 1 });
      defs.push({ subtype: 'sleep', name: 'Sleep', kind: 'mode', mode: 2 });
      defs.push({ subtype: 'auto', name: 'Auto', kind: 'mode', mode: 3 });
    }
    return defs;
  }

  setupFanServices(accessory) {
    const { Service, Characteristic } = this.api.hap;
    const cfg = this.config;
    const info = accessory.getService(Service.AccessoryInformation);
    info
      .setCharacteristic(Characteristic.Manufacturer, cfg.manufacturer || 'Wonderfree')
      .setCharacteristic(Characteristic.Model, cfg.productKey ? `Wonderfree Fan (${cfg.productKey})` : 'Wonderfree Fan')
      .setCharacteristic(Characteristic.SerialNumber, accessory.context.deviceKey || cfg.deviceKey)
      .setCharacteristic(Characteristic.FirmwareRevision, version);

    this.service =
      accessory.getService(Service.Fanv2) ||
      accessory.addService(Service.Fanv2, accessory.displayName || 'Wonderfree Fan');
    this.service
      .getCharacteristic(Characteristic.Active)
      .onGet(() => (this.state.power ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE))
      .onSet((value) => this.enqueueWrite([[DP_POWER, value === Characteristic.Active.ACTIVE]]));

    this.service
      .getCharacteristic(Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onGet(() => (this.state.power ? this.speedToPercent(this.state.speed) : 0))
      .onSet((value) => this.setSpeedDebounced(value));

    this.service
      .getCharacteristic(Characteristic.SwingMode)
      .onGet(() => (this.state.oscillating ? Characteristic.SwingMode.SWING_ENABLED : Characteristic.SwingMode.SWING_DISABLED))
      .onSet((value) => this.enqueueWrite([[DP_OSCILLATION, value === Characteristic.SwingMode.SWING_ENABLED]]));

    if (!this.service.testCharacteristic(Characteristic.StatusFault)) {
      this.service.addCharacteristic(Characteristic.StatusFault);
    }
    this.service.getCharacteristic(Characteristic.StatusFault).onGet(() => this.fault);

    if (cfg.temperatureSensor !== false) {
      this.tempService =
        accessory.getService(Service.TemperatureSensor) ||
        accessory.addService(Service.TemperatureSensor, `${accessory.displayName || 'Wonderfree Fan'} Temperature`);
      this.tempService
        .getCharacteristic(Characteristic.CurrentTemperature)
        .setProps({ minValue: -20, maxValue: 60, minStep: 0.1 })
        .onGet(() => this.temperatureC);
    }
  }

  setupSwitchService(accessory, def) {
    const { Service, Characteristic } = this.api.hap;
    const cfg = this.config;
    const info = accessory.getService(Service.AccessoryInformation);
    info
      .setCharacteristic(Characteristic.Manufacturer, cfg.manufacturer || 'Wonderfree')
      .setCharacteristic(Characteristic.Model, cfg.productKey ? `Wonderfree Fan (${cfg.productKey})` : 'Wonderfree Fan')
      .setCharacteristic(Characteristic.SerialNumber, `${accessory.context.deviceKey || cfg.deviceKey}:${def.subtype}`)
      .setCharacteristic(Characteristic.FirmwareRevision, version);

    const service = accessory.getService(Service.Switch) || accessory.addService(Service.Switch, def.name);
    if (!service.testCharacteristic(Characteristic.Name)) service.addCharacteristic(Characteristic.Name);
    service.getCharacteristic(Characteristic.Name).updateValue(def.name);
    service
      .getCharacteristic(Characteristic.On)
      .onGet(() => (
        def.kind === 'mode'
          ? this.state.mode === def.mode
          : Boolean(this.state[def.stateKey])
      ))
      .onSet((value) => (
        def.kind === 'mode'
          ? this.setMode(def.mode, Boolean(value))
          : this.enqueueWrite([[def.dp, Boolean(value)]])
      ));
    return service;
  }

  speedToPercent(speed) {
    const clamped = Math.max(SPEED_MIN, Math.min(SPEED_MAX, Number(speed) || SPEED_MIN));
    return Math.round((clamped / SPEED_MAX) * 100);
  }

  percentToSpeed(percent) {
    const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
    if (clamped <= 0) return 0;
    return Math.max(SPEED_MIN, Math.min(SPEED_MAX, Math.round((clamped / 100) * SPEED_MAX)));
  }

  setSpeedDebounced(value) {
    this.pendingSpeed = value;
    clearTimeout(this.speedTimer);
    this.speedTimer = setTimeout(() => {
      const speed = this.percentToSpeed(this.pendingSpeed);
      const values = speed === 0
        ? [[DP_POWER, false]]
        : [[DP_POWER, true], [DP_SPEED, speed]];
      this.apply(values).catch((err) => this.log.warn('WonderfreeFan speed write failed: %s', err.message));
    }, 350);
    return Promise.resolve();
  }

  setMode(mode, enabled) {
    if (!enabled) {
      // All mode switches off means Normal. Turning an already-inactive switch
      // off must not disturb the current mode.
      if (this.state.mode !== mode) return Promise.resolve();
      return this.enqueueWrite([[DP_MODE, 0]]);
    }
    return this.enqueueWrite([[DP_MODE, mode]]);
  }

  enqueueWrite(values) {
    this.writeChain = this.writeChain
      .then(() => this.apply(values))
      .catch((err) => this.log.error('WonderfreeFan write failed: %s', err.message));
    return this.writeChain;
  }

  async apply(values) {
    if (!this.client) return;
    try {
      const status = await this.client.write(values);
      this.updateState(status);
      this.setFault(false);
    } catch (err) {
      this.setFault(true);
      this.log.warn('WonderfreeFan command failed: %s', err.message);
      if (this.client) this.client.destroy();
      throw err;
    }
  }

  async resolveHost() {
    if (!this.client || this.config.discover === false || !this.config.deviceKey) return this.currentHost;
    const found = await discoverFan(this.config.deviceKey, { timeout: 2000, host: this.currentHost });
    if (found && found.ip) {
      if (found.ip !== this.currentHost) {
        this.log.info('Discovered fan at %s (configured %s)', found.ip, this.currentHost);
      }
      this.currentHost = found.ip;
      this.client.host = found.ip;
    }
    return this.currentHost;
  }

  async refresh() {
    if (!this.client || this.refreshing) return;
    this.refreshing = true;
    try {
      const status = await this.client.readStatus();
      this.updateState(status);
      this.setFault(false);
    } catch (err) {
      if (err instanceof WonderfreeAuthenticationError) {
        this.log.error('WonderfreeFan rejected the authKey: %s', err.message);
      } else {
        this.log.debug('WonderfreeFan poll failed: %s', err.message);
        if (this.config.discover !== false && this.config.deviceKey) {
          const found = await discoverFan(this.config.deviceKey, { timeout: 2000, host: this.currentHost });
          if (found && found.ip && found.ip !== this.currentHost && this.client) {
            this.log.info('Fan moved from %s to %s; retrying', this.currentHost, found.ip);
            this.currentHost = found.ip;
            this.client.destroy();
            this.client.host = found.ip;
            try {
              const status = await this.client.readStatus();
              this.updateState(status);
              this.setFault(false);
              return;
            } catch (retryErr) {
              this.log.warn('WonderfreeFan retry after rediscovery failed: %s', retryErr.message);
            }
          }
        }
      }
      this.setFault(true);
      if (this.client) this.client.destroy();
    } finally {
      this.refreshing = false;
    }
  }

  setFault(value) {
    this.fault = value ? this.api.hap.Characteristic.StatusFault.GENERAL_FAULT : this.api.hap.Characteristic.StatusFault.NO_FAULT;
    if (this.service && this.service.getCharacteristic(this.api.hap.Characteristic.StatusFault)) {
      this.service.updateCharacteristic(this.api.hap.Characteristic.StatusFault, this.fault);
    }
  }

  updateState(status) {
    this.state = status;
    const unit = String(this.config.temperatureUnit || 'F').toUpperCase();
    const rawTemperature = Number(status.temperature);
    const celsius = unit === 'F' ? ((rawTemperature - 32) * 5) / 9 : rawTemperature;
    this.temperatureC = Math.max(-20, Math.min(60, Math.round(celsius * 10) / 10));
    if (!this.connectedLogged) {
      this.connectedLogged = true;
      this.log.info('Connected to fan %s (power=%s mode=%s speed=%s temp=%s°%s)', this.currentHost, status.power, status.mode, status.speed, rawTemperature, unit);
    }
    if (!this.service) return;
    const { Characteristic } = this.api.hap;
    this.service.updateCharacteristic(Characteristic.Active, status.power ? 1 : 0);
    this.service.updateCharacteristic(Characteristic.RotationSpeed, status.power ? this.speedToPercent(status.speed) : 0);
    this.service.updateCharacteristic(Characteristic.SwingMode, status.oscillating ? 1 : 0);
    if (this.tempService) {
      this.tempService.updateCharacteristic(Characteristic.CurrentTemperature, this.temperatureC);
    }
    for (const { service, def } of Object.values(this.switchAccessories)) {
      const on = def.kind === 'mode' ? status.mode === def.mode : Boolean(status[def.stateKey]);
      service.updateCharacteristic(Characteristic.On, on);
    }
  }
}
