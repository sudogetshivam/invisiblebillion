# The Invisible Billion — User Guide

> Send messages anywhere. No internet required.

---

## What is this?

**The Invisible Billion** (`ib`) is an offline, peer-to-peer messenger. Messages travel through human movement — carried from device to device over local WiFi until they reach the destination. No servers. No internet. No accounts.

---

## Prerequisites

You need **Node.js v18 or higher** installed.

- Download from [nodejs.org](https://nodejs.org) (pick the **LTS** version)
- Verify it works:
  ```bash
  node -v
  npm -v
  ```
  Both should print a version number.

---

## Installation

```bash
npm install -g the-invisible-billion-cli
```

Verify:
```bash
ib --version
```

---

## Quick Start

### 1. Start the daemon

```bash
ib start
```

This starts a background process that handles all networking, message storage, and encryption. You'll see your **identity** printed:

```
✅ Daemon is running.
   Your identity: yourname@a3f2
```

> **Write down your identity.** This is how others send messages to you — think of it as your offline address.

---

### 2. See who's nearby

```bash
ib scan
```

Lists all peers currently visible on your local network (WiFi, LAN, etc.).

---

### 3. Send a message

```bash
ib send <identity> "<message>"
```

**Examples:**
```bash
ib send raj@a3f2 "bhai notes bhej"
ib send priya@c9e1 "kab miloge?"
```

#### What happens when you send?

| Situation | What `ib` does |
|---|---|
| Recipient is on your current network | Encrypts and delivers directly over WiFi |
| Recipient's key is unknown | Stores the message safely, floods a key discovery request to find their public key |
| Recipient is offline / different network | Stores the message, spreads it epidemically to all nearby peers who will carry it forward |

All messages are end-to-end encrypted with RSA. Nobody carrying your message can read it.

---

### 4. Check delivery status

```bash
ib status <message-id>
```

The message ID is printed after you send. Statuses:

| Status | Meaning |
|---|---|
| `🔍 Key discovery` | Locating recipient's public key — message stays on your device until found |
| `⏳ Undelivered` | Message stored, waiting to find a carrier |
| `🚚 In Transit` | A peer is physically carrying your message |
| `✅ Delivered` | Recipient got it |

---

### 5. Read your inbox

```bash
ib inbox
```

Shows all messages received and decrypted on your device.

---

### 6. Send a file

```bash
ib file <identity> <filepath>
```

**Example:**
```bash
ib file raj@a3f2 ./notes.pdf
```

Sends any file via the same epidemic routing network. The file is chunked, encrypted, and carried to the destination.

---

### 7. Manual sync

```bash
ib sync
```

Forces an immediate epidemic sync — pushes all stored messages to every peer currently reachable on your network. Useful if you just joined a new WiFi and want to trigger delivery right away.

---

### 8. Stop the daemon

```bash
ib stop
```

---

## All Commands

| Command | Description |
|---|---|
| `ib start` | Start the background daemon |
| `ib stop` | Stop the daemon |
| `ib scan` | List peers on the current network |
| `ib send <identity> "<message>"` | Send an encrypted message |
| `ib status <message-id>` | Check delivery status |
| `ib inbox` | Read received messages |
| `ib file <identity> <filepath>` | Send a file |
| `ib sync` | Manually push messages to current network |

---

## How the routing works

**IB uses two routing planes:**

**Control Plane — Key Discovery (Flooding)**
When you send to someone whose public key is unknown, `ib` floods a `key_req` packet to all reachable peers. Any node that knows the key replies with a `key_res`. Once received, your message is encrypted and enters the data plane.

**Data Plane — Epidemic Routing (PRoPHET)**
Encrypted messages spread through the network peer-to-peer. Each node keeps a delivery probability score for every destination it has encountered. Messages are forwarded to peers that are statistically better carriers — reducing redundant traffic while maximising delivery probability across disconnected networks.

**Privacy guarantee:** Messages in pending-encryption state never leave your device. Plaintext is never transmitted.

---

## How encryption works

When you start `ib` for the first time, it generates an RSA keypair:

- **Public key** — shared with all peers on the network automatically via UDP broadcast
- **Private key** — never leaves your device

When someone sends you a message:
1. Their `ib` fetches your public key (via UDP discovery or key_req flooding)
2. The message is encrypted with your public key
3. Only your device, holding your private key, can decrypt it

Intermediate relay nodes carry the encrypted blob without ever being able to read it.

---

## Identity format

Identities look like: `username@xxxx`

- `username` — your local name (set during init or derived from your system)
- `xxxx` — a 4-character hex fingerprint of your public key

Example: `shivam@a3f2`, `raj@c9e1`

Share your identity with anyone who might want to reach you — over WhatsApp, in person, anywhere. The identity itself is not sensitive.

---

## Data stored on your device

All data lives in `~/.ib/` (i.e., `C:\Users\<you>\.ib\` on Windows):

| File | Contents |
|---|---|
| `ib.db` | SQLite database — messages, peers, routing scores |
| `identity.json` | Your identity and keypair |
| `daemon.log` | Daemon activity log |
| `inbox.log` | Raw inbox file (also readable via `ib inbox`) |
| `daemon.pid` | PID of the running daemon |

---

## Troubleshooting

**Daemon won't start**
```bash
ib stop
ib start
```

**Peer not showing in scan**
- Make sure both devices are on the same WiFi/LAN
- Check that the daemon is running on both devices (`ib start`)
- Wait ~10 seconds — peers announce themselves via UDP broadcast

**Message stuck in key discovery**
- The recipient must have their daemon running at least once on any reachable network so their key propagates
- Once any peer who knows their key comes online near you, key discovery resolves automatically

**Check daemon logs**

Windows:
```powershell
Get-Content $env:USERPROFILE\.ib\daemon.log -Tail 50
```

Mac/Linux:
```bash
tail -50 ~/.ib/daemon.log
```
