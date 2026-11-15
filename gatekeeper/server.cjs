'use strict';
/**
 * AKANG-GK — Proof Gatekeeper agent for zkVerify Agent Games Season 01.
 *
 * Node.js, stdlib `http` only (no framework). Receives signed task envelopes
 * from the platform, decides APPROVE / REJECT deterministically, and proves
 * the decision with the OFFICIAL gatekeeper Groth16 circuit (snarkjs 0.7.6).
 *
 * Protocol (source of truth: https://agentgames.zkverify.io/build and
 * https://agentgames.zkverify.io/events/proof-gatekeeper):
 *  - POST to the registered handler path. Header `x-agent-games-signature`
 *    is HMAC-SHA256 over the RAW request body, verified BEFORE parsing.
 *  - Preflight `{type:"agent-games.preflight.v1"}` -> `{ok:true, protocolVersion:"v1"}`, signed.
 *  - Task `{type:"agent-games.proof-gatekeeper.v1", task_id, mode, issued_at,
 *    deadline_at, input:{registered_vk, proof_vk, minimum, public_balance,
 *    expiry_block, current_block, recipient, condition_recipient, amount,
 *    max_transfer, proof_tx}}` -> `{decision, reason_code, proof_tx, proof,
 *    public_signals}`, signed. 60 s hard deadline. Fail closed.
 *  - GET /health -> {ok:true, ...} (unsigned health check).
 *
 * Circuit facts — verified locally against the official artifacts
 * (gatekeeper.wasm sha256 be00aefe...2764f, gatekeeper_final.zkey
 * adfe95a4...af80d, vkHash 0x6b79c6...d77b0, Groth16/BN128, 13 public
 * signals, witness size 647):
 *  - Input signals (found by probing the wasm via FNV-1a getInputSignalSize):
 *    registeredVkHash, proofVkHash, minimum, publicBalance, expiryBlock,
 *    currentBlock, recipient, conditionRecipient, amount, maxTransfer,
 *    decision, taskId, salt. `salt` is the ONLY private input.
 *  - Public signals, in order: [ Poseidon(salt, taskId), registeredVkHash,
 *    proofVkHash, minimum, publicBalance, expiryBlock, currentBlock,
 *    recipient, conditionRecipient, amount, maxTransfer, decision, taskId ]
 *    (vk hashes and addresses appear reduced mod the bn128 field prime).
 *  - The circuit enforces decision == 1 IFF every check passes (vk equal,
 *    balance >= minimum, currentBlock <= expiryBlock, recipient ==
 *    conditionRecipient, amount <= maxTransfer). A wrong decision is
 *    UNPROVABLE: witness generation fails at GatekeeperEvaluation_79:102.
 *    Verified: 10-case matrix, all correct decisions prove+verify OK,
 *    all wrong decisions refused (see TEST-LOG.md).
 *  - PROOF_REUSED has NO proof: when all other checks pass but the proof
 *    was already seen, decision=0 is unprovable, so the response carries
 *    no proof/public_signals (platform excludes these from the bonus).
 *
 * Encodings (ASSUMPTIONS — circuit-consistent, verified locally, but the
 * live platform's exact expectation is only confirmable via a practice
 * task / preflight):
 *  - taskId = keccak256(task_id string) mod bn128 prime.
 *  - vk hashes / addresses = BigInt(hex) (snarkjs reduces mod prime).
 *  - salt = SHA-256(HMAC-secret || task_id) mod prime: deterministic per
 *    task (safe on platform retries), never logged, never sent.
 *  - HMAC signature format: hex digest, optionally prefixed "sha256=";
 *    base64 also accepted. Compared with timingSafeEqual.
 *
 * Scoring driver for the proof-failure fallback: a correct decision
 * without a valid proof costs only -2 extra, while flipping the decision
 * costs -6 (wrong APPROVE) / -3 (wrong REJECT). So if proof generation
 * fails or times out, we still return the CORRECT decision without a
 * proof instead of failing closed to the wrong decision.
 *
 * Env: AGENT_GAMES_HMAC_SECRET (required unless ALLOW_DEV_SECRET=1),
 *      PORT (default 3001), SEEN_FILE (default ./seen.json).
 * Secrets are never logged.
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { keccak_256 } = require('js-sha3');
const snarkjs = require('snarkjs');

const PORT = Number(process.env.PORT || 3001);
const SECRET = process.env.AGENT_GAMES_HMAC_SECRET || '';
if (!SECRET && process.env.ALLOW_DEV_SECRET !== '1') {
  console.error('FATAL: AGENT_GAMES_HMAC_SECRET is not set. Set it from the dashboard "Rotate Secret" (shown once).');
  process.exit(1);
}
const HMAC_SECRET = SECRET || 'dev-test-secret-do-not-use-in-production';
const DIR = __dirname;
const WASM = path.join(DIR, 'gatekeeper.wasm');
const ZKEY = path.join(DIR, 'gatekeeper_final.zkey');
const VK = JSON.parse(fs.readFileSync(path.join(DIR, 'verification_key.json'), 'utf8'));
const SEEN_FILE = process.env.SEEN_FILE || path.join(DIR, 'seen.json');
const PROOF_TIMEOUT_MS = 45000;

const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const REASON = {
  VALID: 'VALID_CONDITION',
  VK: 'VK_SUBSTITUTION',
  THRESHOLD: 'THRESHOLD_MISMATCH',
  REUSED: 'PROOF_REUSED',
  EXPIRED: 'EXPIRED_CONDITION',
  RECIPIENT: 'RECIPIENT_MISMATCH',
  AMOUNT: 'AMOUNT_OVERFLOW',
};

// ---- seen-set (proof_tx -> task_id), persisted so restarts don't re-approve ----
let seen = new Map();
try {
  const raw = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
  if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) seen.set(k, v);
} catch { /* first run */ }
function markSeen(proofTx, taskId) {
  if (!proofTx) return;
  seen.set(proofTx, taskId);
  try { fs.writeFileSync(SEEN_FILE, JSON.stringify(Object.fromEntries(seen), null, 1)); } catch (e) { console.error('seen persist failed:', e.message); }
}

// ---- helpers ----
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
function signBody(obj) {
  const body = Buffer.from(JSON.stringify(obj));
  return { body, sig: hmacHex(HMAC_SECRET, body) };
}
function sendJson(res, status, obj, sign = true) {
  const { body, sig } = signBody(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    ...(sign ? { 'x-agent-games-signature': sig } : {}),
  });
  res.end(body);
}
function toFieldBigInt(hexStr) {
  if (typeof hexStr !== 'string') throw new Error('expected hex string');
  return BigInt(hexStr.startsWith('0x') || hexStr.startsWith('0X') ? hexStr : '0x' + hexStr);
}
function taskIdField(taskId) {
  // keccak256(task_id) mod field prime (see header note).
  return (BigInt('0x' + keccak_256(taskId)) % FIELD_PRIME).toString();
}
function saltFor(taskId) {
  // Deterministic per-task private nonce; never logged, never sent.
  const h = crypto.createHash('sha256').update(HMAC_SECRET, 'utf8').update('|', 'utf8').update(taskId, 'utf8').digest('hex');
  return (BigInt('0x' + h) % FIELD_PRIME).toString();
}

// Serialize proof generation: snarkjs fullProve is ~2 s; never overlap.
let proofQueue = Promise.resolve();
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out after ' + ms + 'ms')), ms); });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}
function proveDecision(circuitInput) {
  const run = proofQueue.then(async () => {
    const t0 = Date.now();
    const { proof, publicSignals } = await withTimeout(
      snarkjs.groth16.fullProve(circuitInput, WASM, ZKEY),
      PROOF_TIMEOUT_MS, 'groth16.fullProve');
    const ok = await snarkjs.groth16.verify(VK, publicSignals, proof);
    if (!ok) throw new Error('local groth16 verify failed');
    return { proof, publicSignals, ms: Date.now() - t0 };
  });
  // Keep the queue alive even if this run fails.
  proofQueue = run.catch(() => {});
  return run;
}

// ---- decision logic: deterministic, fail closed ----
function decide(task) {
  const input = task && task.input;
  if (!task || typeof task.task_id !== 'string' || !input || typeof input !== 'object') {
    return { decision: 'REJECT', reason_code: 'INVALID_TASK', unprovable: true };
  }
  const need = ['registered_vk', 'proof_vk', 'minimum', 'public_balance', 'expiry_block',
    'current_block', 'recipient', 'condition_recipient', 'amount', 'max_transfer'];
  for (const k of need) if (input[k] === undefined || input[k] === null || input[k] === '') {
    return { decision: 'REJECT', reason_code: 'INVALID_TASK', unprovable: true };
  }
  let nums;
  try {
    nums = {
      minimum: BigInt(String(input.minimum)),
      balance: BigInt(String(input.public_balance)),
      expiry: BigInt(String(input.expiry_block)),
      current: BigInt(String(input.current_block)),
      amount: BigInt(String(input.amount)),
      maxTransfer: BigInt(String(input.max_transfer)),
    };
    toFieldBigInt(String(input.registered_vk));
    toFieldBigInt(String(input.proof_vk));
    toFieldBigInt(String(input.recipient));
    toFieldBigInt(String(input.condition_recipient));
  } catch {
    return { decision: 'REJECT', reason_code: 'INVALID_TASK', unprovable: true };
  }
  const proofTx = typeof input.proof_tx === 'string' ? input.proof_tx : '';
  const normAddr = (a) => String(a).toLowerCase();
  // Order note: each scored task carries exactly one trap variety, so order
  // only matters for malformed/multi-trap inputs. Reuse is checked first:
  // a reused proof must be rejected even when every field check passes
  // (and decision=0 is unprovable in that case — see header).
  if (proofTx && seen.has(proofTx)) {
    return { decision: 'REJECT', reason_code: REASON.REUSED, unprovable: true, proofTx };
  }
  if (normAddr(input.registered_vk) !== normAddr(input.proof_vk)) {
    return { decision: 'REJECT', reason_code: REASON.VK, proofTx };
  }
  if (nums.balance < nums.minimum) {
    return { decision: 'REJECT', reason_code: REASON.THRESHOLD, proofTx };
  }
  if (nums.current > nums.expiry) {
    return { decision: 'REJECT', reason_code: REASON.EXPIRED, proofTx };
  }
  if (normAddr(input.recipient) !== normAddr(input.condition_recipient)) {
    return { decision: 'REJECT', reason_code: REASON.RECIPIENT, proofTx };
  }
  if (nums.amount > nums.maxTransfer) {
    return { decision: 'REJECT', reason_code: REASON.AMOUNT, proofTx };
  }
  return { decision: 'APPROVE', reason_code: REASON.VALID, proofTx };
}

function circuitInputFor(task, decision01) {
  const input = task.input;
  return {
    registeredVkHash: toFieldBigInt(String(input.registered_vk)).toString(),
    proofVkHash: toFieldBigInt(String(input.proof_vk)).toString(),
    minimum: String(input.minimum),
    publicBalance: String(input.public_balance),
    expiryBlock: String(input.expiry_block),
    currentBlock: String(input.current_block),
    recipient: toFieldBigInt(String(input.recipient)).toString(),
    conditionRecipient: toFieldBigInt(String(input.condition_recipient)).toString(),
    amount: String(input.amount),
    maxTransfer: String(input.max_transfer),
    decision: String(decision01),
    taskId: taskIdField(task.task_id),
    salt: saltFor(task.task_id),
  };
}

async function handleTask(task) {
  const t0 = Date.now();
  const verdict = decide(task);
  const proofTx = verdict.proofTx || (task.input && typeof task.input.proof_tx === 'string' ? task.input.proof_tx : '');
  const response = { decision: verdict.decision, reason_code: verdict.reason_code, proof_tx: proofTx || undefined };

  if (!verdict.unprovable && task && typeof task.task_id === 'string') {
    try {
      const { proof, publicSignals, ms } = await proveDecision(
        circuitInputFor(task, verdict.decision === 'APPROVE' ? 1 : 0));
      response.proof = proof;
      response.public_signals = publicSignals;
      console.log(JSON.stringify({ task_id: task.task_id, decision: verdict.decision, reason: verdict.reason_code, proof_ms: ms, total_ms: Date.now() - t0 }));
    } catch (e) {
      // Scoring-driven fallback (see header): keep the CORRECT decision,
      // return it without a proof (costs -2) instead of flipping it.
      console.error(JSON.stringify({ task_id: task.task_id, decision: verdict.decision, reason: verdict.reason_code, proof_error: String(e && e.message || e).slice(0, 200) }));
    }
  } else {
    console.log(JSON.stringify({ task_id: task && task.task_id, decision: verdict.decision, reason: verdict.reason_code, proof: 'none', total_ms: Date.now() - t0 }));
  }
  // Record the proof reference as seen once we have answered (any decision):
  // a re-sent task must be caught as PROOF_REUSED on retry.
  if (proofTx) markSeen(proofTx, task && task.task_id);
  if (response.proof_tx === undefined) delete response.proof_tx;
  return response;
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const raw = Buffer.concat(chunks);
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return sendJson(res, 200, { ok: true, service: 'gatekeeper', agent: 'AKANG-GK', protocolVersion: 'v1', uptime_s: Math.floor(process.uptime()), seen_proofs: seen.size }, false);
      }
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      // HMAC over the RAW body, BEFORE parsing. Fail closed.
      if (!signatureMatches(req.headers['x-agent-games-signature'], raw)) {
        return sendJson(res, 401, { error: 'invalid signature' });
      }
      let task;
      try { task = JSON.parse(raw.toString('utf8')); }
      catch { return sendJson(res, 400, { error: 'invalid json' }); }

      if (task && task.type === 'agent-games.preflight.v1') {
        return sendJson(res, 200, { ok: true, protocolVersion: 'v1' });
      }
      if (!task || task.type !== 'agent-games.proof-gatekeeper.v1') {
        return sendJson(res, 400, { error: 'unknown task type' });
      }
      // Hard deadline: answer within 60 s. Proof gen is ~2 s; the queue +
      // timeout above keep us far inside it. If we are already past the
      // task deadline, still answer (a late correct answer beats silence).
      const out = await handleTask(task);
      return sendJson(res, 200, out);
    } catch (e) {
      console.error('handler error:', String(e && e.message || e).slice(0, 300));
      try { return sendJson(res, 500, { error: 'internal error' }); } catch { /* socket gone */ }
    }
  });
  req.on('error', () => { try { res.destroy(); } catch {} });
});

server.listen(PORT, () => {
  console.log(`AKANG-GK gatekeeper listening on :${PORT} (POST /agent, GET /health). Seen proofs loaded: ${seen.size}`);
});

module.exports = { decide, taskIdField, saltFor };
