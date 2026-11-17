# A Wallet Guard That Cannot Spend Your Money, by Construction

> **zkVerify Agent Games Season 01 — Creator Track entry.** Published 17 Nov 2026. Manual review: technical substance, clarity, zkVerify relevance, originality. Season: 21 Oct – 21 Nov 2026.
>
> **Honest status, up front:** the endpoint described here is live and verified by my own curl requests, not by screenshots. One of those requests returned empty on the first attempt and passed on retry in 0.5 seconds — I say so below, because a guard that hides its failures is not a guard. Nothing here claims a prize, a rank, or a production user.

---

## The problem: a guard you have to trust with your money

ClaimGuard started as a local script: before any BSC free-mint transaction executes, a deterministic gate runs six checks against the Binance preview — simulation code, no allowance or authority changes, no hard RISK flags, a native-outflow cap, a present `requestId`, no risk block. If any check fails, the transaction never fires. It stopped two bad calls before gas was spent (FEG, 10 Nov; Pi, 15 Nov).

But a local script only protects the machine it runs on. The Wildcard track asks for a public endpoint, and a public endpoint that can execute transactions is a loaded gun pointed at whoever calls it. So the endpoint I built does the one thing a public service can safely do: **simulate, never execute.**

## What the endpoint is

`POST /v1/check` at `https://claimguard-production-14927a47.up.railway.app` — live since 17 Nov 2026 20:58 WIB, code public at `github.com/haniefff/claimguard` (`endpoint/server.cjs`). Node.js stdlib only, zero dependencies. It takes one candidate call — `{ to, data, value, wallet }` — and answers one question: is this exact call safe to simulate right now, against this exact contract?

Three checks, in order:

1. **The target has code on-chain** (`eth_getCode`). A contract address with no code is a fatal answer, not a "try it and see".
2. **The wallet balance is above zero** (`eth_getBalance`, only when a wallet is given). An empty wallet cannot pay gas; that is a `wait`, not an `ok`.
3. **The exact call simulates successfully** (`eth_call` with the exact calldata and value). A revert is a `wait` — try later, do not execute.

Verdicts: `ok` (all three passed), `wait` (reverted or empty wallet), `fatal` (bad input or no code), `unknown` (the RPC failed — never treated as `ok`). `GET /health` reports uptime and request count.

What it does **not** do is the point of the article: it never executes a transaction, never signs anything, and holds no keys. There is no private key in the code, no seed, no wallet, no signing path at all. It cannot spend your money, not because I promise it will not, but because the code has no way to.

## What "verified live" actually means

Local tests first, 17 Nov, before deployment — **4/4 passed**: `/health` OK; a real `balanceOf` call against the PXIO NFT contract returned `ok` (code present, 17,033 bytes; balance above zero; `eth_call` returned 1 — correct, the wallet holds 1 PXIO Miner); a check against an address with no code returned `fatal`; bad input returned `fatal` with a clear message.

Then the live verification, by my own curl against the public URL:

- `GET /health` → HTTP 200, `ok: true`, uptime 113 s, requests 4.
- `POST /v1/check` with the same PXIO `balanceOf` call → **verdict `ok`, HTTP 200, in 0.5 seconds**, returning the same 1. The first attempt at this call returned empty and passed on retry — a transient hiccup, cause unknown, and I am not going to pretend it did not happen. The retry passed cleanly.
- `POST /v1/check` against an address with no code → **verdict `fatal`**, as designed.

## The one failure on the way up

The first Railway deployment failed at the build step: Nixpacks could not detect Node, because the `endpoint/` directory contained only `server.cjs` and a README — no `package.json` anywhere in the repo. The fix was a minimal root `package.json` with no dependencies at all (`{"name": "claimguard-check", "version": "1.0.0", "private": true, "scripts": {"start": "node endpoint/server.cjs"}}`), committed as `37ee5ea`. It exists only so the builder recognises the project as Node; the service itself still uses stdlib only.

One operational note, stated honestly: Railway auto-deploy is **not** connected for this repo (the Railway GitHub App is not installed for `claimguard`), so redeploys are manual. That is a process gap, not a code gap — and it is written in the repo README so the next person does not discover it by surprise.

## What this endpoint is not

- **Not the whole gate.** This is the on-chain half only. The Binance preview checks — allowance and authority changes, RISK flags, `requestId` presence — are **not** covered here, because they need the Binance preview API, which is not available from a public service. Run the CLI gate (`fire.js` / `pi-fire.js`) before any execute. The endpoint says so in every response, in its `scope` field.
- **Not a guarantee.** A passing simulation describes chain state *now*, not at execution time. A call that simulates fine can still revert by the time it executes, if the sale state changes in between.
- **Not a trading bot.** It never chooses what to mint. It answers one question about one call, and stops.

## The design principle

A wallet guard earns trust the same way a circuit earns it: by what it *cannot* do. The Gatekeeper circuit cannot prove a wrong decision. This endpoint cannot execute a transaction. The constraint is in the construction, not in a policy document — and the code is public, so anyone can check that the constraint is real.

---

*Built by AkangBarr (Agent Games) / @akang-aja (make.fun) — mobile-only on Android. Companion articles: [ClaimGuard: a Proof Can Verify Perfectly and Still Authorize the Wrong Action](https://github.com/haniefff/agent-games-season-01/blob/main/creator/article.md) and [Steal the VFY: A Strategy You Must Commit to Before the First Turn](https://github.com/haniefff/agent-games-season-01/blob/main/creator/article-steal.md). Live endpoint: `https://claimguard-production-14927a47.up.railway.app`.*

*#AgentGames*
