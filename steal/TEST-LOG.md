# Steal the VFY — test log

Agent: **AKANG-GK** · Repo: `haniefff/agent-games-season-01` · Date: 2026-11-15
Official artifacts (downloaded from `agentgames.zkverify.io/circuits/`):
- `vfy-policy.wasm` — 2.9 MB, sha256 `bc0998250d2baf75b89deef5306867ffa7085a08d4f7d2caf0dd63a060b134d2`
- `vfy-policy_final.zkey` — 792 KB, sha256 `f9666a1655279ef27f7fee6d535ac8aa9e39286ac40ff6279fea87c21ab6ce41`
- `/api/circuit-info`: vkHash `0x6c56509f1c56fd1fd4e9737f906d2220f4b95f1d507f1adf6899085bd74be047`
- snarkjs 0.7.6; verification key exported from the zkey: Groth16, curve bn128,
  **9 public inputs**, witness size 1909.

## 1. Circuit reverse-engineering (no source published)

Input signals found by probing the wasm `getInputSignalSize` oracle
(FNV-1a of the name; size 0 = absent):

| signal | size | role |
|---|---|---|
| `commitment` | 1 | Poseidon(strategyParams[0..7], salt) — must match the registered commitment |
| `matchId` | 1 | UUID as BigInt(hex without dashes), mod prime |
| `turnNumber` | 1 | 1..20 |
| `selfBalance` | 1 | |
| `opponentBalance` | 1 | |
| `action` | 1 | HOLD 0 / FORTIFY 1 / EXTRACT 2 |
| `amount` | 1 | EXTRACT amount; 0 for HOLD/FORTIFY |
| `circuitVersion` | 1 | "v1" → 1 |
| `salt` | 1 | private; fixed for the whole tournament (see §3) |
| `strategyParams` | 8 | **private** array — the committed policy |

Total input elements 9 + 8 = 17 = `getInputSize()`. ✓

Public signals (9, in order): `[ <binding output>, commitment, matchId,
turnNumber, selfBalance, opponentBalance, action, amount, circuitVersion ]`.
The binding output (public[0]) depends on salt/matchId/turnNumber/
circuitVersion but NOT on balances, action, commitment or params (verified
by varying each); its exact Poseidon formula was NOT identified and is NOT
needed to produce a valid proof — the platform re-verifies the proof
against its own vk.

**Commitment formula — VERIFIED:** `commitment = Poseidon(params, salt)`.
With params `[5,50,0,0,0,0,0,0]`, salt `123`:
Poseidon = `4041153532341580431411165979317910699967528556228080561254456777362765177066`.
Any other commitment value fails the witness at `VfyPolicyProof_154:72`.

**publicInputsHash — VERIFIED against the /build formula:** keccak256 of
ABI-packed 32-byte BE fields in order
(commitment, matchId, turn, selfBalance, opponentBalance, action, amount,
circuitVersion=1). The test harness recomputes it independently and
compares it to the server's value on every live turn.

## 2. Policy decoded by oracle probing (params [5,50,0,0,0,0,0,0] first)

| state | only provable action |
|---|---|
| self 100, opp 100 | EXTRACT 5 (EXTRACT 3 and 10 refused at line 149 — amount must equal params[0]) |
| self 40, opp 100 | FORTIFY |
| self 100, opp 0 | HOLD |
| self 50, opp 100 | EXTRACT (50 is NOT < 50) |
| self 49, opp 100 | FORTIFY |
| self 40, opp 0 | FORTIFY (fortify beats HOLD) |
| self 100, opp 1 | EXTRACT |
| self 100, opp 0 | FORTIFY refused, HOLD ok |
| params[2]=10: opp 10 → HOLD, opp 11 → EXTRACT (strictly greater) |
| mode params[3]=1: EXTRACT refused; HOLD ok (self 100), FORTIFY ok (self 40) |

Decoded policy (see `strategy.cjs` for reasoning):
1. `selfBalance < params[1]` → FORTIFY
2. `opponentBalance <= params[2]` → HOLD
3. otherwise → EXTRACT `params[0]`
Mode 1: EXTRACT never allowed; FORTIFY when low, else HOLD.

## 3. Strategy tuning — extract amount 10, not 5

The reference repo's proposed default was params[0]=5. A simulated
20-turn sweep (model resolver: simultaneous, FORTIFY costs 2 and blocks 6,
balances clamped at 0 — see `test-steal.cjs`) rejects it:

| params | vs Always-EXTRACT-10 | vs Always-EXTRACT-5 | vs Always-HOLD | vs Always-FORTIFY | vs Mirror-10-50 |
|---|---|---|---|---|---|
| [5,50,0,…] | LOSS 0/182 | DRAW 100/100 | WIN 200/0 | WIN 100/60 | LOSS 0/182 |
| [7,50,0,…] | LOSS 31/163 | WIN 140/60 | WIN 200/0 | WIN 120/40 | LOSS 31/163 |
| **[10,50,0,…]** | **DRAW 100/100** | **WIN 195/5** | **WIN 200/0** | **WIN 164/0** | **DRAW 100/100** |

EXTRACT is free under the published rules, so amount 10 weakly dominates:
it draws equal extractors, beats smaller ones, and drains holders/
fortifiers fastest. Fortify threshold 30/50/70 never changed an outcome
in the sweep, so 50 is kept. **Committed default: `[10,50,0,0,0,0,0,0]`.**
Caveat: the sweep uses our resolver model; the platform's exact "exposed
balance" is not fully specified, but no published rule penalises a larger
extract. Re-tune only BEFORE (re-)registering the commitment.

## 4. Server test (`node steal/test-steal.cjs`, 2026-11-15)

Spawns `server.cjs` on port 3102 with `STEAL_SALT=123`,
params `[10,50,0,0,0,0,0,0]`, commitment
`0x1f29eaf548896a2203dc89aee3397ed664628dace4a076a6edc7a2e7148532c5`
(Poseidon of those params + salt 123 — test value only, never production).
Every returned proof is re-verified with snarkjs; public signals and
`publicInputsHash` are checked field-by-field.

```
PASS  server starts + GET /health
PASS  health reports registered commitment
PASS  preflight -> {ok:true, protocolVersion:v1} signed
PASS  bad HMAC -> 401
PASS  turn 100/100 -> EXTRACT 10 + valid proof + hash (2341 ms)
PASS  turn 40/100 -> FORTIFY (no amount) + valid proof
PASS  turn 100/0 -> HOLD (no amount) + valid proof
PASS  wrong envelope commitment -> HOLD, no proof
PASS  decide 100/100 -> EXTRACT 10
PASS  decide 50/100 -> EXTRACT (50 not < 50)
PASS  decide 49/100 -> FORTIFY
PASS  decide 40/0 -> FORTIFY (fortify beats hold)
PASS  decide 100/0 -> HOLD
PASS  decide mode1 100/100 -> HOLD (no extract)
PASS  decide mode1 40/100 -> FORTIFY
PASS  decide minOpp10: opp10 HOLD, opp11 EXTRACT
SIM vs Always-EXTRACT-10: DRAW final 100/100
SIM vs Always-HOLD: WIN final 200/0
SIM vs Always-FORTIFY: WIN final 164/0
SIM vs Mirror (same policy): DRAW final 100/100

STEAL: 20/20 passed
```

Full machine-readable results: `test-results.json` (gitignored).

## 5. Known gaps / assumptions (not yet verified live)

- **Late entry likely CLOSED:** Swiss Round 1 opened 13 Nov and entries lock
  once paired; another entrant reported Steal entries locked while Swiss is
  in progress. This agent is built for practice/completeness — Gatekeeper
  is the priority track. If the dashboard still accepts a Steal commitment,
  register it; if it refuses, this code is still a correct practice agent.
- The salt used in tests (`123`) is public and must NEVER be a production
  salt. Generate a fresh one with `node steal/gen-commitment.cjs` at
  registration time and register exactly its commitment.
- The circuit's policy has no input for fortification state, turn history,
  or opponent identity — the committed policy cannot react to those, and
  any deviation is unprovable. That is a limitation of the policy language.
- HMAC format assumption is the same as the Gatekeeper's (hex, optional
  `sha256=` prefix; base64 also accepted) — confirm on preflight.
- `publicInputsHash` field order is from the official /build page and was
  verified as self-consistent (our server and test compute it
  independently); the platform recomputes it from the game state it knows.
- Not yet run against the live platform (no public HTTPS endpoint yet).
  Preflight + practice turn are the next step after deployment.
