# homebridge-wonderfree-fan

[![npm version](https://img.shields.io/npm/v/homebridge-wonderfree-fan.svg)](https://www.npmjs.com/package/homebridge-wonderfree-fan)
[![CI](https://github.com/nulluserid/homebridge-wonderfree-fan/actions/workflows/ci.yml/badge.svg)](https://github.com/nulluserid/homebridge-wonderfree-fan/actions/workflows/ci.yml)

Local HomeKit control for **Wonderfree / Quectel** fans. Tested with the **OmniBreeze DC2313R** tower fan (Wonderfree product keys `p11vAZ` and `p11vkW`).

> **Unofficial and reverse-engineered.** This project is not affiliated with, endorsed by, or supported by OmniBreeze, Quectel, or Acceleronix. Firmware updates can change the local protocol. Use at your own risk.

## Features

- Fan: on/off, **5 speeds**, oscillation.
- **Natural / Sleep / Auto** switches. All three off means **Normal**; they are mutually exclusive.
- **Display** and **Sound** switches.
- Room **temperature sensor** (°F or °C).
- Published from GitHub Actions using npm trusted publishing (OIDC).

Fully local at runtime: UDP 6606 discovery, TCP 6607 control, AES-128-CBC per-device key.
- Automatic rediscovery by MAC if DHCP changes the fan's address.
- Homebridge Config UI schema; no cloud connection after setup.

## Requirements

- Homebridge **1.11.4 or newer**, Node.js **18 or newer**.
- The fan and Homebridge on the same LAN / VLAN.
- The fan already added to the **Wonderfree** or **Landbook** app, bound to an account you control.
- The fan's Wi-Fi MAC address (the device key).
- A one-time cloud login to fetch the fan's local `authKey`.

## Install

### Homebridge UI

1. Open **Plugins**, search for `homebridge-wonderfree-fan` or `wonderfree`.
2. Install it and restart Homebridge.
3. Add the **Wonderfree Fan** platform and fill in `host`, `deviceKey`, and `authKey`.

### Manual

```bash
npm install -g homebridge-wonderfree-fan
```

Add the platform to `config.json` (see [Configuration](#configuration)) and restart Homebridge.

### From a source checkout

Before the npm release, install the checkout into the Homebridge storage:

```bash
cd ~/.homebridge   # or /var/lib/homebridge in Docker
npm install /path/to/homebridge-wonderfree-fan
```

Then run the key helper from that checkout with `node tools/fetch-key.js ...`.

## One-time authKey setup

The fan's local control key is a 16-byte AES secret held by the vendor cloud account that has the fan bound. Fetch it once:

```bash
WONDERFREE_EMAIL='you@example.com' \
WONDERFREE_PASSWORD='your-password' \
npx --package homebridge-wonderfree-fan wonderfree-fan-key \
  --device 001122334455 \
  --host 192.0.2.10 \
  --region north_america
```

- `--device` is the fan's Wi-Fi MAC without separators. Find it in your router's client list or the app's device info.
- `--host` is optional. When supplied, the helper validates the key against the fan. It prints only the key to stdout; diagnostics go to stderr.
- `--region` is one of `north_america` (US/Canada, Landbook), `europe` (Europe/Latin America, Wonderfree), or `china`. Omit it to try all three.
- From a source checkout, run `node tools/fetch-key.js ...` instead.

The helper logs in only to fetch the key. It does not store your email, password, or cloud session, and the plugin makes no cloud requests at runtime.

### Shared accounts and Sign in with Apple

- **Shared devices:** the helper falls back to `regenerateAuthKey`, which returns the live key even when the device-list copy is frozen.
- **Apple-ID-only account:** if the app offers Sign in with Apple, open **Me → My Account** and set a password for the account (Hide My Email addresses still receive forwarded mail), then use email/password with the helper. Alternatively, share the fan from that account to a standard email/password account and fetch the key from the second account.
- **Advanced:** if you can capture the app's bearer token, set `WONDERFREE_TOKEN` instead of email/password.

## Configuration

```json
{
  "platforms": [
    {
      "platform": "WonderfreeFan",
      "name": "Wonderfree Fan",
      "host": "192.0.2.10",
      "deviceKey": "001122334455",
      "authKey": "<paste the Base64 authKey>",
      "accessoryName": "Tower Fan",
      "temperatureUnit": "F",
      "displaySwitch": true,
      "soundSwitch": true,
      "modeSwitches": true,
      "discover": true,
      "pollInterval": 15
    }
  ]
}
```

| Key | Required | Default | Notes |
|---|---|---|---|
| `platform` | yes | — | Must be `WonderfreeFan`. |
| `host` | yes | — | Fan LAN address. Discovery updates it at runtime. |
| `deviceKey` | yes | — | Wi-Fi MAC without separators, e.g. `001122334455`. |
| `authKey` | yes | — | Base64 key from the helper. Treat it as a secret. |
| `port` | no | `6607` | Control port. |
| `productKey` | no | — | Informational; shown in the model string. |
| `manufacturer` | no | `Wonderfree` | Accessory Information manufacturer. |
| `accessoryName` | no | `Wonderfree Fan` | Name shown in the Home app. |
| `temperatureUnit` | no | `F` | Set to `C` if the fan/app reports Celsius. |
| `temperatureSensor` | no | `true` | Expose the room temperature sensor. |
| `displaySwitch` | no | `true` | Expose the Display switch. |
| `soundSwitch` | no | `true` | Expose the Sound switch. |
| `modeSwitches` | no | `true` | Expose Natural / Sleep / Auto. |
| `discover` | no | `true` | Rediscover by MAC when the connection fails. |
| `pollInterval` | no | `15` | Seconds; minimum 5. |

## HomeKit controls

Display, Sound, Natural, Sleep, and Auto are published as **separate accessories** rather than hidden secondary services on the fan. This is intentional: HomeKit does not reliably show secondary-service names, so each control gets its own labeled tile.

| Control | Behaviour |
|---|---|
| Fan active | Power on/off. |
| Rotation speed | 5 fan speeds, mapped to HomeKit 20/40/60/80/100%. |
| Swing mode | Oscillation. |
| Natural | Fan mode 1; turns Sleep/Auto off. |
| Sleep | Fan mode 2; turns Natural/Auto off. |
| Auto | Fan mode 3; turns Natural/Sleep off. |
| All three mode switches off | Normal (mode 0). |
| Display | Display/LED on the fan. |
| Sound | Button/notification sound. |
| Temperature | Room temperature, converted from °F to °C for HomeKit when `temperatureUnit` is `F`. |

The plugin reads the fan's current mode at startup, so the mode switches reflect changes made from the fan's own app or remote.

## Discovery and IP changes

The plugin broadcasts the Wonderfree discovery probe on UDP 6606 and matches the reply by `deviceKey` (MAC). If the fan gets a new DHCP address, the next connection failure triggers rediscovery and a retry. A DHCP reservation is still recommended.

Broadcast/multicast filtering on the LAN or VLAN can prevent discovery; in that case keep `host` up to date manually.

## Troubleshooting

**“No plugin was found for the platform WonderfreeFan”**  
Install the plugin in the Homebridge storage (`npm install` in the Homebridge UI or globally), restart Homebridge, and confirm `homebridge-wonderfree-fan` appears in the plugin list.

**“Device rejected auth key”**  
The key is stale or was rotated. Re-run the helper. If the fan was re-provisioned or moved to another account, fetch the key from the account that currently owns it. Shared accounts should use the helper's `regenerateAuthKey` fallback.

**The accessory does not appear in the Home app**  
Confirm the Homebridge bridge is paired and restart the Home app. In Docker with many virtual interfaces, HAP mDNS may advertise an unreachable Docker bridge address; set `"advertiser": "avahi"` in the `bridge` block of the Homebridge config (recommended when Avahi is enabled in the container). Also check `docker logs homebridge` / the Homebridge log for the platform's “Connected to fan” line.

**Temperature is wrong**  
The fan reports in the unit shown in its app. Set `temperatureUnit` to `F` or `C` accordingly.

**Fan does not respond**  
Confirm TCP 6607 is reachable from the Homebridge host, the fan is on the same L2 network, and the `host`/`deviceKey` pair matches the fan.

**Firmware update broke control**  
The protocol is undocumented. Check the repository issues; the local key and DP mapping may need updating.

## How it works

The fan speaks a Quectel/Acceleronix TTLV protocol:

- **UDP 6606** — discovery probe/reply (product key, MAC, IP, port).
- **TCP 6607** — handshake (p2/p3/p4/p5) followed by encrypted TTLV reads/writes.
- **AES-128-CBC** — key from the Base64 `authKey`, IV from the device's 16-byte nonce.
- Data points used by this plugin: power (1), mode (2), speed (3), oscillation (5), sound (13), display (15), temperature (21), timer (22).

No cloud connection is made by the plugin after the one-time key fetch.

## Security and privacy

- The `authKey` grants local control of the fan. Do not commit it, paste it into issues, or share Homebridge config backups containing it.
- The helper sends your email/password only to the vendor's regional login endpoint, over HTTPS, to retrieve the key. It does not write credentials to disk.
- The plugin sends no telemetry and makes no cloud requests at runtime.
- Homebridge backups should be treated as sensitive because they contain the key.

## Development

```bash
git clone https://github.com/nulluserid/homebridge-wonderfree-fan.git
cd homebridge-wonderfree-fan
npm test        # offline: frame/TTLV codec, discovery, mock Homebridge platform
npm pack        # inspect the published file list
```

The test suite does not require a fan or network access.

## Credits

Protocol research and the cloud login flow were documented by:

- [miguelcaravantes/ha-omnibreeze-wonderfree](https://github.com/miguelcaravantes/ha-omnibreeze-wonderfree) — MIT, Copyright (c) 2026 Miguel Caravantes.
- [bordeux/ha-oukitel-powerstation](https://github.com/bordeux/ha-oukitel-powerstation) — MIT, Quectel/Acceleronix protocol reverse engineering.

The cloud login constants in `tools/fetch-key.js` are the publicly documented values from that work. This project is an independent Homebridge implementation, not a copy of either integration.

## Disclaimer

This software is provided “as is”, without warranty of any kind. It relies on an undocumented local protocol and can stop working after a firmware or cloud change. You are responsible for complying with the terms applicable to your device and account.

## License

MIT — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
