# Proof Gatekeeper — test log

Agent: **AKANG-GK** · Repo: `haniefff/agent-games-season-01` · Date: 2026-11-15
Official artifacts (downloaded from `agentgames.zkverify.io/circuits/`):
- `gatekeeper.wasm` — 1,755,820 bytes, sha256 `be00aefe3c8ba910951a242f50e55937bf82a0375ad4b69c2ef10629ab92764f`
- `gatekeeper_final.zkey` — 309,750 bytes, sha256 `adfe95a439a7063a82a4967ef026d2dd6857a4d02c63b3caf63dac02e01af80d`
- `/api/circuit-info`: vkHash `0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0`
- snarkjs 0.7.6; verification key exported from the zkey: Groth16, curve bn128,
  **13 public inputs**, witness size 647.

## 1. Circuit reverse-engineering (no source published)

Signal names are not in the wasm (Circom 2 resolves them by FNV-1a hash).
Probed candidate names against the wasm `getInputSignalSize` oracle
(size 0 = absent, ≥1 = present). Found exactly 13, matching `getInputSize()`:

| signal | role |
|---|---|
| `registeredVkHash` | VK the condition registered (field: BigInt(hex) mod prime) |
| `proofVkHash` | VK the proof actually used |
| `minimum` | required minimum balance |
| `publicBalance` | balance disclosed in the proof |
| `expiryBlock` | condition expiry (block height) |
| `currentBlock` | block height now |
| `recipient` | where the money would go (field: BigInt(address)) |
| `conditionRecipient` | where the condition says it must go |
| `amount` | requested payment |
| `maxTransfer` | single-transfer cap |
| `decision` | 1 = approve, 0 = reject |
| `taskId` | binds the proof to one task |
| `salt` | **the only private input** — never appears in public signals |

Public signals (13, in order): `[ Poseidon(salt, taskId), registeredVkHash,
proofVkHash, minimum, publicBalance, expiryBlock, currentBlock, recipient,
conditionRecipient, amount, maxTransfer, decision, taskId ]`.
Verified: with salt `987654321`, taskId `24`, public[0] =
`4538591768452999874275481926009620849813943225939850916630922448132760538048`
= Poseidon([987654321, 24]) via circomlibjs. vk hashes / addresses appear
reduced mod the bn128 field prime.

**taskId encoding (assumption, circuit-consistent):** `keccak256(task_id)
mod field prime`. Verified: task `gk_24_9d1` → taskId field
`16506844760414165912080236586659340220318748946289526529754881394918275529611`,
proof verifies, public[0] = Poseidon(salt, taskId) exactly. The numeric
alternative (taskId = 24) also proves — the circuit accepts any field
element. Which encoding the LIVE platform expects is only confirmable via
a practice task; if practice rejects, try the numeric parse first.

## 2. Raw circuit matrix (snarkjs CLI, before the server existed)

Sample numbers from the event page (minimum 1000, balance 1460,
expiry 19842201, current 19832000, amount 500, cap 1000, registered vk =
official vkHash, recipient `0xDe42…9f01`):

| case | result |
|---|---|
| valid, decision=1 | PROVE-OK, `snarkjs groth16 verify` = OK, ~2.5 s |
| valid, decision=0 | REFUSED — `GatekeeperEvaluation_79 line: 102` |
| VK_SUBSTITUTION, decision=1 | REFUSED — line 102 |
| VK_SUBSTITUTION, decision=0 | PROVE-OK, verify OK |
| THRESHOLD_MISMATCH (bal 900), decision=0 | PROVE-OK, verify OK |
| THRESHOLD_MISMATCH, decision=1 | REFUSED — line 102 |
| EXPIRED (current 19843000), decision=0 | PROVE-OK, verify OK |
| RECIPIENT_MISMATCH, decision=0 | PROVE-OK, verify OK |
| AMOUNT_OVERFLOW (1500), decision=0 | PROVE-OK, verify OK |
| AMOUNT_OVERFLOW, decision=1 | REFUSED — line 102 |

Rule confirmed: **decision must equal the computed verdict** — approve iff
every check passes. A wrong decision is unprovable, not just rejected.

## 3. Server test (`node gatekeeper/test-gatekeeper.cjs`, 2026-11-15)

Spawns `server.cjs` on port 3101 with a throwaway HMAC secret and replays
signed envelopes. Every returned proof is re-verified with snarkjs and its
public signals checked field-by-field (incl. public[0] = Poseidon(salt,
taskId) with the server's deterministic salt).

```
PASS  server starts + GET /health
PASS  preflight -> {ok:true, protocolVersion:v1} signed
PASS  bad HMAC -> 401
PASS  missing HMAC -> 401
PASS  VALID_CONDITION -> APPROVE + valid proof (verify=OK, fieldsOk, commitmentOk)
PASS  valid task answered < 60 s (3126 ms)
PASS  VK_SUBSTITUTION -> REJECT + valid proof
PASS  THRESHOLD_MISMATCH -> REJECT + valid proof
PASS  EXPIRED_CONDITION -> REJECT + valid proof
PASS  RECIPIENT_MISMATCH -> REJECT + valid proof
PASS  AMOUNT_OVERFLOW -> REJECT + valid proof
PASS  PROOF_REUSED (resend valid task) -> REJECT, no proof
PASS  malformed task -> REJECT INVALID_TASK, no proof

GATEKEEPER: 13/13 passed
```

Full machine-readable results: `test-results.json` (gitignored).

## 4. Known gaps / assumptions (not yet verified live)

- HMAC signature format: hex digest (optional `sha256=` prefix; base64 also
  accepted). If preflight fails with a signature error, this is the first
  thing to check against the dashboard's Rotate Secret value.
- taskId encoding (keccak256, see §1) — confirm on the first practice task.
- No Kurier/zkVerify submission is done: the platform re-verifies the
  Groth16 proof itself; `proof_tx` is echoed as the on-chain audit pointer.
  If the platform requires a Kurier Finalized reference before scoring,
  that is a separate integration (needs a Kurier API key — not set up).
- The server has NOT been run against the live platform (no public HTTPS
  endpoint yet, no account registered by this build). Preflight + practice
  tasks are the next step after deployment.
