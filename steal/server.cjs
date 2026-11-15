'use strict';
/**
 * AKANG-GK — Steal the VFY agent for zkVerify Agent Games Season 01.
 *
 * Node.js, stdlib `http` only. Same transport contract as the Gatekeeper
 * (HMAC over raw body before parsing, signed responses, preflight),
 * different game: 20-turn matches, 100 VFY each, actions
 * FORTIFY (cost 2, blocks up to 6 of incoming extraction) /
 * EXTRACT (free, takes up to N, max 10) / HOLD (free).
 * Turn deadline 5 min (~30 s per push). Swiss 5 rounds -> Top 16 knockout.
 *
 * Protocol (source: https://agentgames.zkverify.io/build section 06 and
 * https://agentgames.zkverify.io/events/steal-the-vfy):
 *  - Turn envelope (POST): {protocolVersion:"v1", eventId:"steal-the-vfy",
 *    mode, matchId, turn, issuedAt, deadlineAt,
 *    state:{selfBalance, opponentBalance, selfFortifiedUntilTurn,
 *    opponentFortifiedUntilTurn}, strategyCommitment:{hash},
 *    resolverVersion:"v1", nonce}
 *  - Response: {matchId, turn, action:{type, amount?},
 *    policyProof:{circuitVersion:"v1", proof, public_signals,
 *    publicInputsHash, proofReference?}, agentTimestamp, idempotencyKey}
 *    * action.amount MUST be omitted entirely for HOLD/FORTIFY.
 *    * A missing/mismatched required field is treated as HOLD with no proof.
 *  - publicInputsHash = keccak256 of ABI-packed fields, each padded to
 *    32 bytes big-endian, in EXACTLY this order:
 *      commitment, matchId, turn, selfBalance, opponentBalance,
 *      action (HOLD 0 / FORTIFY 1 / EXTRACT 2), amount (0 for HOLD/FORTIFY),
 *      circuitVersion ("v1" -> 1).
 *    The platform recomputes it and rejects divergent proofs.
 *
 * Circuit facts — verified locally against the official artifacts
 * (vfy-policy.wasm sha256 bc099825...b134d2, vfy-policy_final.zkey
 * f9666a16...be41, vkHash 0x6c5650...be047, Groth16/BN128, 9 public
 * signals, witness size 1909):
 *  - Input signals (wasm probing): commitment, matchId, turnNumber,
 *    selfBalance, opponentBalance, action, amount, circuitVersion, salt
 *    (public) + strategyParams[8] (private).
 *  - Public signals, in order: [ <binding output>, commitment, matchId,
 *    turnNumber, selfBalance, opponentBalance, action, amount,
 *    circuitVersion ]. The binding output (public[0]) depends on
 *    salt/matchId/turnNumber/circuitVersion but NOT on balances, action,
 *    commitment or params (verified empirically); its exact Poseidon
 *    formula was not identified and is NOT needed to produce a valid
 *    proof — the platform re-verifies the proof against its vk.
 *  - commitment MUST equal Poseidon(strategyParams[0..7], salt)
 *    (witness fails at VfyPolicyProof_154 line 72 otherwise).
 *  - EXTRACT amount MUST equal params[0] (line 149); any other action
 *    for a given state is unprovable (line 140). Policy decoded in
 *    strategy.cjs and verified case by case (see TEST-LOG.md).
 *  - matchId (UUID) -> BigInt(hex without dashes), reduced mod prime.
 *
 * Commitment / salt discipline (CRITICAL):
 *  - STEAL_SALT is ONE fixed secret for the whole tournament. The
 *    commitment registered on the dashboard is Poseidon(params, salt).
 *    If the salt changes, the commitment changes and the platform
 *    rejects every turn (frozen commitment mismatch).
 *  - Generate once, store in .env (never commit, never log), compute the
 *    commitment at startup, and register EXACTLY that hash before
 *    Swiss Round 1. Startup FAILS if STRATEGY_COMMITMENT is set and does
 *    not match Poseidon(params, salt).
 *  - If the envelope's strategyCommitment.hash differs from ours, we
 *    cannot prove (we don't know their salt/params) — we answer HOLD
 *    with no proof and log loudly.
 *
 * Env: AGENT_GAMES_HMAC_SECRET, PORT (default 3002),
 *      STEAL_SALT (required unless ALLOW_DEV_SECRET=1; test value "123"),
 *      STRATEGY_PARAMS (default "10,50,0,0,0,0,0,0"),
 *      STRATEGY_COMMITMENT (optional hex; verified at startup if set).
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { keccak_256 } = require('js-sha3');
const snarkjs = require('snarkjs');
const { decide, DEFAULT_PARAMS } = require('./strategy.cjs');

const PORT = Number(process.env.PORT || 3002);
const SECRET = process.env.AGENT_GAMES_HMAC_SECRET || '';
if (!SECRET && process.env.ALLOW_DEV_SECRET !== '1') {
  console.error('FATAL: AGENT_GAMES_HMAC_SECRET is not set. Set it from the dashboard "Rotate Secret" (shown once).');
  process.exit(1);
}
const HMAC_SECRET = SECRET || 'dev-test-secret-do-not-use-in-production';
const SALT_RAW = process.env.STEAL_SALT || '';
if (!SALT_RAW && process.env.ALLOW_DEV_SECRET !== '1') {
  console.error('FATAL: STEAL_SALT is not set. Generate one random value once, keep it in .env, and register Poseidon(params, salt) as your strategy commitment.');
  process.exit(1);
}
const SALT = SALT_RAW || '123';
const PARAMS = (process.env.STRATEGY_PARAMS || DEFAULT_PARAMS.join(',')).split(',').map((s) => {
  const n = Number(s.trim());
  if (!Number.isInteger(n) || n < 0) throw new Error('STRATEGY_PARAMS must be non-negative integers');
  return n;
});
if (PARAMS.length !== 8) throw new Error('STRATEGY_PARAMS must have exactly 8 values');
if (PARAMS.slice(4).some((n) => n !== 0)) console.error('WARNING: params[4..7] must be 0 per the verified policy; got', PARAMS);

const DIR = __dirname;
const WASM = path.join(DIR, 'vfy-policy.wasm');
const ZKEY = path.join(DIR, 'vfy-policy_final.zkey');
const VK = JSON.parse(fs.readFileSync(path.join(DIR, 'verification_key.json'), 'utf8'));
const PROOF_TIMEOUT_MS = 240000; // 5-min turn deadline; proof is ~2-4 s

const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

let poseidon = null;
async function getPoseidon() {
  if (!poseidon) poseidon = await require('circomlibjs').buildPoseidon();
  return poseidon;
}
async function computeCommitment() {
  const p = await getPoseidon();
  const inputs = [...PARAMS.map(BigInt), BigInt(SALT)];
  return p.F.toString(p(inputs));
}
let COMMITMENT = null; // decimal string, set at startup

// ---- HMAC helpers (same contract as gatekeeper) ----
function hmacHex(secret, bodyBuf) {
  return crypto.createHmac('sha256', secret).update(bodyBuf).digest('hex');
}
function signatureMatches(header, bodyBuf) {
  if (!header || typeof header !== 'string') return false;
  let h = header.trim().toLowerCase();
  if (h.startsWith('sha256=')) h = h.slice(7);
  const hex = hmacHex(HMAC_SECRET, bodyBuf);
  const b64 = crypto.createHmac('sha256', HMAC_SECRET).update(bodyBuf).digest('base64');
  const eq = (a, b) => {
    const ba = Buffer.from(a); const bb = Buffer.from(b);
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  };
  return eq(h, hex) || eq(header.trim(), b64);
}
function sendJson(res, status, obj, sign = true) {
  const body = Buffer.from(JSON.stringify(obj));
  const headers = { 'content-type': 'application/json' };
  if (sign) headers['x-agent-games-signature'] = hmacHex(HMAC_SECRET, body);
  res.writeHead(status, headers);
  res.end(body);
}

// ---- publicInputsHash: keccak256 of ABI-packed 32-byte BE fields ----
function u256be(n) {
  let b = BigInt(n);
  if (b < 0) throw new Error('negative field');
  const buf = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) { buf[i] = Number(b & 0xffn); b >>= 8n; }
  if (b !== 0n) throw new Error('value exceeds 32 bytes');
  return buf;
}
function publicInputsHash({ commitment, matchId, turn, selfBalance, opponentBalance, actionCode, amount, circuitVersion }) {
  const matchBig = BigInt('0x' + String(matchId).replace(/-/g, ''));
  const parts = [
    u256be(BigInt(commitment)),
    u256be(matchBig),
    u256be(BigInt(turn)),
    u256be(BigInt(selfBalance)),
    u256be(BigInt(opponentBalance)),
    u256be(BigInt(actionCode)),
    u256be(BigInt(amount)),
    u256be(BigInt(circuitVersion)),
  ];
  return '0x' + keccak_256(Buffer.concat(parts));
}

let proofQueue = Promise.resolve();
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out after ' + ms + 'ms')), ms); });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}
function proveTurn(circuitInput) {
  const run = proofQueue.then(async () => {
    const t0 = Date.now();
    const { proof, publicSignals } = await withTimeout(
      snarkjs.groth16.fullProve(circuitInput, WASM, ZKEY),
      PROOF_TIMEOUT_MS, 'groth16.fullProve');
    const ok = await snarkjs.groth16.verify(VK, publicSignals, proof);
    if (!ok) throw new Error('local groth16 verify failed');
    return { proof, publicSignals, ms: Date.now() - t0 };
  });
  proofQueue = run.catch(() => {});
  return run;
}

async function handleTurn(env) {
  const t0 = Date.now();
  const state = env.state || {};
  const matchId = env.matchId;
  const turn = Number(env.turn);
  const selfBalance = String(state.selfBalance);
  const opponentBalance = String(state.opponentBalance);
  const action = decide(selfBalance, opponentBalance, PARAMS);
  const amount = action.type === 'EXTRACT' ? action.amount : 0;
  const actionObj = action.type === 'EXTRACT'
    ? { type: 'EXTRACT', amount }
    : { type: action.type }; // amount omitted entirely for HOLD/FORTIFY

  const response = {
    matchId,
    turn,
    action: actionObj,
    agentTimestamp: new Date().toISOString(),
    idempotencyKey: `${matchId}-${turn}`,
  };

  const envelopeCommitment = env.strategyCommitment && env.strategyCommitment.hash;
  if (envelopeCommitment) {
    const oursHex = '0x' + BigInt(COMMITMENT).toString(16);
    const envHex = String(envelopeCommitment).toLowerCase();
    // Compare as field values (mod prime) to tolerate leading zeros.
    try {
      if ((BigInt(envHex) % FIELD_PRIME) !== (BigInt(COMMITMENT) % FIELD_PRIME)) {
        console.error(JSON.stringify({ matchId, turn, error: 'strategyCommitment mismatch: envelope hash != registered commitment; answering HOLD without proof', envelope: envHex, ours: oursHex }));
        response.action = { type: 'HOLD' };
        return response;
      }
    } catch { /* unparseable envelope hash: try to prove anyway with ours */ }
  }

  const hash = publicInputsHash({
    commitment: COMMITMENT,
    matchId, turn, selfBalance, opponentBalance,
    actionCode: action.code, amount, circuitVersion: 1,
  });
  try {
    const circuitInput = {
      commitment: COMMITMENT,
      matchId: BigInt('0x' + String(matchId).replace(/-/g, '')).toString(),
      turnNumber: String(turn),
      selfBalance, opponentBalance,
      action: String(action.code),
      amount: String(amount),
      circuitVersion: '1',
      salt: SALT,
      strategyParams: PARAMS.map(String),
    };
    const { proof, publicSignals, ms } = await proveTurn(circuitInput);
    response.policyProof = {
      circuitVersion: 'v1',
      proof,
      public_signals: publicSignals,
      publicInputsHash: hash,
    };
    console.log(JSON.stringify({ matchId, turn, action: action.type, amount, proof_ms: ms, total_ms: Date.now() - t0, publicInputsHash: hash }));
  } catch (e) {
    // A missing proof is treated as HOLD with no proof (-2/turn) — but the
    // action we send is still the policy action; only log loudly. If the
    // policy action itself cannot be proven, the commitment/salt is wrong
    // and this needs fixing before the next round, not a silent retry.
    console.error(JSON.stringify({ matchId, turn, action: action.type, proof_error: String(e && e.message || e).slice(0, 200) }));
  }
  return response;
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const raw = Buffer.concat(chunks);
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return sendJson(res, 200, { ok: true, service: 'steal', agent: 'AKANG-GK', protocolVersion: 'v1', uptime_s: Math.floor(process.uptime()), strategyCommitment: COMMITMENT ? '0x' + BigInt(COMMITMENT).toString(16) : null, params: PARAMS }, false);
      }
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      if (!signatureMatches(req.headers['x-agent-games-signature'], raw)) {
        return sendJson(res, 401, { error: 'invalid signature' });
      }
      let env;
      try { env = JSON.parse(raw.toString('utf8')); }
      catch { return sendJson(res, 400, { error: 'invalid json' }); }
      if (env && env.type === 'agent-games.preflight.v1') {
        return sendJson(res, 200, { ok: true, protocolVersion: 'v1' });
      }
      if (!env || env.eventId !== 'steal-the-vfy' || typeof env.matchId !== 'string' || env.state === undefined) {
        return sendJson(res, 400, { error: 'unknown turn envelope' });
      }
      const out = await handleTurn(env);
      return sendJson(res, 200, out);
    } catch (e) {
      console.error('handler error:', String(e && e.message || e).slice(0, 300));
      try { return sendJson(res, 500, { error: 'internal error' }); } catch { /* socket gone */ }
    }
  });
  req.on('error', () => { try { res.destroy(); } catch {} });
});

(async () => {
  COMMITMENT = await computeCommitment();
  const registered = process.env.STRATEGY_COMMITMENT;
  if (registered) {
    const regField = BigInt(registered) % FIELD_PRIME;
    if (regField !== (BigInt(COMMITMENT) % FIELD_PRIME)) {
      console.error(`FATAL: STRATEGY_COMMITMENT ${registered} does not match Poseidon(params=${PARAMS}, salt=<hidden>) = 0x${BigInt(COMMITMENT).toString(16)}. Fix the salt/params or re-register.`);
      process.exit(1);
    }
  } else {
    console.log(`NOTE: no STRATEGY_COMMITMENT set. Register this commitment on the dashboard before Swiss Round 1: 0x${BigInt(COMMITMENT).toString(16)} (params=${PARAMS.join(',')})`);
  }
  server.listen(PORT, () => {
    console.log(`AKANG-GK steal listening on :${PORT} (POST /agent, GET /health). commitment=0x${BigInt(COMMITMENT).toString(16)}`);
  });
})();

module.exports = { decide, publicInputsHash, computeCommitment };
