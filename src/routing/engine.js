'use strict';

/**
 * AdaptiveRoutingEngine — Context-Aware PRoPHET-based DTN Routing Engine.
 *
 * Builds on the PRoPHET (Probabilistic ROuting Protocol using History of
 * Encounters and Transitivity) algorithm but makes the core constants
 * ALPHA and GAMMA dynamic, adapting them in real-time to the observed
 * inter-contact behaviour of the local network.
 *
 * Notation: P(A, B) = delivery predictability from A to B, in [0.0, 1.0]
 *
 *   Direct:       P_new = P_old + (1-P_old) * alpha
 *   Decay:        P_new = P_old * (gamma ^ k)   where k = hours elapsed
 *   Transitivity: P(us,T) += (1-P(us,T)) * P(us,R) * P(R,T) * beta
 *
 * Novelty over vanilla PRoPHET:
 *   - ALPHA is computed per-pair from avg_inter_contact_time.
 *     Frequent encounters -> high ALPHA (react fast to new info).
 *     Sparse encounters   -> low  ALPHA (resist noise).
 *   - GAMMA is derived from the same signal.
 *     Dense network  -> fast decay (stale info is quickly replaced).
 *     Sparse network -> slow decay (information is precious, preserve it).
 *   - BETA stays fixed at 0.25.
 *
 * SQLite table: predictability_scores
 *   peer_id                TEXT    - carrier node identity
 *   target_id              TEXT    - destination node identity
 *   score                  REAL    - P(peer, target) in [0.0, 1.0]
 *   last_updated           INTEGER - Unix epoch ms of last score write
 *   encounter_count        INTEGER - number of direct encounters recorded
 *   avg_inter_contact_time INTEGER - rolling average ms between encounters
 *   PRIMARY KEY: (peer_id, target_id)
 */

const { openDb } = require('../db/index');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Transitivity weight - fixed per specification. */
const BETA = 0.25;

// ALPHA bounds: controls how aggressively a direct encounter raises the score.
const ALPHA_MAX = 0.9; // frequent contacts  -> fast reaction
const ALPHA_MIN = 0.1; // sparse contacts    -> noise resistance

// GAMMA bounds (decay factor applied per elapsed hour).
// score_new = score_old * (GAMMA ^ hours_elapsed)
const GAMMA_DENSE  = 0.70; // dense network  -> rapid decay (info refreshed often)
const GAMMA_SPARSE = 0.98; // sparse network -> slow decay  (every bit of info matters)

// Frequency classification thresholds for log-linear interpolation.
const INTER_CONTACT_FREQUENT_MS = 5  * 60 * 1000;      //  5 minutes
const INTER_CONTACT_SPARSE_MS   = 6  * 60 * 60 * 1000; //  6 hours

/**
 * Minimum score advantage required to prefer a relay over the current node.
 * Prevents thrashing when scores are nearly equal.
 */
const FORWARD_THRESHOLD = 0.05;

// ---------------------------------------------------------------------------
// AdaptiveRoutingEngine
// ---------------------------------------------------------------------------

class AdaptiveRoutingEngine {

    /**
     * @param {string} myIdentity  Local node identity, e.g. 'shivam@a3f2'.
     *                             Used as peer_id for all self-originating records.
     */
    constructor(myIdentity) {
        if (!myIdentity) throw new Error('AdaptiveRoutingEngine: myIdentity is required');
        this._db         = openDb();
        this._myIdentity = myIdentity;
        this._initSchema();
    }

    // -------------------------------------------------------------------------
    // Schema
    // -------------------------------------------------------------------------

    _initSchema() {
        this._db.exec(`
            CREATE TABLE IF NOT EXISTS predictability_scores (
                peer_id                TEXT    NOT NULL,
                target_id              TEXT    NOT NULL,
                score                  REAL    NOT NULL DEFAULT 0.0,
                last_updated           INTEGER NOT NULL,
                encounter_count        INTEGER NOT NULL DEFAULT 0,
                avg_inter_contact_time INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (peer_id, target_id)
            );
        `);
        this._db.exec(`
            CREATE INDEX IF NOT EXISTS idx_ps_peer_id
            ON predictability_scores (peer_id);
        `);
        this._db.exec(`
            CREATE INDEX IF NOT EXISTS idx_ps_target_id
            ON predictability_scores (target_id);
        `);
    }

    // -------------------------------------------------------------------------
    // Dynamic constant calculators
    // -------------------------------------------------------------------------

    /**
     * Compute dynamic ALPHA for a given avg inter-contact time.
     *
     * Uses log-linear interpolation between the frequency thresholds so that
     * the transition is smooth rather than a hard step function.
     *
     * @param {number} avgInterContactMs  Rolling average ms between encounters.
     * @returns {number} ALPHA in [ALPHA_MIN, ALPHA_MAX]
     */
    _calcDynamicAlpha(avgInterContactMs) {
        // Cold start: no history yet - use midpoint
        if (!avgInterContactMs || avgInterContactMs <= 0) {
            return (ALPHA_MAX + ALPHA_MIN) / 2;
        }

        const t      = Math.max(INTER_CONTACT_FREQUENT_MS,
                                Math.min(INTER_CONTACT_SPARSE_MS, avgInterContactMs));
        const logT   = Math.log(t);
        const logMin = Math.log(INTER_CONTACT_FREQUENT_MS);
        const logMax = Math.log(INTER_CONTACT_SPARSE_MS);

        // ratio = 0 (very frequent) ... 1 (very sparse)
        const ratio = (logT - logMin) / (logMax - logMin);

        // Inverse: frequent -> high ALPHA
        return ALPHA_MAX - ratio * (ALPHA_MAX - ALPHA_MIN);
    }

    /**
     * Compute dynamic GAMMA (decay factor per hour).
     *
     * Frequent encounters -> denser network -> faster decay.
     * Sparse encounters   -> sparse network -> slower decay.
     *
     * @param {number} avgInterContactMs
     * @returns {number} GAMMA in [GAMMA_DENSE, GAMMA_SPARSE]
     */
    _calcDynamicGamma(avgInterContactMs) {
        if (!avgInterContactMs || avgInterContactMs <= 0) {
            return (GAMMA_DENSE + GAMMA_SPARSE) / 2;
        }

        const t      = Math.max(INTER_CONTACT_FREQUENT_MS,
                                Math.min(INTER_CONTACT_SPARSE_MS, avgInterContactMs));
        const logT   = Math.log(t);
        const logMin = Math.log(INTER_CONTACT_FREQUENT_MS);
        const logMax = Math.log(INTER_CONTACT_SPARSE_MS);
        const ratio  = (logT - logMin) / (logMax - logMin);

        // ratio = 0 -> frequent -> GAMMA_DENSE (fast decay)
        // ratio = 1 -> sparse   -> GAMMA_SPARSE (slow decay)
        return GAMMA_DENSE + ratio * (GAMMA_SPARSE - GAMMA_DENSE);
    }

    // -------------------------------------------------------------------------
    // Internal DB helpers
    // -------------------------------------------------------------------------

    /** Clamp a score value to the valid [0.0, 1.0] range. */
    _clamp(val) {
        return Math.max(0.0, Math.min(1.0, val));
    }

    /** Fetch a single score record. Returns null on cold start. */
    _getRecord(peerId, targetId) {
        return this._db
            .prepare('SELECT * FROM predictability_scores WHERE peer_id = ? AND target_id = ?')
            .get(peerId, targetId) || null;
    }

    /** Fetch all score records for a given peer (their full routing table). */
    _getAllScoresForPeer(peerId) {
        return this._db
            .prepare('SELECT * FROM predictability_scores WHERE peer_id = ?')
            .all(peerId);
    }

    /** Upsert a score record. All six values must be provided. */
    _upsertRecord(peerId, targetId, score, lastUpdated, encounterCount, avgInterContactMs) {
        this._db.prepare(`
            INSERT INTO predictability_scores
                (peer_id, target_id, score, last_updated, encounter_count, avg_inter_contact_time)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(peer_id, target_id) DO UPDATE SET
                score                  = excluded.score,
                last_updated           = excluded.last_updated,
                encounter_count        = excluded.encounter_count,
                avg_inter_contact_time = excluded.avg_inter_contact_time
        `).run(peerId, targetId, score, lastUpdated, encounterCount, avgInterContactMs);
    }

    // -------------------------------------------------------------------------
    // Core Public API
    // -------------------------------------------------------------------------

    /**
     * Record a direct encounter between this node and peerId.
     *
     * Updates P(myIdentity, peerId) using the adaptive direct-encounter formula:
     *   P_new = P_old + (1 - P_old) * dynamic_ALPHA
     *
     * Also updates the rolling avg_inter_contact_time so future ALPHA/GAMMA
     * calculations reflect the actual contact rhythm for this pair.
     *
     * Edge cases:
     *   - Self-encounter (peerId === myIdentity) -> silently ignored.
     *   - Cold start (no prior record) -> oldScore = 0.0, avgInterContact = 0.
     *
     * @param {string} peerId  Identity of the peer just encountered.
     */
    recordEncounter(peerId) {
        if (!peerId || peerId === this._myIdentity) return;

        const now      = Date.now();
        const existing = this._getRecord(this._myIdentity, peerId);

        let oldScore          = 0.0;
        let encounterCount    = 0;
        let avgInterContactMs = 0;

        if (existing) {
            oldScore          = existing.score;
            encounterCount    = existing.encounter_count;
            avgInterContactMs = existing.avg_inter_contact_time;

            // Update rolling average inter-contact time (weighted by encounter count)
            const timeSinceLast = now - existing.last_updated;
            if (timeSinceLast > 0 && encounterCount > 0) {
                avgInterContactMs = Math.round(
                    (avgInterContactMs * encounterCount + timeSinceLast) / (encounterCount + 1)
                );
            }
        }

        encounterCount++;
        const dynamicAlpha = this._calcDynamicAlpha(avgInterContactMs);
        const newScore     = this._clamp(oldScore + (1 - oldScore) * dynamicAlpha);

        this._upsertRecord(
            this._myIdentity, peerId,
            newScore, now,
            encounterCount, avgInterContactMs
        );
    }

    /**
     * Get the delivery predictability P(peerId, targetId) with lazy decay applied.
     *
     * Decay formula: P_new = P_old * (dynamic_GAMMA ^ k)
     *   where k = hours elapsed since last_updated.
     *
     * Lazy evaluation: the decayed value is persisted back to the DB before
     * returning, so future callers always work with the freshest numbers.
     * Only writes if the change exceeds 0.1% (avoids unnecessary I/O).
     *
     * Edge cases:
     *   - Self-pair (peerId === targetId) -> 0.0
     *   - Cold start (no record) -> 0.0
     *   - Negligible elapsed time (< 1 ms) -> raw score, no write
     *
     * @param {string} peerId
     * @param {string} targetId
     * @returns {number} Decayed score in [0.0, 1.0]
     */
    getDecayedScore(peerId, targetId) {
        if (!peerId || !targetId || peerId === targetId) return 0.0;

        const record = this._getRecord(peerId, targetId);
        if (!record || record.score <= 0.0) return 0.0; // cold start: graceful default

        const now          = Date.now();
        const elapsedMs    = now - record.last_updated;
        const elapsedHours = elapsedMs / (1000 * 60 * 60);

        // Negligible elapsed time - skip decay
        if (elapsedMs < 1) return record.score;

        const dynamicGamma = this._calcDynamicGamma(record.avg_inter_contact_time);
        const decayedScore = this._clamp(record.score * Math.pow(dynamicGamma, elapsedHours));

        // Lazy write-back: only persist meaningful change (> 0.1%)
        if (Math.abs(decayedScore - record.score) > 0.001) {
            this._db
                .prepare(`UPDATE predictability_scores
                          SET score = ?, last_updated = ?
                          WHERE peer_id = ? AND target_id = ?`)
                .run(decayedScore, now, peerId, targetId);
        }

        return decayedScore;
    }

    /**
     * Apply transitive routing updates after exchanging routing tables with peerId.
     *
     * For each target T in the external table:
     *   P(us,T)_new = P(us,T)_old
     *                 + (1 - P(us,T)_old) * P(us,peerId) * P(peerId,T) * BETA
     *
     * Critical design decisions:
     *   1. getDecayedScore() is called on BOTH operands before the math.
     *      Guarantees we never compute transitivity on stale numbers.
     *   2. The entire operation is wrapped in db.transaction() for atomic
     *      bulk writes and performance (single SQLite fsync for N records).
     *   3. The peer's raw routing table is stored in our DB first so that
     *      shouldForwardMessage() can query P(candidateRelayId, target)
     *      without requiring the peer to be physically present.
     *
     * Edge cases:
     *   - Self-pair or peerId === us -> skipped.
     *   - P(us, peerId) = 0 -> transitivity contributes nothing (short-circuit).
     *   - Only writes if improvement exceeds 0.1%.
     *
     * @param {string} peerId  Peer whose routing table we just received.
     * @param {Array<{
     *   targetId:           string,
     *   score:              number,
     *   encounterCount?:    number,
     *   avgInterContactMs?: number
     * }>} externalRoutingTable
     */
    updateTransitivity(peerId, externalRoutingTable) {
        if (!peerId || peerId === this._myIdentity) return;
        if (!Array.isArray(externalRoutingTable) || externalRoutingTable.length === 0) return;

        const now = Date.now();

        // Wrap all reads and writes in a single transaction
        const applyTransitivity = this._db.transaction(() => {

            // Step 1: Store the peer's raw routing table.
            // This makes P(peerId, X) queryable by shouldForwardMessage().
            for (const entry of externalRoutingTable) {
                const {
                    targetId,
                    score,
                    encounterCount    = 0,
                    avgInterContactMs = 0,
                } = entry;
                if (!targetId || targetId === peerId) continue;
                this._upsertRecord(
                    peerId, targetId,
                    this._clamp(score), now,
                    encounterCount, avgInterContactMs
                );
            }

            // Step 2: Compute transitivity updates for our own scores.
            // P(us -> peerId): base score for the transitive chain.
            const scoreTowardsPeer = this.getDecayedScore(this._myIdentity, peerId);
            if (scoreTowardsPeer <= 0.0) return; // no base -> transitivity adds nothing

            for (const entry of externalRoutingTable) {
                const { targetId } = entry;
                if (!targetId) continue;
                if (targetId === this._myIdentity) continue; // skip ourselves
                if (targetId === peerId) continue;           // skip the relay itself

                // Always decay both operands before computing the update
                const myCurrentScore    = this.getDecayedScore(this._myIdentity, targetId);
                const peerToTargetScore = this.getDecayedScore(peerId, targetId);

                if (peerToTargetScore <= 0.0) continue; // peer has no useful info here

                const newScore = this._clamp(
                    myCurrentScore
                    + (1 - myCurrentScore) * scoreTowardsPeer * peerToTargetScore * BETA
                );

                // Only write if there is a meaningful improvement
                if (newScore > myCurrentScore + 0.001) {
                    const existingMine = this._getRecord(this._myIdentity, targetId);
                    this._upsertRecord(
                        this._myIdentity, targetId,
                        newScore, now,
                        existingMine ? existingMine.encounter_count        : 0,
                        existingMine ? existingMine.avg_inter_contact_time : 0
                    );
                }
            }
        });

        applyTransitivity();
    }

    /**
     * Forwarding gatekeeper — Hybrid Routing Decision.
     *
     * ┌─────────────────────────────────────────────────────────────┐
     * │  Plane          │ Packet type              │ Decision         │
     * ├─────────────────┼──────────────────────────┼──────────────────┤
     * │ Control Plane   │ key_req / key_res         │ ALWAYS forward   │
     * │                 │ (flooding, no engine)     │ (max latency)    │
     * ├─────────────────┼──────────────────────────┼──────────────────┤
     * │ Blocked         │ __pending_encryption      │ NEVER forward    │
     * │                 │ (plaintext payload)       │ (privacy lock)   │
     * ├─────────────────┼──────────────────────────┼──────────────────┤
     * │ Data Plane      │ encrypted payload         │ PRoPHET engine   │
     * │                 │ (status = undelivered)    │ (max efficiency) │
     * └─────────────────┴──────────────────────────┴──────────────────┘
     *
     * @param {string} targetId          Message destination identity.
     * @param {string} candidateRelayId  Peer being evaluated as a relay.
     * @param {object} [messageMetadata] { hop_count, ttl, type, status }
     * @returns {boolean}
     */
    shouldForwardMessage(targetId, candidateRelayId, messageMetadata = {}) {
        if (!targetId || !candidateRelayId) return false;

        // ── Control Plane: key_req / key_res bypass the engine entirely ──────
        // These are tiny control packets for public key discovery.
        // We flood them aggressively to minimise latency.
        const msgType = messageMetadata.type;
        if (msgType === 'key_req' || msgType === 'key_res') return true;

        // ── Privacy Lock: NEVER forward plaintext payloads ───────────────────
        // Messages in __pending_encryption state contain the user's plaintext.
        // They must NEVER leave the originating device until a key_res arrives
        // and they are properly encrypted.
        if (messageMetadata.status === '__pending_encryption') return false;

        // ── Data Plane: below this line = fully encrypted payload ────────────

        // Candidate IS the destination — always forward (direct delivery)
        if (candidateRelayId === targetId) return true;

        // Guard against self-forwarding
        if (candidateRelayId === this._myIdentity) return false;

        // We are the destination — nothing to forward outward
        if (targetId === this._myIdentity) return false;

        const ourScore       = this.getDecayedScore(this._myIdentity, targetId);
        const candidateScore = this.getDecayedScore(candidateRelayId, targetId);

        // Rule 1: Candidate has a meaningful advantage over us
        if (candidateScore > ourScore + FORWARD_THRESHOLD) return true;

        // Rule 2: Cold-start — we have no history/route for this destination
        if (ourScore <= 0.0) return true;

        // Rule 3: Candidate has direct/transitive knowledge of target
        if (candidateScore > 0.0) return true;

        // Rule 4: DTN Epidemic carrier fallback — within hop limit
        const hops = messageMetadata.hop_count !== undefined ? messageMetadata.hop_count : 0;
        if (hops < 10) return true;

        return false;
    }

    // -------------------------------------------------------------------------
    // Convenience helpers (used during peer exchange)
    // -------------------------------------------------------------------------

    /**
     * Get our own decayed delivery predictability for a target.
     * Convenience wrapper around getDecayedScore(myIdentity, targetId).
     *
     * @param {string} targetId
     * @returns {number}
     */
    getMyScoreFor(targetId) {
        return this.getDecayedScore(this._myIdentity, targetId);
    }

    /**
     * Build our full routing table for sharing with a peer.
     * All scores pass through getDecayedScore() before inclusion.
     * Zero-score entries are filtered out.
     *
     * @returns {Array<{
     *   targetId:          string,
     *   score:             number,
     *   encounterCount:    number,
     *   avgInterContactMs: number
     * }>}
     */
    getMyRoutingTable() {
        const rows = this._getAllScoresForPeer(this._myIdentity);
        return rows
            .map(row => ({
                targetId:          row.target_id,
                score:             this.getDecayedScore(this._myIdentity, row.target_id),
                encounterCount:    row.encounter_count,
                avgInterContactMs: row.avg_inter_contact_time,
            }))
            .filter(entry => entry.score > 0.0);
    }
}

module.exports = {
    AdaptiveRoutingEngine,
    BETA,
    ALPHA_MAX,
    ALPHA_MIN,
    GAMMA_DENSE,
    GAMMA_SPARSE,
    FORWARD_THRESHOLD,
};
