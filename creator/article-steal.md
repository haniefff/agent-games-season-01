# Steal the VFY: A Strategy You Must Commit to Before the First Turn

> **zkVerify Agent Games Season 01 — Creator Track entry.** Published 17 Nov 2026. Manual review: technical substance, clarity, zkVerify relevance, originality. Season: 21 Oct – 21 Nov 2026.
>
> **Honest status, up front:** this agent was built and locally tested (20/20 checks passed), but Steal the VFY entries locked for new entrants on 15 Nov 2026 before it could be registered — so it never played a real tournament match. Every match result in this article is a **local simulation**, labelled as such. Nothing here claims a tournament win, a rank, or a prize.

---

## The game, in one paragraph

Steal the VFY is a 20-turn head-to-head match. Both agents start with 100 VFY (simulated, not real money). Each turn you pick one of three actions: **FORTIFY** (costs a little, blocks incoming extraction), **EXTRACT** (free — take from the opponent), or **HOLD** (free — do nothing). Win +18 points, draw +9, loss +3; a timeout costs −1 per turn and an invalid policy proof −2 per turn. Swiss, 5 rounds, then a Top 16 knockout.

The twist that makes it interesting: **you must commit to your strategy before Swiss Round 1, and you cannot change it mid-tournament.** Your 8 strategy parameters are hashed with a secret salt into a commitment — `commitment = Poseidon(params, salt)` — registered on the dashboard, and frozen while matches are paired. Every turn, your agent must produce a Groth16 proof that its action follows deterministically from the game state and those exact committed parameters. Deviate, and the proof simply cannot be made.

Saya belajar satu hal dari membangun ini: *the circuit is the rules, the commitment is the strategy, and the proof is the receipt.*

## What the circuit actually allows

The official circuit (`vfy-policy.wasm`, `vfy-policy_final.zkey`, Groth16/BN128, 9 public signals) was published without source code, so I decoded the policy by probing it — asking the circuit what it would prove, state by state. The policy it enforces, for parameters `[extractAmount, fortifyThreshold, minOppBalance, mode, 0, 0, 0, 0]`, is exactly three rules:

1. `selfBalance < fortifyThreshold` → **FORTIFY**
2. `opponentBalance <= minOppBalance` → **HOLD**
3. Otherwise → **EXTRACT `extractAmount`**

That is the whole policy language. There is no input for fortification state, turn history, or opponent identity — the committed policy cannot react to any of those, and any deviation is unprovable. The boundary cases matter, and each was verified against the circuit:

| State | Only provable action |
|---|---|
| self 100, opp 100 | EXTRACT (amount must equal `params[0]` exactly) |
| self 40, opp 100 | FORTIFY |
| self 100, opp 0 | HOLD |
| self 50, opp 100 | EXTRACT — 50 is NOT < 50 |
| self 49, opp 100 | FORTIFY |
| self 40, opp 0 | FORTIFY — fortify beats HOLD here |
| self 100, opp 1 | EXTRACT |
| `params[2]=10`: opp 10 → HOLD, opp 11 → EXTRACT (strictly greater) |
| mode 1 (defensive): EXTRACT refused entirely; FORTIFY when low, else HOLD |

Two details worth noticing. First, the extract amount must equal `params[0]` exactly — asking for 3 or 10 when the parameter says 5 is refused by the circuit. Second, FORTIFY beats HOLD even when the opponent is at zero, if you are low yourself: when you are fragile, protecting what is left is worth more than standing still. The circuit, not my intuition, decided that.

## Tuning: why 10, not 5

The public reference implementation proposed `params[0] = 5` as its default extract amount. I tested it instead of trusting it — a 20-turn simulated sweep against fixed opponent policies (simultaneous resolution, FORTIFY costs 2 and blocks 6, balances clamped at 0):

| params | vs Always-EXTRACT-10 | vs Always-EXTRACT-5 | vs Always-HOLD | vs Always-FORTIFY | vs Mirror-10-50 |
|---|---|---|---|---|---|
| `[5,50,0,…]` | LOSS 0/182 | DRAW 100/100 | WIN 200/0 | WIN 100/60 | LOSS 0/182 |
| `[7,50,0,…]` | LOSS 31/163 | WIN 140/60 | WIN 200/0 | WIN 120/40 | LOSS 31/163 |
| **`[10,50,0,…]`** | **DRAW 100/100** | **WIN 195/5** | **WIN 200/0** | **WIN 164/0** | **DRAW 100/100** |

EXTRACT is free under the published rules, so the maximum amount weakly dominates: it draws equal extractors, beats smaller ones, and drains holders and fortifiers fastest. The reference default of 5 **loses 0/182** to an always-extract-10 opponent and to a mirror of the 10-strategy. Seven still loses 31/163. Ten draws both and wins everywhere else in the sweep. That is why the committed strategy is **`[10,50,0,0,0,0,0,0]`**.

The fortify threshold (30 / 50 / 70) never changed an outcome in the sweep, so 50 is kept as the middle default — it only matters when you are already losing the exchange, and the circuit does not let you fortify above the threshold anyway. And the endgame has no special case: the policy has no turn input, so a trailing agent cannot "go for broke" in the last turns. That is a limitation of the committed policy language, not a bug in my agent.

Caveat, stated plainly: the sweep uses my model of the resolver. The platform's exact "exposed balance" rule is not fully specified in the public docs — but no published rule penalises a larger extract, so 10 is the safe choice under every rule I could read.

## The proof on every turn

Each turn the server (`steal/server.cjs`, Node.js stdlib, HMAC-signed envelope like the Gatekeeper agent) does the same thing:

1. Decide from the two balances and the committed params — the three rules above, nothing else.
2. Generate a Groth16 proof with the official `vfy-policy.wasm` / `vfy-policy_final.zkey`, binding the decision to the commitment, the match ID, the turn number, both balances, the action, the amount, and the circuit version.
3. Attach `publicInputsHash` — keccak256 of the ABI-packed public inputs — recomputed independently by the test harness and compared field by field.

The fail-closed instinct from my ClaimGuard work is here too: if the incoming envelope's commitment does not match the registered one, the server answers **HOLD with no proof** rather than guessing an action it cannot prove. A wrong action with a valid proof is impossible; a safe action with no proof costs less than a wrong one.

Local test results (`steal/TEST-LOG.md`, 15 Nov 2026): **20/20 passed** — health, preflight, HMAC 401 on bad signatures, live turns EXTRACT 10 / FORTIFY / HOLD each with a proof verified by snarkjs, all 8 policy-boundary unit checks, and the four simulated matches above. Every returned proof was re-verified against the official verification key (`vkHash 0x6c56509f…be047`).

## What this taught me

The Gatekeeper track taught me that a proof can verify perfectly and still authorize the wrong action — you must check *what* was proven. Steal the VFY taught me the mirror image: **a strategy you cannot change is a strategy you must get right before you commit.** The commitment is what makes the game honest — nobody can adapt their policy after seeing the bracket — and it is also what makes it unforgiving. There is no patching a bad parameter mid-tournament. The only fix is to test before you commit, and to test against the harshest opponent you can build, not the kindest.

That is also why the reference default mattered: it looked reasonable, it was published by someone who had already built an agent, and it lost 0/182 to the obvious counter. "Someone else's default" is not evidence. A sweep is.

## What this is not

- **Not a tournament result.** The agent never played a scored match — entries locked on 15 Nov before registration. The match scores above are simulations under my resolver model.
- **Not a guarantee.** A policy that draws a mirror and beats holders in simulation can still lose to an opponent policy I never simulated. The commitment scheme means I cannot adapt to that opponent if it appears.
- **Not the whole game.** The circuit decides the action; the server, the HMAC envelope, and the commitment registration around it are what make the action reach the platform at all.

The code is public: `github.com/haniefff/agent-games-season-01` (`steal/` — `server.cjs`, `strategy.cjs`, `test-steal.cjs`, `gen-commitment.cjs`, `TEST-LOG.md`, official circuit files). The salt is never published — the commitment is the public part, the salt stays private, and the test salt from development must never be registered.

---

*Built by AkangBarr (Agent Games, agent AKANG-GK) / @akang-aja (make.fun) — mobile-only on Android. Steal the VFY strategy `[10,50,0,0,0,0,0,0]`, verified against the official circuit. Companion article: [ClaimGuard: a Proof Can Verify Perfectly and Still Authorize the Wrong Action](https://github.com/haniefff/agent-games-season-01/blob/main/creator/article.md).*

*#AgentGames*
