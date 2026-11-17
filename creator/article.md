# ClaimGuard: a Proof Can Verify Perfectly and Still Authorize the Wrong Action

> **zkVerify Agent Games Season 01 — Creator Track entry.** Published 17 Nov 2026. Manual review: technical substance, clarity, zkVerify relevance, originality. Season: 21 Oct – 21 Nov 2026.

---

## The lesson, in one sentence

*A proof can verify perfectly and still authorize the wrong action — verification is necessary, not sufficient.*

Saya belajar itu bukan dari whitepaper, tapi dari menjaga dompet sendiri: satu wallet BSC (Binance Agentic Wallet, `0xc77F305683F19AD95AB246Aa06f371C6f3792A4e`), saldo BNB di bawah 0.001, dan perburuan *free mint* yang semuanya dimenangkan bot dalam hitungan detik. Di dunia itu, satu klik yang salah = gas hangus, atau lebih buruk: approval yang tidak pernah kamu maksud.

So I built **ClaimGuard** — a small, boring, deterministic gate that runs *before* any transaction is executed. It does not decide what is "a good mint". It decides only one thing: **is this exact call safe to fire, right now, against this exact contract?** If any answer is unclear, it stops. Fail closed, always.

## What ClaimGuard actually checks

The gate sits between "I want to claim" and `baw contract-call execute`. It runs a read-only `eth_call` first, then a Binance `contract-call preview`, and only executes if **all six checks pass**. The logic lives in `checkPreview()` in `fastmint/fire.js` and `fastmint/pi-fire.js` (Node.js, ethers v6, no framework magic):

| # | Check | What fails it |
|---|-------|---------------|
| 1 | **Simulation code must be `000000000`** | Any other `simulationCode` → verdict `wait` or `unknown`, never `ok`. A reverting call is never executed. |
| 2 | **No allowance / authority changes** | If `simulationResult` shows `allowanceChanges` or `authorityChanges`, verdict `fatal`. A "free" claim that silently grants an approval is not free. |
| 3 | **No hard RISK flags** | Any `riskDetails` entry with `riskType: RISK` — global or per-address — → `fatal`, "needs user review". Never bypassed. |
| 4 | **Native outflow cap** | Outflow above the intended value + 0.003 BNB → `fatal`. A value-0 call must not move value. (`fire.js` also rejects a `parsedTx.amount > 0` on a value-0 call.) |
| 5 | **A `requestId` must exist** | No `requestId` in the preview response → `fatal`. Without it there is nothing legitimate to execute. |
| 6 | **No Binance risk block, no guessing** | Error code `351803` / `RISK_BLOCKED` → `fatal`, never bypassed. And if the preview response has an *unknown shape* — an error the classifier cannot place as "wait" or "fatal" — the verdict is `unknown`, and `unknown` also stops execution. |

On top of that, a precheck runs before any preview: wallet must be `CONNECTED`, the address must match the expected wallet, Developer Mode must be on, the target contract must actually have code on-chain (`eth_getCode != 0x`), and the balance must be above zero. Plus a one-broadcast lock file: once a call has executed, the exact same call can never auto-repeat.

Tidak ada satu pun dari enam cek ini yang "pintar". Semuanya deterministik, semuanya bisa dibaca dalam satu fungsi. That is the point. **The model may suggest a mint; deterministic code makes the final call.**

## Two times the gate earned its keep

**1. FEG, 10 Nov 2026.** The mint site showed addresses that differed from its own `config.js`, and the token shown had no code on-chain. A free claim there would have reverted (`FreeGone`) at best — and at worst sent a call to a contract that was not what the page claimed. The gate's precheck (verify the address, verify the code exists) is exactly the kind of check that stops this class of mistake before gas is spent.

**2. Pi (π) free seat, 15 Nov 2026, 17:24 WIB.** The sale opened at 19:00 WIB. At 17:24 the preview of `mintFree(1, 0x0)` on PiGenesis (`0xEADd830D4e0B0C11c5A16D692AeFb4C960dF0fe4`) reverted with custom error `0x6f312cbd` — `NotStarted`. Simulation code was not `000000000`, so check #1 failed and the gate stopped before execute. Nothing was sent, nothing was lost. The calldata was correct; the *time* was wrong — and the gate, not optimism, made that call.

Both cases teach the same thing: **the most valuable transaction is often the one you do not send.**

## Live proof: the same lesson, as a Gatekeeper

The same day this article was written, the same thinking went live as **AKANG-GK**, my Proof Gatekeeper agent for Agent Games Season 01 — a public HTTPS endpoint (Railway, from `github.com/haniefff/agent-games-season-01`) that answers signed tasks with a decision plus a Groth16 proof the platform re-verifies against its own key.

- Preflight: **OK — Healthy, 262 ms** (15 Nov 2026, 18:58 WIB).
- Practice task: **CORRECT DECISION, proof VERIFIED** — submitted APPROVE, expected APPROVE, latency 1,783 ms against a 60-second deadline (task `practice_c2f4440c-83b2-41c3-8496-a6914bc3b71d`, VALID_CONDITION).

The Gatekeeper is ClaimGuard's lesson, generalized: a valid proof is necessary, but the platform still checks *what* was proven — the right verification key, the right threshold, the right recipient, the right amount. The proof and the decision are verified together, or the task fails. That is the same fail-closed instinct, running on someone else's rounds instead of my own wallet.

## Where zkVerify comes in — and what it would add

Here is the honest limit of ClaimGuard today: the gate trusts two things it cannot prove to anyone else.

1. Its own `eth_call` result — "I simulated this call and it succeeded."
2. The Binance preview response — "the simulation said OK, no risks, no allowance changes."

Both are *"trust me"* claims. A screenshot of a passing preview proves nothing to a third party, and it proves nothing to future-me either. This is exactly the gap zkVerify is built for — and the same lesson the Agent Games Proof Gatekeeper track teaches: the platform re-verifies your proof against *its own* key, and a valid proof is necessary but not sufficient. You must also confirm *what* was proven: the right key, the right threshold, the right recipient, the right amount, finalized before approval.

What I would add next — **proposed, not built yet** — is a zkTLS claim over the preview the gate already relies on:

> **Checkable claim:** "At time T, claim call C from wallet W against contract K returned success when simulated (simulationCode `000000000`, no allowance/authority changes, no RISK flags)."
>
> A zkTLS proof turns the real HTTPS response behind that simulation into a claim anyone can check on zkVerify, without revealing the full payload. The gate's decision becomes auditable: not "my script said OK", but "here is the proof that the preview I relied on said OK, at this time, for this exact call."

That closes the loop the article started with. Verification of the *decision* (the six checks, deterministic, fail-closed) plus verification of the *evidence the decision relied on* (zkTLS over the `eth_call` / preview). Neither alone is enough. Together, they are the closest a small wallet guard gets to being able to prove it did the right thing.

## What ClaimGuard is not

- **Not a trading bot.** It never chooses what to mint. It only vetoes.
- **Not a guarantee.** A passing simulation is a statement about the current chain state, not the future. State changes between preview and execution; that is why the outflow cap and the single-execute lock exist.
- **Not finished.** The zkTLS + zkVerify layer above is a sketch, clearly labelled as such. The gate itself is designed and tested locally in dry-run mode (`--dry` stops before execute — the Pi precheck above was validated exactly that way).

## Why this matters beyond one wallet

Every agent that moves money — a trading agent, a treasury agent, a "claim this for me" agent — eventually faces the same question ClaimGuard faces: *how do you know the action you are about to authorize is the action you think it is?* A proof that your agent followed its policy is powerful. A proof that the evidence behind the policy check was real is what makes the first proof mean something.

Verification is necessary. It is not sufficient. Build both halves.

---

*Built by AkangBarr (Agent Games, agent AKANG-GK) / @akang-aja (make.fun) — mobile-only on Android, Binance Agentic Wallet on BSC, hunting free mints and bounties. ClaimGuard's gate logic: `fastmint/fire.js` + `fastmint/pi-fire.js` (`checkPreview`). Wallet: `0xc77F305683F19AD95AB246Aa06f371C6f3792A4e`.*

*#AgentGames*
