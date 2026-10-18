#!/usr/bin/env node
'use strict';

/**
 * One-time Wonderfree/Landbook cloud login -> local fan authKey.
 *
 * Usage:
 *   WONDERFREE_EMAIL=you@example.com WONDERFREE_PASSWORD='...' \
 *     wonderfree-fan-key --device 001122334455 --host 192.0.2.10 --region north_america
 *
 * Only the authKey is printed to stdout; diagnostics go to stderr.
 * The credentials and cloud token are never written to disk.
 *
 * The cloud login constants below are the publicly documented values used by
 * the Wonderfree app; see the README credits for the reverse-engineering work.
 */

const crypto = require('crypto');
const { WonderfreeClient, WonderfreeAuthenticationError } = require('../protocol');

const REGIONS = {
  north_america: {
    label: 'North America',
    base: 'https://iot-api.landecia.com',
    userDomain: 'U.SP.8589934603',
    secret: 'pUTp5goB1bLinprRQMmK3EPiiuPiGrJtKUNptWRXVmP',
  },
  europe: {
    label: 'Europe / Latin America',
    base: 'https://iot-api.acceleronix.io',
    userDomain: 'E.SP.4294967410',
    secret: '3aRNUwWahjyANa7WfBK2wCCkxCexB6nXxKJwXxfePvzf',
  },
  china: {
    label: 'China',
    base: 'https://iot-api.quectelcn.com',
    userDomain: 'C.DM.5903.1',
    secret: 'EufftRJSuWuVY7c6txzGifV9bJcfXHAFa7hXY5doXSn7',
  },
};

const APP_VERSION = '3.6.5';
const APP_ID = '277';
const LOGIN_PATH = '/v2/enduser/enduserapi/emailPwdLogin';
const DEVICE_LIST_PATH = '/v2/binding/enduserapi/userDeviceList';
const REGENERATE_PATH = '/v2/binding/enduserapi/regenerateAuthKey';

function encryptPassword(password, randomValue) {
  const md5 = crypto.createHash('md5').update(randomValue).digest('hex').toUpperCase();
  const key = Buffer.from(md5.slice(8, 24), 'utf8');
  const iv = Buffer.concat([key.subarray(8, 16), key.subarray(0, 8)]);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]).toString('base64');
}

function headers(token) {
  const result = {
    appVersion: APP_VERSION,
    appSystemType: 'android',
    appId: APP_ID,
    'X-Q-Language': 'en',
  };
  if (token) result.Authorization = token;
  return result;
}

function normalizeKey(value) {
  return String(value || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
}

async function login(region, email, password) {
  const random = Array.from({ length: 16 }, () => {
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    return alphabet[crypto.randomInt(alphabet.length)];
  }).join('');
  const pwd = encryptPassword(password, random);
  const signature = crypto
    .createHash('sha256')
    .update(email + pwd + random + region.secret)
    .digest('hex');
  const body = new URLSearchParams({ pwd, email, random, userDomain: region.userDomain, signature });
  const response = await fetch(region.base + LOGIN_PATH, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.code !== 200) {
    throw new Error(`${region.label}: login rejected (${payload.code ?? response.status} ${payload.msg || ''})`);
  }
  const accessToken = payload.data && payload.data.accessToken;
  const token = accessToken && accessToken.token;
  if (!token) throw new Error(`${region.label}: login returned no token`);
  return token;
}

async function listDevices(region, token, deviceKey) {
  let page = 1;
  let pages = 1;
  const matches = [];
  while (page <= pages) {
    const url = new URL(region.base + DEVICE_LIST_PATH);
    url.searchParams.set('page', String(page));
    url.searchParams.set('pageSize', '100');
    url.searchParams.set('isAssociation', 'false');
    const response = await fetch(url, { headers: headers(token) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.code !== 200) {
      throw new Error(`${region.label}: device list rejected (${payload.code ?? response.status} ${payload.msg || ''})`);
    }
    const data = payload.data || {};
    const list = Array.isArray(data.list) ? data.list : [];
    if (Number.isInteger(data.pages) && data.pages > 0) pages = data.pages;
    for (const device of list) {
      if (normalizeKey(device.deviceKey) === deviceKey) matches.push(device);
    }
    page += 1;
  }
  return matches;
}

async function regenerateAuthKey(region, token, pk, dk) {
  const response = await fetch(region.base + REGENERATE_PATH, {
    method: 'POST',
    headers: { ...headers(token), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ pk, dk }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.code !== 200) {
    throw new Error(`${region.label}: regenerateAuthKey rejected (${payload.code ?? response.status} ${payload.msg || ''})`);
  }
  const key = payload.data && payload.data.authKey;
  if (!key) throw new Error(`${region.label}: regenerateAuthKey returned no authKey`);
  return key;
}

async function checkKey(authKey, host) {
  if (!host) return 'unreachable';
  const client = new WonderfreeClient({ host, authKey, log: () => {} });
  try {
    await client.connect();
    return 'ok';
  } catch (err) {
    return err instanceof WonderfreeAuthenticationError ? 'auth' : 'unreachable';
  } finally {
    client.destroy();
  }
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const email = process.env.WONDERFREE_EMAIL || argValue(args, '--email');
  const password = process.env.WONDERFREE_PASSWORD || argValue(args, '--password');
  const suppliedToken = process.env.WONDERFREE_TOKEN || argValue(args, '--token');
  const deviceKey = normalizeKey(argValue(args, '--device') || process.env.WONDERFREE_DEVICE);
  const host = argValue(args, '--host') || process.env.WONDERFREE_HOST || '';
  const jsonOnly = args.includes('--json');
  const noTest = args.includes('--no-test');
  const requestedRegion = argValue(args, '--region');

  if (!deviceKey) {
    console.error('Usage: wonderfree-fan-key --device <MAC without separators> [--host <fan IP>] [--region north_america|europe|china]');
    console.error('Set WONDERFREE_EMAIL and WONDERFREE_PASSWORD, or WONDERFREE_TOKEN for an existing session.');
    process.exit(2);
  }
  if (!suppliedToken && (!email || !password)) {
    console.error('Set WONDERFREE_EMAIL/WONDERFREE_PASSWORD, or WONDERFREE_TOKEN for an existing session.');
    process.exit(2);
  }

  const regions = requestedRegion ? [requestedRegion] : ['north_america', 'europe', 'china'];
  const errors = [];

  for (const name of regions) {
    const region = REGIONS[name];
    if (!region) {
      errors.push(`unknown region: ${name}`);
      continue;
    }
    try {
      console.error(`Trying ${region.label}...`);
      const token = suppliedToken || (await login(region, email, password));
      const devices = await listDevices(region, token, deviceKey);
      if (devices.length === 0) {
        console.error(`${region.label}: no device with key ${deviceKey} on this account`);
        continue;
      }
      const device = devices[0];
      let authKey = device.authKey;
      if (!authKey) console.error('Device list had no authKey; trying regenerateAuthKey...');
      if (authKey && host && !noTest) {
        const result = await checkKey(authKey, host);
        if (result === 'auth') {
          console.error('Device rejected the list authKey (shared/frozen key); trying regenerateAuthKey...');
          authKey = null;
        } else if (result === 'unreachable') {
          console.error(`Could not reach ${host} to validate the key; printing the list authKey.`);
        }
      }
      if (!authKey) {
        authKey = await regenerateAuthKey(region, token, device.productKey, device.deviceKey);
        if (host && !noTest) {
          const result = await checkKey(authKey, host);
          if (result === 'auth') throw new Error('Device rejected the regenerated authKey too');
          if (result === 'unreachable') console.error(`Could not reach ${host} to validate the regenerated key.`);
        }
      }
      if (jsonOnly) {
        console.log(JSON.stringify({ authKey, region: name, deviceKey: device.deviceKey, productKey: device.productKey }));
      } else {
        console.error(`Found ${device.deviceName || 'fan'} (pk=${device.productKey})`);
        console.log(authKey);
      }
      return;
    } catch (err) {
      errors.push(err.message);
    }
  }
  console.error('Could not fetch authKey:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
