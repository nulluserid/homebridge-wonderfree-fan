'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');

const {
  encodeFrame,
  encodeTtlv,
  decodeTtlvs,
  FrameReader,
  discoverFan,
} = require('../protocol');

test('encodes the known discovery probe', () => {
  assert.equal(encodeFrame(1000, 28720).toString('hex'), 'aaaa00058b03e87030');
});

test('round-trips TTLV values used by the fan', () => {
  assert.equal(encodeTtlv(1, true).toString('hex'), '0009');
  assert.equal(encodeTtlv(1, false).toString('hex'), '0008');
  assert.equal(encodeTtlv(3, 5).toString('hex'), '001a0005');
  assert.equal(encodeTtlv(21, 23).toString('hex'), '00aa0017');
  assert.equal(encodeTtlv(2, 'abc').toString('hex'), '00130003616263');
});

test('parses a synthetic discovery reply', () => {
  const payload = Buffer.concat([
    encodeTtlv(3, 'p11vkW'),
    encodeTtlv(4, '001122334455'),
    encodeTtlv(5, '192.0.2.10'),
    encodeTtlv(6, 6607),
    encodeTtlv(7, 0),
  ]);
  const frame = encodeFrame(1000, 28721, payload);
  const parsed = new FrameReader().push(frame);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].command, 28721);
  const fields = Object.fromEntries(decodeTtlvs(parsed[0].payload).map(([tag, , value]) => [tag, value]));
  assert.equal(fields[3].toString(), 'p11vkW');
  assert.equal(fields[4].toString(), '001122334455');
  assert.equal(fields[5].toString(), '192.0.2.10');
  assert.equal(fields[6], 6607);
});

test('discoverFan resolves a local responder by MAC', async (t) => {
  const mac = '001122334455';
  const reply = encodeFrame(1000, 28721, Buffer.concat([
    encodeTtlv(3, 'p11vkW'),
    encodeTtlv(4, mac.toUpperCase()),
    encodeTtlv(5, '192.0.2.10'),
    encodeTtlv(6, 6607),
    encodeTtlv(7, 0),
  ]));
  const server = dgram.createSocket('udp4');
  t.after(() => server.close());
  server.on('message', (msg, rinfo) => server.send(reply, rinfo.port, rinfo.address));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.bind(0, '127.0.0.1', resolve);
  });
  const discoveryPort = server.address().port;
  const found = await discoverFan(mac, { host: '127.0.0.1', port: discoveryPort, timeout: 1500 });
  assert.deepEqual(found, { ip: '192.0.2.10', port: 6607, mac: '001122334455', productKey: 'p11vkW' });
});
