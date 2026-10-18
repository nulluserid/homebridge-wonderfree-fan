'use strict';

/**
 * Quectel/Acceleronix TTLV client for Wonderfree fans (OmniBreeze p11vkW/p11vAZ).
 * Frame: AA AA | len(2 BE) | checksum | pid(2) | cmd(2) | AES-CBC payload.
 * Handshake: p2 -> p3 (16-char nonce) -> p4 (sha256) -> p5 (status) -> heartbeat.
 */

const crypto = require('crypto');
const dgram = require('dgram');
const net = require('net');
const os = require('os');
const { once } = require('events');

const CMD_HELLO = 0x7032;
const CMD_NONCE = 0x7033;
const CMD_LOGIN = 0x7034;
const CMD_LOGIN_RESULT = 0x7035;
const CMD_HEARTBEAT = 0x7039;
const CMD_READ = 0x0011;   // 17
const CMD_WRITE = 0x0013;  // 19
const CMD_REPORT = 0x0014; // 20
const CMD_STATUS = 0x0032; // 50

const DP_POWER = 1;
const DP_MODE = 2;
const DP_SPEED = 3;
const DP_OSCILLATION = 5;
const DP_SOUND = 13;
const DP_DISPLAY = 15;
const DP_TEMPERATURE = 21;
const DP_COUNTDOWN = 22;
const ALL_DPS = [DP_POWER, DP_MODE, DP_SPEED, DP_OSCILLATION, DP_SOUND, DP_DISPLAY, DP_TEMPERATURE, DP_COUNTDOWN];

function checksum(buf) {
  let sum = 0;
  for (const byte of buf) sum += byte;
  return sum & 0xff;
}

function stuff(frame) {
  const out = Buffer.alloc(frame.length + 16);
  let n = 0;
  out[n++] = frame[0];
  out[n++] = frame[1];
  for (let i = 2; i < frame.length; i += 1) {
    out[n++] = frame[i];
    if (frame[i] === 0xaa && i + 1 < frame.length && (frame[i + 1] === 0x55 || frame[i + 1] === 0xaa)) {
      out[n++] = 0x55;
    }
  }
  return out.subarray(0, n);
}

function encodeFrame(packetId, command, payload = Buffer.alloc(0)) {
  const body = Buffer.alloc(4 + payload.length);
  body.writeUInt16BE(packetId & 0xffff, 0);
  body.writeUInt16BE(command & 0xffff, 2);
  payload.copy(body, 4);
  const header = Buffer.alloc(4);
  header[0] = 0xaa;
  header[1] = 0xaa;
  header.writeUInt16BE(payload.length + 5, 2);
  return stuff(Buffer.concat([header, Buffer.from([checksum(body)]), body]));
}

function encodeNumber(value) {
  const negative = value < 0;
  let magnitude = Math.abs(value);
  const bytes = [];
  do {
    bytes.unshift(magnitude & 0xff);
    magnitude = Math.floor(magnitude / 256);
  } while (magnitude > 0);
  return Buffer.from([(negative ? 0x80 : 0) | (bytes.length - 1), ...bytes]);
}

function encodeTtlv(tag, value) {
  if (typeof value === 'boolean') {
    const header = Buffer.alloc(2);
    header.writeUInt16BE((tag << 3) | (value ? 1 : 0), 0);
    return header;
  }
  if (typeof value === 'number') {
    const header = Buffer.alloc(2);
    header.writeUInt16BE((tag << 3) | 2, 0);
    return Buffer.concat([header, encodeNumber(value)]);
  }
  const raw = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt16BE((tag << 3) | 3, 0);
  header.writeUInt16BE(raw.length, 2);
  return Buffer.concat([header, raw]);
}

function decodeTtlvs(buf) {
  const out = [];
  let i = 0;
  while (i + 2 <= buf.length) {
    const header = buf.readUInt16BE(i);
    i += 2;
    const tag = (header >> 3) & 0x1fff;
    const type = header & 7;
    if (type === 0 || type === 1) {
      out.push([tag, type, type === 1]);
    } else if (type === 2) {
      if (i >= buf.length) throw new Error('truncated TTLV number');
      const ctrl = buf[i++];
      const length = (ctrl & 7) + 1;
      if (i + length > buf.length) throw new Error('truncated TTLV value');
      let value = 0;
      for (let j = 0; j < length; j += 1) value = value * 256 + buf[i + j];
      i += length;
      if (ctrl & 0x80) value = -value;
      // Wonderfree fan DPs are integers; the reference implementation ignores
      // the fixed-point decimal flag as well.
      out.push([tag, type, value]);
    } else if (type === 3 || type === 5) {
      if (i + 2 > buf.length) throw new Error('truncated TTLV string');
      const length = buf.readUInt16BE(i);
      i += 2;
      if (i + length > buf.length) throw new Error('truncated TTLV bytes');
      out.push([tag, type, buf.subarray(i, i + length)]);
      i += length;
    } else {
      throw new Error(`unsupported TTLV type ${type}`);
    }
  }
  return out;
}


function normalizeMac(value) {
  return String(value || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
}

/**
 * Broadcast the Wonderfree discovery probe (UDP 6606) and return the fan's
 * current address, matched by its stable device key (MAC).
 */
function discoverFan(deviceKey, { timeout = 2500, port = 6606, host } = {}) {
  const target = normalizeMac(deviceKey);
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const reader = new FrameReader();
    const timers = [];
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      for (const timer of timers) clearTimeout(timer);
      try { sock.close(); } catch { /* ignore */ }
      resolve(result);
    };
    sock.on('error', () => { /* an ICMP unreachable must not abort discovery */ });
    sock.on('message', (msg, rinfo) => {
      let frames;
      try { frames = reader.push(msg); } catch { return; }
      for (const frame of frames) {
        if (frame.command !== 0x7031) continue;
        let fields;
        try { fields = decodeTtlvs(frame.payload); } catch { continue; }
        const value = (tag) => fields.find(([id]) => id === tag)?.[2];
        const mac = normalizeMac(value(4)?.toString?.());
        if (mac !== target) continue;
        finish({
          ip: value(5)?.toString?.() || rinfo.address,
          port: Number(value(6) || 6607),
          mac,
          productKey: value(3)?.toString?.(),
        });
      }
    });
    sock.bind(0, () => {
      try { sock.setBroadcast(true); } catch { /* ignore */ }
      const probe = encodeFrame(1000, 28720);
      const targets = new Set(['255.255.255.255']);
      if (host && /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
        // Stay on the fan's /24; broadcasting on Docker/Tailscale interfaces can
        // generate ICMP unreachables that poison the discovery socket.
        targets.add(host);
        targets.add(`${host.split('.').slice(0, 3).join('.')}.255`);
      } else {
        for (const ifaces of Object.values(os.networkInterfaces())) {
          for (const iface of ifaces || []) {
            if (iface.family !== 'IPv4' || iface.internal) continue;
            const address = iface.address.split('.').map(Number);
            const mask = iface.netmask.split('.').map(Number);
            if (address.length !== 4 || mask.length !== 4) continue;
            targets.add(address.map((byte, index) => (byte | (~mask[index] & 0xff))).join('.'));
          }
        }
      }
      const send = () => {
        for (const destination of targets) {
          try { sock.send(probe, port, destination); } catch { /* ignore */ }
        }
      };
      for (const delay of [0, 500, 1000]) timers.push(setTimeout(send, delay));
      timers.push(setTimeout(() => finish(null), timeout));
    });
  });
}

class FrameReader {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames = [];
    for (;;) {
      const start = this.buf.indexOf(Buffer.from([0xaa, 0xaa]));
      if (start < 0) {
        if (this.buf.length > 1) this.buf = this.buf.subarray(this.buf.length - 1);
        break;
      }
      if (start > 0) this.buf = this.buf.subarray(start);
      if (this.buf.length < 4) break;

      const logical = [this.buf[0], this.buf[1]];
      let i = 2;
      let need = null;
      let complete = false;
      while (i < this.buf.length) {
        const byte = this.buf[i];
        logical.push(byte);
        i += 1;
        if (byte === 0xaa && i < this.buf.length && this.buf[i] === 0x55) {
          if (i + 1 >= this.buf.length) break; // need one more byte to decide
          if (this.buf[i + 1] === 0x55 || this.buf[i + 1] === 0xaa) i += 1;
        }
        if (need === null && logical.length >= 4) {
          need = 4 + ((logical[2] << 8) | logical[3]);
        }
        if (need !== null && logical.length === need) {
          complete = true;
          break;
        }
        if (need !== null && logical.length > need) break;
      }
      if (!complete) break;

      const frame = Buffer.from(logical);
      this.buf = this.buf.subarray(i);
      if (frame.length < 9 || checksum(frame.subarray(5)) !== frame[4]) {
        // Corrupt frame: drop it and rescan the remainder.
        continue;
      }
      frames.push({
        packetId: frame.readUInt16BE(5),
        command: frame.readUInt16BE(7),
        payload: frame.subarray(9),
      });
    }
    return frames;
  }
}

class WonderfreeError extends Error {}
class WonderfreeAuthenticationError extends WonderfreeError {}
class WonderfreeConnectionError extends WonderfreeError {}

class WonderfreeClient {
  constructor({ host, port = 6607, authKey, log = () => {} }) {
    this.host = host;
    this.port = port;
    this.log = log;
    this.key = Buffer.from(authKey, 'base64');
    if (this.key.length !== 16) throw new WonderfreeAuthenticationError('authKey must decode to 16 bytes');
    this.sock = null;
    this.reader = new FrameReader();
    this.queue = [];
    this.waiters = [];
    this.iv = null;
    this.sequence = 1000;
    this.connecting = null;
    this.lastError = null;
  }

  nextSequence() {
    this.sequence = this.sequence >= 65534 ? 1000 : this.sequence + 1;
    return this.sequence;
  }

  crypt(payload, decrypt = false) {
    if (!this.iv) return payload;
    if (decrypt) {
      const decipher = crypto.createDecipheriv('aes-128-cbc', this.key, this.iv);
      return Buffer.concat([decipher.update(payload), decipher.final()]);
    }
    const cipher = crypto.createCipheriv('aes-128-cbc', this.key, this.iv);
    return Buffer.concat([cipher.update(payload), cipher.final()]);
  }

  attach(sock) {
    sock.on('data', (chunk) => {
      let frames;
      try {
        frames = this.reader.push(chunk);
      } catch (err) {
        this.lastError = err;
        this.destroy();
        return;
      }
      for (const frame of frames) {
        if (this.iv && frame.payload.length > 0) {
          try {
            frame.payload = this.crypt(frame.payload, true);
          } catch (err) {
            this.lastError = err;
            continue;
          }
        }
        this.deliver(frame);
      }
    });
    sock.on('error', (err) => {
      this.lastError = err;
      this.failWaiters(err);
    });
    sock.on('close', () => {
      this.sock = null;
      this.iv = null;
      this.failWaiters(new WonderfreeConnectionError('connection closed'));
    });
  }

  deliver(frame) {
    for (let i = 0; i < this.waiters.length; i += 1) {
      const waiter = this.waiters[i];
      if (waiter.predicate(frame)) {
        this.waiters.splice(i, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
        return;
      }
    }
    this.queue.push(frame);
    if (this.queue.length > 64) this.queue.shift();
  }

  failWaiters(err) {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
  }

  waitFor(predicate, timeoutMs) {
    for (let i = 0; i < this.queue.length; i += 1) {
      if (predicate(this.queue[i])) return Promise.resolve(this.queue.splice(i, 1)[0]);
    }
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new WonderfreeConnectionError('device response timed out'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async connect() {
    if (this.sock && this.sock.writable) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      this.destroy();
      this.reader = new FrameReader();
      this.queue = [];
      this.iv = null;
      this.sequence = 1000;
      const sock = net.createConnection({ host: this.host, port: this.port });
      this.sock = sock;
      sock.setNoDelay(true);
      this.attach(sock);
      try {
        await Promise.race([
          once(sock, 'connect'),
          new Promise((_, reject) => setTimeout(() => reject(new WonderfreeConnectionError('connect timeout')), 5000)),
        ]);
        await this.handshake();
      } catch (err) {
        this.destroy();
        throw err;
      }
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async handshake() {
    this.send(CMD_HELLO);
    const challenge = await this.waitFor((f) => f.command === CMD_NONCE, 3000);
    const nonce = decodeTtlvs(challenge.payload).find(([tag]) => tag === 1);
    if (!nonce || !Buffer.isBuffer(nonce[2]) || nonce[2].length !== 16) {
      throw new WonderfreeAuthenticationError('invalid authentication nonce');
    }
    const digest = crypto
      .createHash('sha256')
      .update(Buffer.concat([Buffer.from(this.key.toString('hex')), Buffer.from(';'), nonce[2]]))
      .digest('hex');
    this.send(CMD_LOGIN, encodeTtlv(2, digest));
    const response = await this.waitFor((f) => f.command === CMD_LOGIN_RESULT, 3000);
    const status = decodeTtlvs(response.payload).find(([tag]) => tag === 3);
    if (!status || status[2] !== 0) {
      throw new WonderfreeAuthenticationError(`device rejected auth key (${status ? status[2] : 'no status'})`);
    }
    this.iv = nonce[2];
    this.send(CMD_HEARTBEAT, Buffer.concat([encodeTtlv(1, 30), encodeTtlv(2, 1)]));
  }

  send(command, payload = Buffer.alloc(0)) {
    if (!this.sock || !this.sock.writable) throw new WonderfreeConnectionError('not connected');
    const encrypted = this.iv && payload.length > 0 ? this.crypt(payload, false) : payload;
    this.sock.write(encodeFrame(this.nextSequence(), command, encrypted));
  }

  async readStatus() {
    await this.connect();
    // Drop any encrypted frames queued before the login completed.
    this.queue = [];
    const request = Buffer.alloc(ALL_DPS.length * 2);
    ALL_DPS.forEach((dp, index) => request.writeUInt16BE(dp, index * 2));
    this.send(CMD_READ, request);
    const values = {};
    const deadline = Date.now() + 5000;
    while (Object.keys(values).length < ALL_DPS.length) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new WonderfreeConnectionError('timed out reading fan state');
      const frame = await this.waitFor((f) => f.command === CMD_REPORT || f.command === CMD_STATUS, remaining);
      for (const [tag, , value] of decodeTtlvs(frame.payload)) {
        if (ALL_DPS.includes(tag)) values[tag] = value;
      }
    }
    return {
      power: Boolean(values[DP_POWER]),
      mode: Number(values[DP_MODE]),
      speed: Number(values[DP_SPEED]),
      oscillating: Boolean(values[DP_OSCILLATION]),
      sound: Boolean(values[DP_SOUND]),
      display: Boolean(values[DP_DISPLAY]),
      temperature: Number(values[DP_TEMPERATURE]),
      countdown: Number(values[DP_COUNTDOWN]),
    };
  }

  async write(values) {
    await this.connect();
    const payload = Buffer.concat(values.map(([tag, value]) => encodeTtlv(tag, value)));
    this.send(CMD_WRITE, payload);
    try {
      await this.waitFor(() => true, 800);
    } catch {
      // The reference implementation ignores a missing write ack.
    }
    return this.readStatus();
  }

  destroy() {
    if (this.sock) {
      this.sock.destroy();
      this.sock = null;
    }
    this.iv = null;
    this.failWaiters(new WonderfreeConnectionError('disconnected'));
  }
}

module.exports = {
  WonderfreeClient,
  WonderfreeError,
  WonderfreeAuthenticationError,
  WonderfreeConnectionError,
  encodeFrame,
  encodeTtlv,
  decodeTtlvs,
  FrameReader,
  DP_POWER,
  DP_MODE,
  DP_SPEED,
  DP_OSCILLATION,
  DP_SOUND,
  DP_DISPLAY,
  DP_TEMPERATURE,
  DP_COUNTDOWN,
  ALL_DPS,
  discoverFan,
  normalizeMac,
};
