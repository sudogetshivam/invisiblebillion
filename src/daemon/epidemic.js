'use strict';

const crypto = require('crypto');
const { encrypt } = require('../crypto/encrypt');
const { getAllPending, insertMessage, getPeerPublicKey } = require('../db/messages');
const { sendMessage } = require('./tcp');
const { sendDirectMessage } = require('./udp');

function log(msg) {
    console.warn(msg);
}

/**
 * Forward pending messages to a list of peers using engine-gated PRoPHET routing.
 *
 * When an AdaptiveRoutingEngine is provided, each (peer, message) pair is
 * evaluated with engine.shouldForwardMessage() before transmitting:
 *   • If the peer is a better carrier than us → send relay
 *   • Otherwise → skip (reduces unnecessary traffic)
 *   • If engine is absent → fall back to pure epidemic (forward to all)
 *
 * @param {Array<{identity: string, ip: string} | string>} peers
 *   Array of peer objects with identity+ip, OR bare IP strings (legacy mode).
 * @param {AdaptiveRoutingEngine|null} [engine]
 *   The routing engine for forwarding decisions. Pass null for pure epidemic.
 */
function forwardMessages(peers, engine = null) {
    if (!peers || peers.length === 0) return Promise.resolve();

    // getAllPending already filters by hop_count < 20 and TTL
    const pending = getAllPending();
    if (pending.length === 0) return Promise.resolve();

    // Normalise: accept both bare IP strings (legacy) and { identity, ip } objects
    const normalisedPeers = peers.map(p =>
        typeof p === 'string' ? { identity: null, ip: p } : p
    );

    log(`[epidemic] Routing ${pending.length} msg(s) to ${normalisedPeers.length} peer(s) [engine=${engine ? 'ON' : 'OFF'}]`);

    const promises = [];
    for (const peer of normalisedPeers) {
        for (const msg of pending) {

            // Never bounce message back to original sender
            if (peer.identity && msg.from_identity === peer.identity) {
                continue;
            }

            // ── Engine-gated forwarding decision ──────────────────────────────
            // If we have an engine and a peer identity, evaluate carrier suitability.
            if (engine && peer.identity) {
                const shouldRelay = engine.shouldForwardMessage(msg.destination, peer.identity, {
                    hop_count: msg.hop_count,
                    ttl: msg.ttl,
                });
                if (!shouldRelay) {
                    log(`[epidemic] Skipping ${msg.id} → ${peer.identity} (not an eligible carrier)`);
                    continue;
                }
            }

            const relayPayload = {
                id:            msg.id,
                from_identity: msg.from_identity,
                destination:   msg.destination,
                payload:       msg.payload,     // opaque encrypted blob
                hop_count:     msg.hop_count,   // receiver will increment
                ttl:           msg.ttl,
                created_at:    msg.created_at,
            };

            // Try TCP first, fall back to UDP if TCP fails (firewall blocking)
            const relayPromise = sendMessage(peer.ip, 'relay', relayPayload)
                .catch(() =>
                    sendDirectMessage(peer.ip, 'relay', relayPayload)
                        .catch(() => {
                            log(`[epidemic] Failed to relay ${msg.id} to ${peer.ip} (TCP+UDP both failed)`);
                        })
                );

            promises.push(relayPromise);
        }
    }

    return Promise.all(promises).then(() => {
        log(`[epidemic] Bundle exchange complete`);
    });
}

/**
 * Process a received bundle of messages from a peer.
 * (Currently not used as TCP/UDP handles frames immediately)
 */
function receiveBundle(bundle) {
    return [];
}


// Send an ACK for a delivered message back through the epidemic network.
function sendAck(messageId, originalSender, myIdentity) {
    const ackId = crypto.randomUUID();
    const ackPayload = JSON.stringify({ __type: 'ack', ackMessageId: messageId });

    let encryptedPayload;
    const peerKey = getPeerPublicKey(originalSender);
    if (peerKey) {
        encryptedPayload = JSON.stringify(encrypt(ackPayload, peerKey));
    } else {
        encryptedPayload = JSON.stringify({
            __pending_encryption: true,
            __phase1_plaintext: ackPayload,
        });
    }

    log(`[epidemic] Generating ACK ${ackId} for message ${messageId} -> ${originalSender}`);

    try {
        insertMessage({
            id: ackId,
            from_identity: myIdentity,
            destination: originalSender,
            payload: encryptedPayload,
            ttl: Date.now() + 7 * 24 * 60 * 60 * 1000,
            status: 'undelivered', // Enqueue for epidemic spread
            hop_count: 0,
        });
    } catch (err) {
        log(`[epidemic] Failed to store ACK msg: ${err.message}`);
    }

    return Promise.resolve(); //just return a resolved promise since the actual sending will happen during the next epidemic forwarding cycle
}

module.exports = { forwardMessages, receiveBundle, sendAck };
