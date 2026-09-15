'use strict';

/**
 * Key Discovery — Control Plane (Flooding)
 *
 * Implements the two-packet handshake used to discover a peer's RSA public key
 * before we can encrypt a message for them.
 *
 *   Sender                  Relay(s)                  Target
 *     │── key_req ──────────────►│
 *     │                          │── key_req ──────────►│
 *     │                          │◄─ key_res ───────────│  (target replies)
 *     │◄─ key_res ───────────────│
 *     │  encrypt pending msgs
 *     │  → promote to 'undelivered' (Adaptive Engine picks up)
 *
 * Control packets bypass the AdaptiveRoutingEngine entirely — they flood
 * aggressively to minimise key-discovery latency.
 *
 * Data packets (encrypted payloads) are NEVER forwarded while they still
 * carry __pending_encryption status. The encryption step happens here,
 * in onKeyResolved(), after the key_res is received.
 */

const crypto  = require('crypto');
const { encrypt }                      = require('../crypto/encrypt');
const { sendMessage }                  = require('./tcp');
const { sendDirectMessage }            = require('./udp');
const {
    getPeerPublicKey,
    upsertPeer,
    getPendingEncryptionMessages,
    bulkEncryptPending,
    getActivePeers,
} = require('../db/messages');

const KEY_REQ_TTL_MS  = 60  * 1000;  // key_req lives for 60 s
const KEY_RES_TTL_MS  = 60  * 1000;  // key_res lives for 60 s
const MAX_KEY_HOPS    = 15;          // prevent infinite flooding

function log(msg) {
    console.warn(msg);
}

// ---------------------------------------------------------------------------
// Packet constructors
// ---------------------------------------------------------------------------

/**
 * Build a key_req control packet.
 *
 * @param {string} requesterId   Identity of the node that needs the key.
 * @param {string} targetId      Identity whose public key we are looking for.
 * @returns {object} key_req packet ready for TCP/UDP transmission.
 */
function buildKeyReq(requesterId, targetId) {
    return {
        id:           crypto.randomUUID(),
        type:         'key_req',
        from_identity: requesterId,
        destination:  targetId,         // logical destination = target peer
        payload:      JSON.stringify({ __ctrl: 'key_req', requesterId, targetId }),
        hop_count:    0,
        ttl:          Date.now() + KEY_REQ_TTL_MS,
        created_at:   Date.now(),
    };
}

/**
 * Build a key_res control packet.
 *
 * @param {string} responderId     Identity of the node that has the key.
 * @param {string} requesterId     Identity of the node that asked for it.
 * @param {string} targetId        Identity whose key is being returned.
 * @param {string} publicKeyPem    RSA public key PEM of targetId.
 * @returns {object} key_res packet.
 */
function buildKeyRes(responderId, requesterId, targetId, publicKeyPem) {
    return {
        id:           crypto.randomUUID(),
        type:         'key_res',
        from_identity: responderId,
        destination:  requesterId,      // reply goes to the original requester
        payload:      JSON.stringify({ __ctrl: 'key_res', targetId, publicKey: publicKeyPem }),
        hop_count:    0,
        ttl:          Date.now() + KEY_RES_TTL_MS,
        created_at:   Date.now(),
    };
}

// ---------------------------------------------------------------------------
// Outbound: flood a key_req to all currently reachable peers
// ---------------------------------------------------------------------------

/**
 * Flood a key_req to all active peers to discover a target's public key.
 *
 * Called by the daemon when a user tries to send a message but the recipient's
 * public key is not yet known.
 *
 * @param {string}   targetIdentity  Peer whose public key we need.
 * @param {string}   myIdentity      Our own identity.
 * @param {Array}    [activePeers]   Optional pre-fetched peer list; if omitted, fetched from DB.
 */
function floodKeyRequest(targetIdentity, myIdentity, activePeers) {
    if (!targetIdentity || !myIdentity) return;

    const peers = activePeers || getActivePeers().filter(p => p.ip);
    if (peers.length === 0) {
        log(`[key-discovery] No active peers — will retry key_req when a peer connects`);
        return;
    }

    const packet = buildKeyReq(myIdentity, targetIdentity);
    log(`[key-discovery] Flooding key_req for ${targetIdentity} to ${peers.length} peer(s)`);

    for (const peer of peers) {
        if (!peer.ip) continue;
        sendMessage(peer.ip, 'key_req', packet)
            .catch(() =>
                sendDirectMessage(peer.ip, 'key_req', packet)
                    .catch(() => {
                        log(`[key-discovery] key_req to ${peer.identity || peer.ip} failed (TCP+UDP)`);
                    })
            );
    }
}

// ---------------------------------------------------------------------------
// Inbound: handle a key_req received from another peer
// ---------------------------------------------------------------------------

/**
 * Process an incoming key_req packet.
 *
 * Logic:
 *   1. If expired or hop limit exceeded → drop silently.
 *   2. If we ARE the target → reply with our own public key (key_res).
 *   3. If we HAVE the target's key in our peers table → reply with key_res.
 *   4. Otherwise → re-flood to peers we know (excluding sender).
 *
 * @param {object}   packet          The received key_req packet object.
 * @param {string}   remoteIP        IP of the peer that sent this packet.
 * @param {string}   myIdentity      Our own identity string.
 * @param {string}   myPublicKey     Our RSA public key PEM.
 * @param {Function} sendResponse    fn(ip, frameType, packet) — sends a packet back.
 */
function handleKeyRequest(packet, remoteIP, myIdentity, myPublicKey, sendResponse) {
    if (!packet || !packet.payload) return;

    // Parse the control payload
    let ctrl;
    try {
        ctrl = JSON.parse(packet.payload);
    } catch {
        log(`[key-discovery] Malformed key_req payload from ${remoteIP}`);
        return;
    }

    const { requesterId, targetId } = ctrl;
    if (!requesterId || !targetId) return;

    // TTL check
    if (packet.ttl && Date.now() > packet.ttl) {
        log(`[key-discovery] key_req for ${targetId} expired — dropping`);
        return;
    }
    // Hop limit check
    const hops = (packet.hop_count || 0) + 1;
    if (hops > MAX_KEY_HOPS) {
        log(`[key-discovery] key_req for ${targetId} hit hop limit — dropping`);
        return;
    }

    // ── Case 1: We ARE the target ────────────────────────────────────────────
    if (targetId === myIdentity) {
        log(`[key-discovery] key_req matched us — replying with our own public key`);
        const res = buildKeyRes(myIdentity, requesterId, myIdentity, myPublicKey);
        sendResponse(remoteIP, 'key_res', res);
        return;
    }

    // ── Case 2: We HAVE the key in our local peer table ─────────────────────
    const knownKey = getPeerPublicKey(targetId);
    if (knownKey) {
        log(`[key-discovery] key_req — found ${targetId}'s key locally — forwarding key_res`);
        const res = buildKeyRes(myIdentity, requesterId, targetId, knownKey);
        sendResponse(remoteIP, 'key_res', res);
        return;
    }

    // ── Case 3: Re-flood to all OTHER peers (excluding the sender) ───────────
    const peers = getActivePeers().filter(p => p.ip && p.ip !== remoteIP);
    if (peers.length > 0) {
        log(`[key-discovery] Re-flooding key_req for ${targetId} to ${peers.length} peer(s)`);
        const forwarded = Object.assign({}, packet, { hop_count: hops });
        for (const peer of peers) {
            sendMessage(peer.ip, 'key_req', forwarded)
                .catch(() =>
                    sendDirectMessage(peer.ip, 'key_req', forwarded)
                        .catch(() => {})
                );
        }
    } else {
        log(`[key-discovery] key_req for ${targetId} — no other peers to re-flood`);
    }
}

// ---------------------------------------------------------------------------
// Inbound: handle a key_res — the key has been found
// ---------------------------------------------------------------------------

/**
 * Process an incoming key_res packet.
 *
 * Logic:
 *   1. Parse the key_res payload to extract { targetId, publicKey }.
 *   2. Save the public key to the local peers DB.
 *   3. Find all messages in '__pending_encryption' state for that target.
 *   4. Encrypt each one with the newly discovered key.
 *   5. Promote them to status='undelivered' so the Adaptive Engine can route them.
 *
 * @param {object}   packet       The received key_res packet.
 * @param {string}   myIdentity   Our own identity (to skip responses not meant for us).
 * @param {Function} onEncrypted  Optional callback(targetId, count) after re-encryption.
 */
function handleKeyResponse(packet, myIdentity, onEncrypted) {
    if (!packet || !packet.payload) return;

    // Only process responses addressed to us
    if (packet.destination && packet.destination !== myIdentity) {
        log(`[key-discovery] key_res not for us (dest=${packet.destination}) — relaying`);
        // The caller (daemon) handles relay if needed
        return;
    }

    let ctrl;
    try {
        ctrl = JSON.parse(packet.payload);
    } catch {
        log(`[key-discovery] Malformed key_res payload`);
        return;
    }

    const { targetId, publicKey } = ctrl;
    if (!targetId || !publicKey) {
        log(`[key-discovery] key_res missing targetId or publicKey — dropping`);
        return;
    }

    // ── Step 1: Persist the newly discovered public key ──────────────────────
    log(`[key-discovery] ✅ key_res received for ${targetId} — saving public key`);
    upsertPeer(targetId, publicKey, null /* IP unknown from control plane */);

    // ── Step 2: Find all pending-encryption messages for this target ─────────
    const pending = getPendingEncryptionMessages(targetId);
    if (pending.length === 0) {
        log(`[key-discovery] No pending messages for ${targetId} — nothing to encrypt`);
        if (onEncrypted) onEncrypted(targetId, 0);
        return;
    }

    log(`[key-discovery] Encrypting ${pending.length} pending message(s) for ${targetId}`);

    // ── Step 3: Encrypt each message's plaintext with the discovered key ─────
    const updates = [];
    for (const msg of pending) {
        try {
            const payloadObj = JSON.parse(msg.payload);
            // Support both: pure __pending_encryption flag objects and plain text
            const plaintext = payloadObj.__phase1_plaintext || payloadObj;
            if (!plaintext) {
                log(`[key-discovery] Message ${msg.id} has no plaintext — skipping`);
                continue;
            }
            const plaintextStr = typeof plaintext === 'string'
                ? plaintext
                : JSON.stringify(plaintext);
            const encryptedBlob = encrypt(plaintextStr, publicKey);
            updates.push({ id: msg.id, encryptedPayload: JSON.stringify(encryptedBlob) });
        } catch (err) {
            log(`[key-discovery] Failed to encrypt pending msg ${msg.id}: ${err.message}`);
        }
    }

    // ── Step 4: Atomic bulk-update — flip payload + status in one transaction ─
    if (updates.length > 0) {
        bulkEncryptPending(updates);
        log(`[key-discovery] ✅ ${updates.length} message(s) encrypted and promoted to 'undelivered'`);
    }

    if (onEncrypted) onEncrypted(targetId, updates.length);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

module.exports = {
    floodKeyRequest,
    handleKeyRequest,
    handleKeyResponse,
    buildKeyReq,
    buildKeyRes,
};
