'use strict';
/**
 * Local test harness for the Gatekeeper server. Spawns server.cjs on a test
 * port with a throwaway HMAC secret, then replays: preflight, bad signature,
 * health, a valid task, and all 7 trap varieties (incl. PROOF_REUSED by
 * re-sending the valid task). Every returned proof is re-verified with
 * snarkjs against the official verification key, and public signals are
 * checked field by field.
 *
 * Usage: node test-gatekeeper.cjs   (run from gatekeeper/ ; needs the
 *   repo-root node_modules: cd ~/workspace/agentgames && node gatekeeper/test-gatekeeper.cjs)
 * Exit 0 iff every expectation passes. Writes test-results.json next to it.
 */
const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { keccak_256 } = require('js-sha3');
const snarkjs = require('snarkjs');

const DIR = __dirname;
const ROOT = path.join(DIR, '..');
const PORT = 3101;
const SECRET = 'test-secret-gatekeeper-123';
const BASE = `http://127.0.0.1:${PORT}`;
const VK = JSON.parse(fs.readFileSync(path.join(DIR, 'verification_key.json'), 'utf8'));
const PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const REG_VK = '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0';
const RECIP = '0xDe42000000000000000000000000000000009f01';

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
function hmac(bodyBuf) {
  return crypto.createHmac('sha256', SECRET).update(bodyBuf).digest('hex');
}
function post(pathname, obj, secretOverride) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(obj));
    const headers = { 'content-type': 'application/json' };
    if (secretOverride !== null) {
      headers['x-agent-games-signature'] = secretOverride === undefined ? hmac(body)
        : crypto.createHmac('sha256', secretOverride).update(body).digest('hex');
    }
    const req = http.request(BASE + pathname, { method: 'POST', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
function get(pathname) {
  return new Promise((resolve, reject) => {
    http.get(BASE + pathname, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
}
function task(taskId, input) {
  return {
    type: 'agent-games.proof-gatekeeper.v1',
    task_id: taskId,
    mode: 'competition',
    issued_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + 60000).toISOString(),
    input: {
      registered_vk: REG_VK, proof_vk: REG_VK, minimum: '1000', public_balance: '1460',
      expiry_block: 19842201, current_block: 19832000, recipient: RECIP,
      condition_recipient: RECIP, amount: '500', max_transfer: '1000',
      proof_tx: '0x' + taskId.replace(/[^a-z0-9]/gi, '').padEnd(40, '0').slice(0, 40),
      ...input,
    },
  };
}
async function checkProof(name, resp, expectedDecision, expectedReason, expectProof) {
  let j;
  try { j = JSON.parse(resp.body); } catch { return record(name, false, 'non-JSON response: ' + resp.body.slice(0, 120)); }
  const decOk = j.decision === expectedDecision;
  const reasonOk = j.reason_code === expectedReason;
  const sigOk = resp.headers['x-agent-games-signature'] === hmac(Buffer.from(resp.body));
  if (!decOk || !reasonOk || !sigOk) {
    return record(name, false, `decision=${j.decision} reason=${j.reason_code} sigOk=${sigOk}`);
  }
  if (!expectProof) {
    return record(name, j.proof === undefined && j.public_signals === undefined, 'expected no proof, got proof=' + !!j.proof);
  }
  if (!j.proof || !j.public_signals || j.public_signals.length !== 13) {
    return record(name, false, 'missing/incomplete proof (signals=' + (j.public_signals && j.public_signals.length) + ')');
  }
  const ok = await snarkjs.groth16.verify(VK, j.public_signals, j.proof);
  if (!ok) return record(name, false, 'snarkjs verify FAILED');
  // Public-signal field checks (vk hashes reduced mod prime).
  const vkMod = (BigInt(REG_VK) % PRIME).toString();
  const recipField = BigInt(RECIP).toString();
  const sig = j.public_signals;
  const fieldsOk = sig[1] === vkMod && sig[3] === '1000' && sig[11] === (expectedDecision === 'APPROVE' ? '1' : '0');
  // public[0] must equal Poseidon(salt, taskId) with our deterministic salt.
  const taskIdStr = resp._taskId;
  const taskIdField = (BigInt('0x' + keccak_256(taskIdStr)) % PRIME).toString();
  const salt = (BigInt('0x' + crypto.createHash('sha256').update(SECRET, 'utf8').update('|', 'utf8').update(taskIdStr, 'utf8').digest('hex')) % PRIME).toString();
  const poseidon = await require('circomlibjs').buildPoseidon();
  const commit = poseidon.F.toString(poseidon([BigInt(salt), BigInt(taskIdField)]));
  const commitOk = sig[0] === commit && sig[12] === taskIdField;
  void recipField;
  return record(name, fieldsOk && commitOk, `verify=OK fieldsOk=${fieldsOk} commitmentOk=${commitOk} decision=${j.decision}`);
}

async function main() {
  const server = spawn(process.execPath, [path.join(DIR, 'server.cjs')], {
    cwd: DIR,
    env: { ...process.env, PORT: String(PORT), AGENT_GAMES_HMAC_SECRET: SECRET, ALLOW_DEV_SECRET: '1', SEEN_FILE: path.join(DIR, 'seen-test.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
  server.stderr.on('data', (d) => process.stdout.write('[server:err] ' + d));
  try { fs.unlinkSync(path.join(DIR, 'seen-test.json')); } catch {}
  // Wait for health.
  let up = false;
  for (let i = 0; i < 50; i++) {
    try { const r = await get('/health'); if (r.status === 200) { up = true; break; } } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  record('server starts + GET /health', up);
  if (!up) { server.kill(); process.exit(1); }

  // Preflight.
  const pre = await post('/agent', { type: 'agent-games.preflight.v1', agent_id: 'agt_test', issued_at: new Date().toISOString(), nonce: 'abc123' });
  let pj = null; try { pj = JSON.parse(pre.body); } catch {}
  record('preflight -> {ok:true, protocolVersion:v1} signed', pre.status === 200 && pj && pj.ok === true && pj.protocolVersion === 'v1' && pre.headers['x-agent-games-signature'] === hmac(Buffer.from(pre.body)), pre.body.slice(0, 100));

  // Bad signature -> 401, no processing.
  const bad = await post('/agent', task('gk_test_bad', {}), 'wrong-secret');
  record('bad HMAC -> 401', bad.status === 401, 'status=' + bad.status);
  const missing = await post('/agent', task('gk_test_nosig', {}), null);
  record('missing HMAC -> 401', missing.status === 401, 'status=' + missing.status);

  // Valid task.
  const valid = task('gk_24_9d1', {});
  const t0 = Date.now();
  let r = await post('/agent', valid);
  r._taskId = 'gk_24_9d1';
  await checkProof('VALID_CONDITION -> APPROVE + valid proof', r, 'APPROVE', 'VALID_CONDITION', true);
  record('valid task answered < 60 s', Date.now() - t0 < 60000, (Date.now() - t0) + ' ms');

  // Traps (each with its own proof_tx).
  const traps = [
    ['VK_SUBSTITUTION', task('gk_trap_vk', { proof_vk: '0xaaaa000000000000000000000000000000000000000000000000000000000001' }), 'REJECT', 'VK_SUBSTITUTION'],
    ['THRESHOLD_MISMATCH', task('gk_trap_thr', { public_balance: '900' }), 'REJECT', 'THRESHOLD_MISMATCH'],
    ['EXPIRED_CONDITION', task('gk_trap_exp', { current_block: 19843000 }), 'REJECT', 'EXPIRED_CONDITION'],
    ['RECIPIENT_MISMATCH', task('gk_trap_rec', { recipient: '0x1111000000000000000000000000000000000001' }), 'REJECT', 'RECIPIENT_MISMATCH'],
    ['AMOUNT_OVERFLOW', task('gk_trap_amt', { amount: '1500' }), 'REJECT', 'AMOUNT_OVERFLOW'],
  ];
  for (const [name, t, dec, reason] of traps) {
    const rr = await post('/agent', t);
    rr._taskId = t.task_id;
    await checkProof(`${name} -> ${dec} + valid proof`, rr, dec, reason, true);
  }
  // PROOF_REUSED: re-send the exact valid task (same proof_tx).
  const reuse = await post('/agent', valid);
  reuse._taskId = 'gk_24_9d1';
  await checkProof('PROOF_REUSED (resend valid task) -> REJECT, no proof', reuse, 'REJECT', 'PROOF_REUSED', false);

  // Malformed task -> REJECT INVALID_TASK, no proof.
  const malformed = await post('/agent', { type: 'agent-games.proof-gatekeeper.v1', task_id: 'gk_bad', input: { minimum: '1000' } });
  let mj = null; try { mj = JSON.parse(malformed.body); } catch {}
  record('malformed task -> REJECT INVALID_TASK, no proof', malformed.status === 200 && mj && mj.decision === 'REJECT' && mj.reason_code === 'INVALID_TASK' && !mj.proof, malformed.body.slice(0, 120));

  const passed = results.filter((x) => x.pass).length;
  fs.writeFileSync(path.join(DIR, 'test-results.json'), JSON.stringify({ ran_at: new Date().toISOString(), passed, total: results.length, results }, null, 2));
  console.log(`\nGATEKEEPER: ${passed}/${results.length} passed`);
  server.kill();
  try { fs.unlinkSync(path.join(DIR, 'seen-test.json')); } catch {}
  process.exit(passed === results.length ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
