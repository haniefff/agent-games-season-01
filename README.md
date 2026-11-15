# Agent Games Season 01 — AKANG-GK

Public repo: **`haniefff/agent-games-season-01`** (created 2026-11-15, public,
empty, default branch `main` — this code is structured to push there as-is;
**not pushed yet**).

- Agent name: **AKANG-GK**
- Agent Games account: X **@xyunzunx** (dashboard handle **AkangBarr**)
- GitHub: **haniefff** (https://github.com/haniefff)
- Tournament: zkVerify Agent Games Season 01, 21 Oct – 21 Nov 2026.
  400,000 VFY total, 100,000 per track (50k / 30k / 20k for top 3).
- Tracks built here: **Proof Gatekeeper** (priority) + **Steal the VFY**
  (built for practice/completeness — see "Steal late entry" below).
  Creator Track and Wildcard live in `creator/` and `wildcard/` (separate work).

## What is built

| Track | Server | Proof | Local tests |
|---|---|---|---|
| Proof Gatekeeper | `gatekeeper/server.cjs` (Node stdlib `http` only) | Groth16 via snarkjs 0.7.6, official circuit | **13/13 passed** — valid + all 7 traps + preflight + bad HMAC + malformed |
| Steal the VFY | `steal/server.cjs` + `steal/strategy.cjs` | Groth16 via snarkjs 0.7.6, official circuit | **20/20 passed** — live turns + policy boundaries + simulated matches |

Both servers: HMAC-SHA256 `x-agent-games-signature` verified over the RAW
request body BEFORE parsing; every response signed the same way; preflight
`{ok:true, protocolVersion:"v1"}`; `GET /health`; fail closed (bad
signature → 401, malformed task → REJECT, no secret → refuse to start).

### Gatekeeper — decision logic (deterministic, in order)

`PROOF_REUSED` (proof_tx in local seen-set, persisted to `seen.json`) →
`VK_SUBSTITUTION` → `THRESHOLD_MISMATCH` → `EXPIRED_CONDITION` →
`RECIPIENT_MISMATCH` → `AMOUNT_OVERFLOW` → `VALID_CONDITION` (APPROVE).
Each scored task carries exactly one trap, so order only matters for
malformed/multi-trap inputs. Correct decisions are proven with the official
circuit; a wrong decision is *unprovable* (witness fails at
`GatekeeperEvaluation_79:102` — verified in a 10-case matrix).
`PROOF_REUSED` carries **no proof** by design (decision=0 is unprovable
when all other checks pass). If proof generation fails, the server still
returns the CORRECT decision without a proof (costs −2) instead of
flipping it (−6/−3) — see `gatekeeper/server.cjs` header.

Circuit inputs (found by probing the wasm — no source is published):
`registeredVkHash, proofVkHash, minimum, publicBalance, expiryBlock,
currentBlock, recipient, conditionRecipient, amount, maxTransfer, decision,
taskId, salt` (salt is the only private input).
Public signals: `[Poseidon(salt, taskId), …12 task fields…]`.
Full verification notes: `gatekeeper/TEST-LOG.md`.

### Steal the VFY — committed strategy

Params **`[10,50,0,0,0,0,0,0]`**: extract 10, fortify while self < 50,
extract only when opponent > 0, mode 0. Policy (circuit-enforced, see
`steal/strategy.cjs` for reasoning):
`self < 50 → FORTIFY`; `opponent ≤ 0 → HOLD`; else `EXTRACT 10`.
Extract amount 10 was chosen over the reference repo's 5 after a simulated
sweep: 5 LOSES 0/182 to Always-EXTRACT-10, 10 draws it and wins 182/0 vs a
Mirror-5-50. Commitment = `Poseidon(params, salt)`; `publicInputsHash` =
keccak256 of ABI-packed
(commitment, matchId, turn, selfBalance, opponentBalance, action, amount,
circuitVersion) — exactly the /build field order. Full verification notes:
`steal/TEST-LOG.md`.

**Steal late entry — likely CLOSED.** Swiss Round 1 opened 13 Nov and
entries lock once paired; another entrant reported Steal entries locked
while Swiss is in progress. Build it, register the commitment if the
dashboard still accepts it, but **Gatekeeper is the priority track**.

## Repo layout

```
agent-games-season-01/
├── README.md                  # this file
├── package.json               # snarkjs@0.7.6, circomlibjs@0.1.7, js-sha3
├── .env.example               # copy to .env; NEVER commit .env
├── .gitignore
├── gatekeeper/
│   ├── server.cjs             # the agent (PORT, default 3001)
│   ├── gatekeeper.wasm / gatekeeper_final.zkey   # OFFICIAL circuit artifacts
│   ├── verification_key.json  # exported from the zkey (snarkjs 0.7.6)
│   ├── circuit-info.json      # /api/circuit-info (vkHash)
│   ├── test-gatekeeper.cjs    # 13/13 local tests
│   └── TEST-LOG.md            # circuit findings + test results
└── steal/
    ├── server.cjs             # the agent (PORT, default 3002)
    ├── strategy.cjs           # committed policy + reasoning
    ├── gen-commitment.cjs     # generate fresh salt + commitment for registration
    ├── vfy-policy.wasm / vfy-policy_final.zkey  # OFFICIAL circuit artifacts
    ├── verification_key.json
    ├── circuit-info.json
    ├── test-steal.cjs         # 20/20 local tests + match simulator
    └── TEST-LOG.md
```

## Run locally

```bash
npm install
cp .env.example .env   # fill in AGENT_GAMES_HMAC_SECRET (and STEAL_SALT etc.)
# Gatekeeper (needs AGENT_GAMES_HMAC_SECRET):
PORT=3001 node gatekeeper/server.cjs
# Steal (needs AGENT_GAMES_HMAC_SECRET + STEAL_SALT):
PORT=3002 node steal/server.cjs
# Tests (throwaway secrets, no account needed):
node gatekeeper/test-gatekeeper.cjs   # 13/13
node steal/test-steal.cjs            # 20/20
```

## Register + deploy (NOT done — needs user decisions)

1. **Link GitHub** in the Agent Games dashboard first (the register form
   errors until the GitHub account is linked), then create this repo's
   content on GitHub: `haniefff/agent-games-season-01` already exists
   (empty, `main`). Push this directory to it (no push has been made from
   here; `gh` on this machine is not logged in — push from a logged-in
   shell or via the GitHub web upload).
   In the register form the repo field already prefixes `https://`, so
   enter only `github.com/haniefff/agent-games-season-01` (not the full
   URL — the double-`https://` was already rejected once).
2. **Deploy both servers to a public HTTPS host** (this VM has no public
   IP — Railway / Render / Fly.io or similar; the reference implementation
   used Railway). One public URL per agent, full handler path registered
   (e.g. `https://<host>/agent`, not just the domain). Set env vars on the
   host: `AGENT_GAMES_HMAC_SECRET`, `PORT`, and for Steal `STEAL_SALT`,
   `STRATEGY_PARAMS`, `STRATEGY_COMMITMENT`. No secrets in the repo.
3. **Rotate Secret** on the dashboard (shown ONCE) → set it as
   `AGENT_GAMES_HMAC_SECRET` → restart → run **preflight** (must pass
   before the platform marks the agent active).
4. **Steal only, BEFORE Swiss Round 1** (if the dashboard still accepts
   it): `node steal/gen-commitment.cjs` → paste the printed
   `STRATEGY_COMMITMENT` into Dashboard → My Agents → Edit agent (Steal
   section). The salt is fixed for the whole tournament — never change it
   mid-tournament, never re-run the generator after registering.
5. **Practice first**: run at least one practice task / practice turn per
   track, then enter scored rounds. Gatekeeper Round 4 opens 16 Nov
   17:30 WIB (Rounds 1–2 already done, Round 3 live 15 Nov).

## Assumptions that need a live practice task to confirm

- `taskId = keccak256(task_id) mod bn128 prime` (circuit-consistent and
  verified locally; the numeric parse also proves — if practice rejects,
  try numeric first).
- HMAC signature = hex digest (optional `sha256=` prefix; base64 also
  accepted). If preflight fails with a signature error, check this first.
- No Kurier submission is done: the platform re-verifies the Groth16 proof
  itself and `proof_tx` is echoed as the audit pointer.
- Steal `public[0]` binding-output formula was not identified (not needed
  to produce a valid proof).

## Security notes

- No private key / seed / password / API key is used or stored anywhere in
  this repo. The only secrets are the platform HMAC secret and the Steal
  salt, both via env vars only.
- **Salts printed during local testing (e.g. `123`, and any salt printed
  by `gen-commitment.cjs` runs in this build session) are burned — generate
  a FRESH salt at registration time.** The test commitment for salt `123`
  is `0x1f29eaf548896a2203dc89aee3397ed664628dace4a076a6edc7a2e7148532c5`
  (params `[10,50,0,0,0,0,0,0]`) — test value only, never register it.
- Never log the HMAC secret or salts; the servers never log them.
- No prize is promised. Scores are cumulative; correct decisions +12,
  wrong APPROVE −6, wrong REJECT −3, timeout −2, missing/invalid proof −2.
