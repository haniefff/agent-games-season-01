# Seven Traps, One Rule: Why the Gatekeeper Is Designed to Fail Closed

> **zkVerify Agent Games Season 01 — Creator Track entry.** Published 17 Nov 2026. Manual review: technical substance, clarity, zkVerify relevance, originality. Season: 21 Oct – 21 Nov 2026.
>
> **Honest status, up front:** my agent AKANG-GK is live, preflight passed, and one practice task passed with a verified proof. Its scored rounds are still running (8 daily rounds, 13–20 Nov), and points are not confirmed — the health endpoint does not report them. This article is about the *design* of the game and my agent's answer to it, verified in local tests (13/13 passed) and one live practice task, not about a score.

---

## The setup: a proof is not a decision

Proof Gatekeeper hands your agent a signed task: a payment condition (minimum balance, public balance, expiry block, current block, recipient, amount, transfer cap) plus a proof with its verification key. You have 60 seconds to answer APPROVE or REJECT — with a Groth16 proof the platform re-verifies against its own key.

Seven kinds of task exist. Only one of them should be approved:

| Trap | What is wrong | Correct decision |
|---|---|---|
| VALID_CONDITION (~50% of tasks) | Nothing | APPROVE |
| VK_SUBSTITUTION | The proof used a different key than the condition registered | REJECT |
| THRESHOLD_MISMATCH | Public balance below the required minimum | REJECT |
| PROOF_REUSED | This proof was already used for an earlier task | REJECT |
| EXPIRED_CONDITION | Current block past the expiry block | REJECT |
| RECIPIENT_MISMATCH | The money would go somewhere the condition did not name | REJECT |
| AMOUNT_OVERFLOW | Amount above the single-transfer cap | REJECT |

The scoring makes the asymmetry explicit: correct +12, wrong APPROVE −6, wrong REJECT −3, timeout −2, missing or invalid proof −2, reliability bonus +0 to +5. Approving a bad payment costs twice as much as rejecting a good one — because in the real world it is. A false approval moves money to the wrong place; a false rejection merely delays a good payment. The game encodes that judgement in its points, and my agent is built around it.

## The one rule the circuit enforces

The official circuit (`gatekeeper.wasm`, 1,755,820 bytes; Groth16/BN128, 13 public signals) enforces a single rule: **the decision must equal the computed verdict.** Approve if and only if every check passes.

I verified this in local tests before writing a line of server code. A valid condition with decision=0 was *refused by the circuit itself* — the witness would not generate. A VK-substituted proof with decision=1 was refused the same way. A wrong decision is not a bad answer the platform marks down; it is an answer you cannot even prove. The cryptography removes the temptation to gamble: you cannot hedge a guess with a proof, because the proof will not exist.

That is the deeper lesson, and the same one as my ClaimGuard article: verification of the proof and verification of *what was proven* are two different jobs. The circuit does the first. The seven checks do the second.

## How my agent answers: fail closed, in order

AKANG-GK is a Node.js stdlib server (code public at `github.com/haniefff/agent-games-season-01`, `gatekeeper/`). A task arrives at `POST /agent` and passes through four gates, in this order:

**1. Authenticate before parsing.** The HMAC-SHA256 signature is verified over the raw request body first. A bad or missing signature gets a 401 and nothing else — the envelope is never parsed. An unauthenticated input never reaches the decision logic.

**2. Check the traps.** The seven checks run in a fixed order, and the first failure decides the answer. PROOF_REUSED is checked against a record of every proof the agent has already seen: a resend of an answered task is REJECT with *no new proof*, because re-proving the same task is exactly what the trap is for.

**3. Prove the decision — or admit you cannot.** The decision goes into the circuit with the task's inputs. If proof generation fails, the server still returns the *correct* decision without a proof. That costs −2. Flipping the decision to something provable would cost −6 or −3. A missing proof is cheaper than a wrong answer, so the server never trades correctness for completeness.

**4. Reject garbage explicitly.** A malformed task gets REJECT with reason `INVALID_TASK` and no proof at all — never a guess, never a crash, never a timeout spent on input that was never a task.

## The local evidence

13/13 tests passed on 15 Nov 2026 (`gatekeeper/TEST-LOG.md`), before deployment:

- Health, preflight, bad/missing HMAC → 401.
- A valid task answered APPROVE with a proof that re-verified in snarkjs, in 3,126 ms (limit 60,000 ms).
- All five field traps (VK, threshold, expiry, recipient, amount) answered REJECT with *valid* proofs — a REJECT is still a proven decision, and the platform verifies it the same way.
- PROOF_REUSED (a resend of a valid task) → REJECT, no proof.
- Malformed task → REJECT `INVALID_TASK`, no proof.

Then the live confirmation the same evening: preflight **OK — Healthy, 262 ms**, and a practice task answered **CORRECT DECISION, proof VERIFIED** in 1,783 ms (submitted APPROVE, expected APPROVE, VALID_CONDITION). The signed-task flow works end to end, not just in a test harness.

## What the design cannot save you from

Three honest limits:

- **A trap you misread is still a wrong answer.** The circuit guarantees your decision follows from your checks; it cannot guarantee your checks are right. If my code reads the wrong field, the proof will faithfully prove the wrong thing. That is why the checks are plain, ordered, and tested one trap at a time — there is nowhere for a misread to hide except in the code itself.
- **60 seconds is a real deadline.** Proof generation takes seconds (2.5–3.1 s in my tests), which leaves generous headroom — until the machine is slow, the RPC stalls, or a round sends tasks back to back. A timeout costs −2 and an unanswered task, so the server answers the decision first and the proof second in its own logic: the decision is never held hostage to the proof.
- **Points are still unconfirmed.** Twelve proofs generated by 17 Nov 11:45 WIB is a health fact, not a standings claim. The health endpoint does not report points, and I will not present a count as a score until the dashboard does.

## The principle, stated plainly

Every layer of this agent is built to lose the small points rather than risk the big ones: authenticate first, check in order, prove what you decided, and when you cannot prove it, say so and take the −2. That is what "fail closed" means in practice — not a slogan in a README, but a specific choice, made in code, at each of the four gates, about which error is cheaper. The scoring already told us which one that is. The agent just agrees with it.

---

*Built by AkangBarr (Agent Games, agent AKANG-GK) / @akang-aja (make.fun) — mobile-only on Android. Companion articles: [AKANG-GK: What Happens in the 60 Seconds After a Task Arrives](https://github.com/haniefff/agent-games-season-01/blob/main/creator/article-gatekeeper.md) and [ClaimGuard: a Proof Can Verify Perfectly and Still Authorize the Wrong Action](https://github.com/haniefff/agent-games-season-01/blob/main/creator/article.md).*

*#AgentGames*
