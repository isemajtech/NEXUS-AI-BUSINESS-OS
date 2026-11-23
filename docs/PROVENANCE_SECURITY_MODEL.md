# Provenance Authentication & Replay Protection Security Model

This document describes the authenticated provenance and persistent replay-protection architecture governing cross-department financial actions (specifically the Finance refund boundary) in the Personal AI Business OS.

---

## 1. How Provenance Is Created

Every cross-department financial request originates through trusted server-side ingestion (`ingestAuthenticatedRefundRequest` in `server/provenanceAuth.ts` exposed at `POST /api/governance/provenance/ingest`) or an explicit owner workflow:

1. **Identity & Trigger Capture**: Generates a unique UUID v4 `request_id`, a cryptographically random 128-bit `nonce`, a UTC `created_at` timestamp, and a bounded `expires_at` TTL (default 5 minutes).
2. **Content Integrity Digest**: Computes a lowercase SHA-256 hex digest (`original_trigger.raw_hash`) over the captured raw trigger payload (`customer_ticket`, `stripe_webhook`, `gumroad_ping`, `scheduled_automation`, or `owner_command`).
3. **Explicit Order & Initial Authority Binding**: Stores `bound_order_id` equal to the target `order_id` and records `initial_authority_level` alongside the opening entry in `chain`.
4. **Immutable Origin Recording**: Persists the initial snapshot into `provenance_ledger` (`request_id`, `nonce`, `bound_order_id`, `trigger_raw_hash`, `initial_authority_level`) so downstream agents cannot rewrite history.

---

## 2. Which Component Authenticates the Original Request

- Only authorized server-side ingestion components (`nexus-ingestion-api`, `nexus-webhook-ingest`) hold access to HMAC signing secrets and create the `ingestion_auth` envelope.
- Downstream AI agents and browser UI sessions **never** possess signing keys. Agents may only append hops to `chain` (`appendProvenanceHop`) without altering `original_trigger`, `request_id`, `nonce`, `bound_order_id`, or `initial_authority_level`.
- **Human Identity Separation (`sender_auth`)**: A valid server `ingestion_auth` signature proves that an authorized backend ingestion component captured the trigger and sealed the provenance envelope—it does **not** authenticate the human requester. Verified human/session identity (e.g., Supabase Auth user ID or provider webhook signature verification) is preserved separately inside `provenance.sender_auth`.

---

## 3. How Signatures Are Generated and Verified

1. **Deterministic Canonical Payload (`buildCanonicalProvenancePayload`)**:
   Both ingestion and verification construct an identical key-sorted JSON string over:
   - `action`, `amount_cents`, `bound_order_id`, `business_id`, `canonical_version` (`"v1"`), `created_at`, `expires_at`, `ingested_at`, `ingested_by_component`, `initial_authority_level`, `key_id`, `nonce`, `order_id`, `original_trigger` (`id`, `raw_hash`, `type`), `policy_version`, `request_id`, `source_agent`.
   - The append-only `chain` array is intentionally excluded from the ingestion signature so downstream departments can append hops legitimately while origin, target order, amount, nonce, and initial authority remain cryptographically locked.
2. **HMAC-SHA256 Signing**: Computes `HMAC-SHA256(key_secret, canonicalPayload)` serialized as 64 lowercase hex characters into `provenance.ingestion_auth.signature`.
3. **Constant-Time Verification at Boundary**: `evaluateFinanceRefund` delegates cryptographic verification to `createKeyringSignatureVerifier` on the server, comparing digests via `crypto.timingSafeEqual` and validating `key_id`, algorithm (`HMAC-SHA256`), component authorization, key status, and expiration.

---

## 4. Where Signing Secrets Are Stored

- Signing keys live exclusively in server-side environment secrets (`PROVENANCE_HMAC_KEYS` JSON keyring or `PROVENANCE_HMAC_SECRET`) injected at runtime into the Node/Express backend (or secret manager).
- Secrets **never** use `VITE_*` prefixes and never appear in frontend code, `localStorage`, client API responses, or downloadable payloads.
- Database table `public.provenance_signing_keys` stores **only** non-secret metadata (`key_id`, `algorithm`, `allowed_component`, `status`, `expires_at`, `rotated_from_key_id`) for auditability.

---

## 5. How Key Rotation Works

`PROVENANCE_HMAC_KEYS` supports zero-downtime key rotation using explicit `key_id` identifiers and statuses:

1. **`active`**: Used to sign new requests AND verify signatures.
2. **`rotated_grace`**: Accepted for verification during the overlap/drain window for in-flight requests, but no longer used for new signatures.
3. **`revoked`** or past **`expiresAt`**: Immediately rejected at the Finance boundary (`keyStatus: 'revoked' | 'expired'`), failing closed even if the HMAC math matches.

To rotate keys safely:
1. Introduce the new key as `"status": "active"` and set `PROVENANCE_ACTIVE_KEY_ID` to the new `key_id`.
2. Demote the previous key to `"status": "rotated_grace"` with a near-term `expiresAt`.
3. Once in-flight TTLs expire (or immediately in a key-compromise event), mark the old key `"status": "revoked"` and delete its secret from the secret store.

---

## 6. How Request IDs, Nonces, and Idempotency Keys Work

- **`request_id` (UUID v4)**: Globally unique identifier for a single cross-department refund request. Enforced `UNIQUE` in `refund_authorizations`.
- **`nonce` (128-bit+ random token)**: Unique single-use replay deterrent included inside the HMAC canonical signature and enforced `UNIQUE` in `refund_authorizations` across all requests. Reusing a nonce with a different `request_id` is rejected immediately (`NONCE_REUSED`).
- **`idempotency_key`**: Distinguishes an authorized network retry of the exact same `(request_id, order_id, nonce, canonical_digest)` (`IDEMPOTENT_RETURN`) from a malicious or conflicting replay (`REPLAY_ALREADY_CONSUMED` / `REPLAY_CONFLICT`).

---

## 7. How Replay Attempts & Concurrency Races Are Detected

Enforcement uses a persistent ACID database backend (`public.reserve_refund_execution` / `public.finalize_refund_execution` in PostgreSQL/Supabase with `pg_advisory_xact_lock` + `FOR UPDATE`, and `BEGIN IMMEDIATE` transactions with `UNIQUE` indexes in server SQLite):

1. **Phase 1 — Atomic Lock (`executing`)**: Before contacting payment APIs or modifying balances, `reserveRefundExecution` verifies uniqueness across `request_id`, `nonce`, `approval_id`, `idempotency_key`, and active/executed `order_id`. If clear, it inserts a row in state `executing` with `consumed_at = NULL`.
2. **Concurrent Calls**: Simultaneous calls hit the transaction serialization lock and observe `status = 'executing'`, returning `CONCURRENT_IN_FLIGHT` so at most one worker ever executes the refund.
3. **Phase 2 — Finalize Outcome (`executed` or `failed`)**:
   - On payment success: `finalizeRefundExecution` atomically sets `status = 'executed'`, `consumed_at = now()`, `execution_tx_id`, and `outcome_payload`.
   - On provider error/timeout: `failRefundExecution` sets `status = 'failed'` while keeping `consumed_at = NULL`, ensuring an approval is **never** marked consumed before execution outcome is safely recorded.

---

## 8. How Approvals Are Bound to Orders

1. Both `provenance.bound_order_id` (HMAC-protected) and `owner_approval_binding` (`approval_id`, `request_id`, `order_id`, `amount_usd`) must match the refund request at the Finance boundary.
2. In the persistent database (`refund_authorizations`), `uq_refund_auth_approval_id` enforces a unique index on `approval_id`, preventing any approved authorization from ever being re-used against a different `request_id` or `order_id` (`APPROVAL_ORDER_MISMATCH`).
3. Owner approval **cannot** override a failed cryptographic signature check, expired/revoked key, or mismatched order binding.

---

## 9. Behavior When Verification Fails (Fail-Closed)

- **Missing provenance or missing server crypto verifier**: Blocks automatic execution and routes to `ESCALATE_TO_OWNER_APPROVAL` (never auto-executes in browser context).
- **Cryptographic, identity, binding, or replay failures**: Immediately returns `REJECT_SECURITY_VIOLATION` / `REJECTED_REPLAY_OR_CONFLICT` with `allowedToAutoExecute: false` (`executedNewRefund: false`).
- **Policy breaches (amount > $25, confidence < 0.85, stale `policy_version`, `recommend_only`)**: Blocked at the Finance boundary and escalated to `ESCALATE_TO_OWNER_APPROVAL` even when the ingestion signature is valid.

---

## 10. Protections Outside System Guarantees (Threat Boundaries)

- **Host / Secret Compromise**: If the backend runtime host or `PROVENANCE_HMAC_KEYS` secret store is compromised, an attacker could mint valid ingestion signatures for keys they possess until revoked.
- **Pre-Ingestion Upstream Spoofing**: Provenance authentication guarantees integrity *from ingestion onward*; upstream webhooks or ticketing sources must still be independently authenticated (e.g., Stripe webhook signatures, Gumroad secrets, Supabase JWT verification) before ingestion captures `sender_auth`.
- **Single-Node SQLite vs. Multi-Region Postgres**: When running without `SUPABASE_SERVICE_ROLE_KEY`, the built-in SQLite WAL store enforces persistence and locking on a single backend instance; horizontally scaled multi-instance deployments **must** point all workers to shared PostgreSQL/Supabase executing the Phase 2 migration RPCs.
- **Browser UI Boundary**: `evaluateFinanceRefund` called directly inside the React frontend runs fail-closed without server HMAC keys; authoritative financial execution must occur strictly via `POST /api/governance/finance/refund` on the backend.
