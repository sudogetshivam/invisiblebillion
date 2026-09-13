# 🌐 The Invisible Billion

**Fully offline, zero-internet, peer-to-peer messenger for the command line.**

The Invisible Billion (`ib`) lets you message people nearby — and beyond — without WiFi routers, mobile data, SIM cards, or a single server anywhere in the chain. Messages spread the way a signal spreads through a crowd: carried from device to device, network to network, until they reach their destination. No internet required, ever.

```
ib send raj@a3f2 "bhai notes bhej"
```

---

## Why it exists

Every messaging app you've used — WhatsApp, Telegram, iMessage — needs one thing in common: **internet connectivity**, usually routed through someone else's server. The Invisible Billion removes that dependency entirely.

Use it when:

- 📡 **There's no internet** — trekking, remote villages, disaster zones, basements, flights, underground metros
- 🏕️ **You're on a shared LAN/WiFi with no internet gateway** — college fests, hostels, hackathons, conferences, offline events
- 🔒 **You don't want a server in the middle** — every message is end-to-end encrypted, and no company ever sees it
- 🌍 **You want messages to "travel" with people** — a message can hop from your laptop to a friend's, to *their* friend's, across completely different WiFi networks, until it finds its destination — even if you and the recipient are never online on the same network at the same time

It's built on **Delay-Tolerant Networking (DTN)** and **epidemic routing** — the same category of technique used in disaster-relief mesh networks and interplanetary communication research, packaged as a dead-simple CLI tool. There are an estimated billion+ people who go online rarely, briefly, or never — this is infrastructure for reaching them anyway.

---

## How it actually works

There is no central server. Instead:

1. **Discovery** — Every running `ib` daemon broadcasts a small UDP announcement (`"I'm raj@a3f2, here's my public key"`) on the local network every 15 seconds.
2. **Direct delivery** — If your recipient is on the *same* network right now, `ib` encrypts your message with their public key and delivers it straight away over TCP (falling back to UDP if a firewall blocks TCP).
3. **Epidemic spread (store-carry-forward)** — If they're *not* on your network, `ib` doesn't give up. It stores the encrypted message locally and hands a copy to every other `ib` peer it meets. Each of those peers does the same. The message spreads through the network of devices, hopping along wherever people physically carry their laptops — until, eventually, someone who is connected to the recipient's network delivers it. This is exactly how epidemic routing works in DTN research: **your data moves because people move.**
4. **Acknowledgement** — Once delivered, an encrypted ACK travels back the same way, so the sender can confirm delivery with `ib status`.

Messages that can't be delivered expire automatically after 7 days (TTL) and are capped at 20 hops, so nothing spreads forever.

---

## Features

- 🔐 **End-to-end encrypted** — Hybrid RSA-2048 + AES-256-GCM. Every message uses a fresh AES key, encrypted with the recipient's RSA public key. Not even relaying peers can read message contents.
- 🛰️ **Zero infrastructure** — no server, no account, no phone number. Your identity is generated locally.
- 🔁 **Automatic retries** — a background sweep re-attempts undelivered messages every 30 seconds as new peers appear.
- 🩹 **Resilient to network changes** — switch WiFi networks mid-conversation and `ib` re-announces itself and re-syncs automatically.
- 🖥️ **Runs as a background daemon** — start it once, forget about it; the CLI just talks to the daemon over a local socket.
- 📦 **Lightweight local storage** — SQLite, stored entirely on your machine at `~/.pollen`.

---

## Installation

**Requirements:** Node.js ≥ 18

```bash
npm install -g the-invisible-billion-cli@latest
```

That's it — the `ib` command is now available globally.

---

## Quick start

### 1. Start the daemon

```bash
ib start
```

```
🌐 Welcome to The Invisible Billion!
```

The first time you run this, `ib` will ask you to pick a username and will generate:
- A unique identity like `shivam@a3f2` (`username@` + a random 4-character ID)
- An RSA-2048 keypair, stored locally

Share your identity (e.g. `shivam@a3f2`) with anyone who wants to message you — that's your entire "address."

### 2. Find peers on your network

```bash
ib scan
```

```
🌐 IB peers on this network:

  Identity           IP Address        Last Seen     Status
  ─────────────────  ────────────────  ────────────  ──────
  raj@a3f2           192.168.1.25      12s ago       🟢 Online

  Total: 1 peer(s)
```

### 3. Send a message

```bash
ib send raj@a3f2 "bhai notes bhej"
```

If `raj@a3f2` is on your current network, it's encrypted and delivered instantly. If not, it's safely queued and will deliver automatically the moment `ib` finds a path to them — even through other peers' devices.

### 4. Check delivery status

```bash
ib status <messageId>
```

```
🚀 Message Status
   ID:          f3a1...
   To:          raj@a3f2
   Status:      In Transit   (message is spreading through the network)
   Hops:        2
   Created:     9/13/2026, 10:02:11 AM
   Expires:     9/20/2026, 10:02:11 AM
```

### 5. Force a sync (optional)

```bash
ib sync
```

Manually triggers an immediate delivery/relay attempt with every peer currently visible — useful right after joining a new network.

### 6. Stop the daemon

```bash
ib stop
```

---

## Command reference

```
Usage: ib [options] [command]

The Invisible Billion — Fully offline, peer-to-peer epidemic routing messenger.
Messages spread like a virus through human movement. Zero internet.

Options:
  -V, --version                        output the version number
  -h, --help                           display help for command
```

| Command | Description |
|---|---|
| `ib start` | Start the background daemon (also handles first-run identity/keypair setup) |
| `ib stop` | Stop the daemon |
| `ib scan` | List all IB peers discovered on the current network |
| `ib send <identity> <message>` | Send an encrypted message to an IB user |
| `ib status <messageId>` | Check delivery status of a message |
| `ib sync` | Manually trigger epidemic sync with peers on the current network |
| `ib file <identity> <filepath>` | Send a file offline via epidemic routing *(Phase 5 — in progress)* |
| `ib help [command]` | Display help for a command |

> Received messages land in an inbox log, and daemon logs are written locally for debugging.

---

## Security model

- **Hybrid encryption** — each message gets a fresh, random AES-256 key (via `AES-256-GCM`), which is itself encrypted using the recipient's RSA-2048 public key (`RSA-OAEP`, SHA-256). Only the recipient's private key can unlock it.
- **No plaintext ever touches the network** once a peer's public key is known — relaying peers only ever see an opaque encrypted blob and route it blindly.
- **Local-only keys** — your private key never leaves your machine and is never transmitted.
- ⚠️ If you message someone before their public key has been discovered (i.e. before you've ever seen them on a network), the message is queued and only properly encrypted once their key becomes known — the CLI always tells you whether a message went out encrypted or is pending discovery.

---

## Architecture

```
ib (CLI)                → Commander.js entry point, talks to the daemon over a local IPC socket
daemon/                  → the actual background process
  ├─ udp                 → peer discovery (broadcast) + UDP delivery fallback
  ├─ tcp                 → reliable message delivery with ACKs
  ├─ epidemic            → store-carry-forward relay logic
  └─ network             → detects network/IP changes and re-announces
crypto/                  → RSA keypair management + hybrid AES/RSA encryption
identity/                → local identity generation (username@xxxx)
db/                      → SQLite storage for messages & known peers
```

The CLI and daemon are deliberately separate: the daemon runs continuously in the background (survives you closing the terminal), while the CLI is a thin client that just sends commands over a local socket and prints the response.

---

## Known limitations

- Peer discovery currently works via **LAN broadcast**, so two peers must be on the same local subnet at some point for a message to physically hop between them. The "spread" across different networks happens because *devices* carrying the daemon move between networks — not through any global rendezvous server.
- No NAT traversal across the wider internet — this is intentionally a local/offline-first tool, not an internet messenger.
- Large payloads may fail over the UDP fallback path (~60 KB cap); TCP has no such limit.
- File transfer (`ib file`) is an in-progress feature — see Roadmap.

---


---

## Contributing

Issues and PRs are welcome. If you're exploring DTN / epidemic routing / mesh networking, this is a fun, hands-on codebase to dig into — the core relay logic lives in a small, readable set of daemon modules (`epidemic`, `tcp`, `udp`).

## License

MIT © [sudogetshivam](https://github.com/sudogetshivam)
