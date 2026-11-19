# Phone Link and Orbit Remote

Phone Link lets you use Orbit on your laptop from your Android phone with the **Orbit Remote** app. The phone is a remote screen. Orbit still runs on your laptop: your API keys, model settings, files, browser, memory and tasks stay there. The phone never receives an API key.

Phone Link is **off by default**. While it is off, Orbit opens no port and contacts no Phone Link service.

## How it works

1. **Turn it on.** On the laptop, open Settings → Phone Link and turn on Phone Link.
2. **Pair.** Press *Pair a phone*. Orbit shows a QR code and an 8-character code (for example `HJFN-JA2Y`) that expire after 5 minutes. In Orbit Remote, tap *Scan the QR code*, or type the code.
   - The QR holds the laptop's public key, the one-time code, the laptop's name and how to reach it. It only ever appears on the laptop's screen.
   - One code pairs one phone. After 5 wrong codes, Orbit throws the code away.
   - Up to 8 phones can be paired.
3. **Use it.** The phone shows the same chat, projects, tasks, memory, Orbiter and Settings screens as the desktop. A chip shows how it is connected, for example "same Wi-Fi", "tunnel" or "relay".
4. **Revoke.** Settings → Phone Link → Paired phones lists every phone. Revoking one cuts its connection at once, and the phone forgets the pairing.

### Ways the phone reaches the laptop

| Route | When it's used | Who carries the bytes |
|---|---|---|
| Same network | Phone and laptop on the same Wi-Fi | Nobody else: a direct WebSocket to the laptop (port 47821 by default) |
| Cloudflare quick tunnel | Phone on another network (default) | Cloudflare, through the `cloudflared` copy bundled with Orbit (a free `trycloudflare.com` address, no account) |
| Your own relay | Phone on another network, if you choose *My own relay* | The relay you run (see [relay/README.md](../relay/README.md)) |
| Off | *Don't connect from other networks* | Same network only |

A quick-tunnel address changes whenever the tunnel restarts. To let phones find the new address, the laptop posts an encrypted "here is my laptop now" note to an **ntfy** topic (`https://ntfy.sh` by default, or your own ntfy server). Each paired phone has its own topic, derived from that phone's secret. The note is refreshed every 6 hours. A relay address doesn't change, so the relay route doesn't use ntfy.

Typing the short code (instead of scanning) also uses ntfy. The laptop posts its pairing offer, encrypted with a key stretched from the code, to a topic derived from the code. The code itself is never posted.

## End-to-end encryption happens inside Orbit

All encryption is done by Orbit itself, in `src/link/proto.js`. The phone runs the same file. Nothing depends on TLS from Cloudflare, the relay or the Wi-Fi network: those hops only ever carry sealed bytes. Same-network connections are plain `ws://` for that reason.

- **Pairing (QR).** The phone creates a one-time key pair and sends the code and its name, sealed to the laptop's public key from the QR (NaCl `box`: X25519 + XSalsa20-Poly1305). The laptop answers with a new random 32-byte device secret, sealed to the phone's one-time key. The secret is stored encrypted in the laptop's settings and in the phone's app storage.
- **Every connection.** Phone and laptop exchange fresh X25519 keys inside a hello sealed with a key derived from the device secret. Session keys come from the device secret plus that exchange, so each connection has new keys (forward secrecy). There is one key per direction.
- **Every message.** Messages are sealed with XSalsa20-Poly1305 and carry a strictly increasing counter. A replayed, dropped, reordered or altered frame fails, and the connection is closed. Hellos carry a time and a random value the laptop remembers, so a recorded hello can't be replayed. Large messages, file chunks and audio are split into sealed parts of at most 96 KB.
- **Rendezvous notes.** Notes are sealed with a key derived from the device secret. Only that phone can read the tunnel address in them.

The test `test/link-e2e.js` records every byte the fake Cloudflare tunnel, the fake ntfy and the real relay forward during a full session. It then searches them for the chat text, file contents, model name, assistant name, user name, pairing code and file names, both as plain text and as base64. None of them appear.

## What Cloudflare, ntfy and the relay can and cannot see

| | Can see | Cannot see |
|---|---|---|
| **Cloudflare** (quick tunnel) | Your laptop's and your phone's IP addresses; when they connect; how many bytes go each way and when; the random `trycloudflare.com` address | What you type, Orbit's replies, files, voice, model or key settings, names, the pairing code. Cloudflare terminates TLS but only finds sealed frames inside. |
| **ntfy** (rendezvous and short-code pairing) | The IP addresses that post and read notes; random-looking topic names; when notes are posted; the size of each sealed note | The tunnel address inside a note, which phone a topic belongs to, the pairing code, the laptop's key or name |
| **Your relay** | IP addresses; a random room id; connect and disconnect times; how many phones are connected; byte counts | Anything inside the frames. The relay copies bytes and stores nothing. |

No route lets any of them change messages without detection. A changed frame fails authentication and closes the connection.

What they *could* do is refuse or drop traffic, so the phone shows "Laptop offline", and log the metadata above. If that metadata matters to you, use the relay or the switch below.

### Short codes versus the QR

Scanning the QR is the stronger way to pair. With a short code, the encrypted pairing offer sits on ntfy for up to 5 minutes. Anyone who learns the code in that window could open the offer and try to pair first. The 5-minute expiry, one phone per code, the 5-wrong-tries limit and the slow code stretching (20,000 SHA-512 rounds) make this hard, and the new phone appears in *Paired phones* where you can revoke it.

## Turning off third parties

In Settings → Phone Link → Connection, turn on **Never use third-party services (Cloudflare, ntfy.sh) for Phone Link**. Then:

- The Cloudflare tunnel is not started. The *Cloudflare quick tunnel* choice behaves like *Don't connect from other networks*.
- Nothing is posted to `ntfy.sh`. Short-code pairing is off unless you set your own ntfy server, so pair with the QR.
- The QR code only lists the same-network address and, if you set one, your relay.

With the switch on, a phone on another network can still connect through **your own relay**. You can run it on your own server, or as a Worker on your own Cloudflare account. See [relay/README.md](../relay/README.md).

## What a paired phone can and cannot do

A paired phone can do what you can do in Orbit's window: chat, run tasks, use Orbiter, read memory, change most settings, send files to the laptop (up to 50 MB each) and download files from the laptop. Treat pairing a phone like handing over your unlocked laptop's Orbit window, and revoke phones you no longer use.

A phone cannot:

- Read API keys or reveal saved passwords.
- Manage Phone Link: pair, revoke or change its settings, or turn it off.
- Download `settings.json`, the Phone Link state, password, vault, credential or token files, anything under `AppData`, or key folders such as `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker` and `gcloud`.
- Download anything outside your home folder. Inside Orbit's data folder, only projects, workspace, attachments, outputs and memory are allowed.
- Start live voice calls, the wake word or the Companion view. These stay on the laptop. The phone has the mic button and spoken replies.

## Settings reference

| Setting | Default | |
|---|---|---|
| Turn on Phone Link | off | |
| Same network | on | Listens on all interfaces when on; on 127.0.0.1 only when off |
| When the phone is on another network | Cloudflare quick tunnel + ntfy rendezvous | Or *My own relay*, or *Don't connect from other networks* |
| Relay address / token | empty | `wss://…`; the token must match `RELAY_TOKEN` on the relay. Stored encrypted. |
| Never use third-party services | off | See above |
| Rendezvous server (ntfy) | `https://ntfy.sh` | Any ntfy server you trust |
| Port | 47821 | |

Logs go to `phone-link.log` in Orbit's data folder (`%APPDATA%\Orbit`).

## Building and testing

- Windows build: `npm run dist:win` bundles a `cloudflared` checked against Cloudflare's published SHA256SUMS (`build/bundle-cloudflared.js`) into `resources/cloudflared`.
- Orbit Remote APK: `remote/tools/build-apk.sh` (Android SDK build-tools 35 and a JDK, no Gradle), or open `remote/android` in Android Studio. The phone UI is the desktop renderer plus small shims, built by `remote/build.js`.
- Tests:
  - `node test/link-proto-test.js`: crypto, pairing and protocol unit tests.
  - `xvfb-run -a npx electron --no-sandbox test/link-e2e.js`: full session over LAN, tunnel and relay, with a plaintext leak check.
  - `node test/remote-ui-smoke.js`: the phone UI in Chromium against a headless Orbit. Needs `CHROMIUM=` and `xvfb-run`.
