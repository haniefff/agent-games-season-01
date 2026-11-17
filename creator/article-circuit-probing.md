# Decoding a Circuit Without Its Source: How I Read the vfy-policy Rules by Probing

> **zkVerify Agent Games Season 01 — Creator Track entry.** Published 17 Nov 2026. Manual review: technical substance, clarity, zkVerify relevance, originality. Season: 21 Oct – 21 Nov 2026.
>
> **Honest status, up front:** Steal the VFY entries were already locked before I could register, so this agent never played a scored match. Everything below is verified against the official circuit files in local tests — 20/20 passed — not against live play. What the circuit *does* is proven; what it would *score* is not.

---

## The problem: a circuit with no source

The Steal the VFY track gives you three things: a compiled circuit (`vfy-policy.wasm`, 2.9 MB), a proving key (`vfy-policy_final.zkey`, 792 KB), and a verification-key hash from `/api/circuit-info` (`0x6c56509f…be047`). No Circom source. No spec of the policy language. No list of input signals.

To build an agent that can prove its moves, I had to know exactly what the circuit expects: every input signal, its meaning, the commitment formula, and the rules the policy enforces. The only way in was to probe the compiled circuit itself.

## The oracle: asking the wasm what it knows

A Circom 2 wasm module exposes a `getInputSignalSize` function: give it the hash of a signal name, and it tells you how many elements that signal has. Size 0 means the name does not exist; size ≥ 1 means it does. Circom 2 resolves names by FNV-1a hash, so I could guess candidate names and ask the oracle whether each one was real.

I probed names until the count matched: the module's `getInputSize()` returned **17** input elements. I found exactly 17 — no more, no less. That is how I knew the list was complete.

| Signal | Size | Role |
|---|---|---|
| `commitment` | 1 | Poseidon(strategyParams, salt) — must match the registered commitment |
| `matchId` | 1 | Match UUID as a big integer, mod the field prime |
| `turnNumber` | 1 | 1–20 |
| `selfBalance` | 1 | My balance this turn |
| `opponentBalance` | 1 | Opponent's balance this turn |
| `action` | 1 | HOLD 0 / FORTIFY 1 / EXTRACT 2 |
| `amount` | 1 | EXTRACT amount; 0 for HOLD/FORTIFY |
| `circuitVersion` | 1 | "v1" → 1 |
| `salt` | 1 | Private — fixed for the whole tournament |
| `strategyParams` | 8 | **Private** array — the committed policy |

9 public inputs, in order: a binding output, then commitment, matchId, turnNumber, selfBalance, opponentBalance, action, amount, circuitVersion. The salt and the strategy parameters never appear in the public signals — that is the point. You commit to a policy before the first turn, and the proof shows you followed it without revealing it.

## Verifying the commitment formula

The rules said the commitment is a Poseidon hash of the parameters and the salt. "Said" is not "verified". So I tested it: I computed Poseidon of a known parameter set and a test salt with circomlibjs, fed the result into the circuit as the commitment, and the witness generated. Any other commitment value failed the witness at `VfyPolicyProof_154:72`. The formula is confirmed: **commitment = Poseidon(params, salt)**.

The same approach verified `publicInputsHash` — the hash the platform uses to bind a proof to a game state. It is keccak256 of the ABI-packed 32-byte big-endian fields, in order: commitment, matchId, turn, selfBalance, opponentBalance, action, amount, circuitVersion. My test harness recomputes it independently and compares it against the server's value on every turn. It matched every time.

One thing I deliberately do **not** publish here: any test salt or test commitment. Test salts are burned the moment they appear in a log. A production salt must be fresh, generated at registration, and never written down anywhere public.

## Reading the policy by asking the circuit questions

Knowing the signals tells you the shape of the policy, not its content. For that, I probed the circuit's behaviour: feed it a game state and an action, and see whether the witness generates or refuses. Each refusal is a rule. The probing table (params `[5,50,0,0,0,0,0,0]` first):

| State | Only provable action |
|---|---|
| self 100, opp 100 | EXTRACT 5 (EXTRACT 3 and 10 refused — amount must equal params[0]) |
| self 40, opp 100 | FORTIFY |
| self 100, opp 0 | HOLD |
| self 50, opp 100 | EXTRACT (50 is NOT < 50) |
| self 49, opp 100 | FORTIFY |
| self 40, opp 0 | FORTIFY (fortify beats HOLD) |
| self 100, opp 1 | EXTRACT |
| params[2]=10: opp 10 → HOLD, opp 11 → EXTRACT (strictly greater) |
| mode params[3]=1: EXTRACT refused; HOLD ok (self 100), FORTIFY ok (self 40) |

Three rules fell out, and nothing else:

1. `selfBalance < params[1]` → FORTIFY
2. `opponentBalance <= params[2]` → HOLD
3. Otherwise → EXTRACT `params[0]`

Mode 1 disables EXTRACT entirely: FORTIFY when low, HOLD otherwise. The boundaries are strict and verified one unit at a time — 49 fortifies, 50 extracts; opponent 10 holds, 11 extracts. There is no fourth rule hiding in the circuit: every state I probed resolved to one of these three.

## What the probing could not tell me

Honesty about the gaps, because they matter:

- **The binding output's exact formula.** Public signal 0 depends on salt, matchId, turnNumber and circuitVersion — but not on balances, action, commitment or parameters (verified by varying each). Its exact Poseidon formula was not identified, and it does not need to be: the platform re-verifies the proof against its own verification key, so a proof generated by the circuit is valid whether or not I can write down that formula.
- **The policy language is narrow.** The circuit has no input for fortification state, turn history, or opponent identity. A committed policy cannot react to any of those, and any deviation is unprovable. That is a hard limitation of the game, not of my agent — and it is why the strategy article's sweep had to assume a resolver model.
- **Nothing was verified live.** The server tests passed 20/20 locally (a turn at 100/100 produced EXTRACT 10 with a valid proof in 2,341 ms; wrong-envelope commitments answered HOLD with no proof; all boundary cases passed), but the platform never saw a turn from this agent. Entries locked first.

## Why this matters beyond one game

The method generalises: when a platform publishes compiled circuits but not source, the wasm itself is a truthful oracle. Signal-size probing gives you the complete input list; witness refusal gives you the rules, one boundary at a time; and every claim can be re-checked by anyone with the same public files. I never needed to trust the reference implementation — in fact, probing is how I found that its proposed default parameters lose 0/182 to always-extract-10, which is the subject of my strategy article.

The code, the circuit files, and the full test log are public: `github.com/haniefff/agent-games-season-01` (`steal/`, `steal/TEST-LOG.md`). Official circuit files came from `agentgames.zkverify.io/circuits/`.

---

*Built by AkangBarr (Agent Games) / @akang-aja (make.fun) — mobile-only on Android. Companion article: [Steal the VFY: A Strategy You Must Commit to Before the First Turn](https://github.com/haniefff/agent-games-season-01/blob/main/creator/article-steal.md).*

*#AgentGames*
