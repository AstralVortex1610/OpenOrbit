# Orbit Phone Link relay

A small relay you run yourself. It lets Orbit Remote on your phone reach Orbit on your laptop when they are on different networks, without Cloudflare's quick tunnel or ntfy.

Both sides connect **out** to the relay, so the laptop opens no inbound port:

```
laptop -> wss://<relay>/host/<room>   (Authorization: Bearer <RELAY_TOKEN>)
phone  -> wss://<relay>/c/<room>
```

The relay matches them by room and copies bytes. Those bytes are Phone Link frames that Orbit has already sealed end to end (X25519 + XSalsa20-Poly1305, keys from QR pairing). The relay can't read or change them. It sees only room ids, connection times, byte counts and IP addresses, and it stores nothing. How the encryption works: [docs/phone-link.md](../docs/phone-link.md).

There are two versions with the same protocol. Pick one.

## Option A: Node server (any VPS, home server or Raspberry Pi)

Needs Node 18 or newer.

```bash
cd relay
npm install
RELAY_TOKEN="$(openssl rand -hex 32)" PORT=8787 node server.js
```

The phone needs `wss://`, so put the relay behind HTTPS. Either:

- run a TLS reverse proxy (Caddy, nginx) in front of it and forward WebSocket upgrades to port 8787, for example in Caddy: `relay.example.com { reverse_proxy 127.0.0.1:8787 }`, or
- give it a certificate directly with `TLS_CERT=/path/fullchain.pem TLS_KEY=/path/privkey.pem`.

| Variable | Default | |
|---|---|---|
| `RELAY_TOKEN` | empty | Required for `/host/` connections when set. **Set it.** Without it, anyone can register a room on your relay. |
| `PORT` | `8787` | |
| `HOST` | `0.0.0.0` | |
| `TLS_CERT`, `TLS_KEY` | empty | PEM file paths, to serve `wss://` directly |

Health check: `GET /health` returns `ok`.

Built-in limits: 500 rooms, 8 phones per room, 1 MB per frame, 60 connection attempts per IP per minute. Dead connections are dropped after a missed 30-second ping.

## Option B: Cloudflare Worker on your own account

`worker/` is the same relay as a Worker with one Durable Object per room. It runs on your Cloudflare account, not the shared quick-tunnel service.

```bash
cd relay/worker
npx wrangler secret put RELAY_TOKEN
npx wrangler deploy
```

Use the `wss://orbit-relay.<your-subdomain>.workers.dev` address it prints, or a custom domain.

Cloudflare is still in the network path here, with the same view as any relay operator: metadata only, never contents.

## Connecting Orbit to it

On the laptop, open Settings → Phone Link → Connection:

1. *When the phone is on another network*: **My own relay**.
2. *Relay address*: `wss://relay.example.com`.
3. *Relay token*: the same value as `RELAY_TOKEN`. It is stored encrypted on the laptop.
4. Optional: turn on **Never use third-party services (Cloudflare, ntfy.sh) for Phone Link**.
5. Save the connection, then pair the phone by scanning the QR. The QR includes the relay address, so the phone never needs the token.

## What the relay operator can see

- IP addresses of the laptop and phones, and when they connect and disconnect.
- The room id: a random value, not your name or the laptop's name.
- How many phones are connected, and how many bytes go each way.

They cannot see messages, files, voice, model settings, names or pairing codes. They can't change frames without the connection failing. The worst they can do is drop traffic, and then the phone shows "Laptop offline".

## Protocol (for anyone writing their own relay)

Laptop ↔ relay frames are binary: `[op 1 byte][connection id 4 bytes big-endian][payload]`.

- `op 1` OPEN, relay → laptop: a phone connected. The payload is JSON `{ "ip": "…" }`.
- `op 2` DATA, both ways: a sealed Phone Link frame for that phone.
- `op 3` CLOSE, both ways: the phone left, or the laptop closes it. From the laptop, the payload is `[close code 2 bytes][reason]` and the relay passes it on (4401 = revoked).

Phone ↔ relay is the plain sealed frames, one per WebSocket message. A new laptop connection to the same room replaces the old one and disconnects its phones with code 4404.

`node server.js` is about 100 lines. `test/link-e2e.js` runs a full session through it and checks that no plaintext crosses it.
