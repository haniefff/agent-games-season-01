'use strict';
/**
 * Local test harness for the Steal the VFY server + committed strategy.
 * Spawns server.cjs on a test port with STEAL_SALT=123 and the default
 * params [5,50,0,0,0,0,0,0], then:
 *  - preflight / bad HMAC / health (commitment matches Poseidon(params,salt))
 *  - live turns via HTTP: EXTRACT (100/100), FORTIFY (40/100), HOLD (100/0),
 *    wrong-commitment envelope -> HOLD without proof; every returned proof
 *    is re-verified with snarkjs and its publicInputsHash is recomputed
 *    independently (keccak256 ABI-packed, /build field order).
 *  - simulated 20-turn matches (resolver model documented in the file)
 *    vs 4 simple opponents, using the same decide() as the server.
 *
 * Usage: cd ~/workspace/agentgames && node steal/test-steal.cjs
 * Exit 0 iff every expectation passes. Writes test-results.json next to it.
 */
const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { keccak_256 } = require('js-sha3');
const snarkjs = require('snarkjs');
const { decide, DEFAULT_PARAMS } = require('./strategy.cjs');

const DIR = __dirname;
const PORT = 3102;
const SECRET = 'test-secret-steal-123';
const SALT = '123';
const BASE = `http://127.0.0.1:${PORT}`;
const VK = JSON.parse(fs.readFileSync(path.join(DIR, 'verification_key.json'), 'utf8'));
const MATCH = '9f4e1b2a-0000-4000-8000-000000000001';

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
function u256be(n) {
  let b = BigInt(n);
  const buf = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) { buf[i] = Number(b & 0xffn); b >>= 8n; }
  return buf;
}
function expectedHash({ commitment, matchId, turn, selfBalance, opponentBalance, actionCode, amount }) {
  const parts = [
    u256be(BigInt(commitment)), u256be(BigInt('0x' + String(matchId).replace(/-/g, ''))),
    u256be(BigInt(turn)), u256be(BigInt(selfBalance)), u256be(BigInt(opponentBalance)),
    u256be(BigInt(actionCode)), u256be(BigInt(amount)), u256be(1n),
  ];
  return '0x' + keccak_256(Buffer.concat(parts));
}
function turnEnv(turn, selfBalance, opponentBalance, commitmentHex) {
  return {
    protocolVersion: 'v1', eventId: 'steal-the-vfy', mode: 'competition',
    matchId: MATCH, turn, issuedAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + 300000).toISOString(),
    state: { selfBalance: String(selfBalance), opponentBalance: String(opponentBalance), selfFortifiedUntilTurn: null, opponentFortifiedUntilTurn: null },
    strategyCommitment: { hash: commitmentHex },
    resolverVersion: 'v1', nonce: 'nonce-' + turn,
  };
}
async function checkTurn(name, env, expectedAction, expectedAmount, commitmentDec) {
  const t0 = Date.now();
  const r = await post('/agent', env);
  let j = null; try { j = JSON.parse(r.body); } catch {}
  if (!j || r.status !== 200 || j.matchId !== MATCH || j.turn !== env.turn) {
    return record(name, false, 'bad envelope echo: ' + r.body.slice(0, 150));
  }
  if (j.action.type !== expectedAction) return record(name, false, `action=${j.action.type}, expected ${expectedAction}`);
  const amountOk = expectedAction === 'EXTRACT' ? j.action.amount === expectedAmount : j.action.amount === undefined;
  if (!amountOk) return record(name, false, 'amount field wrong: ' + JSON.stringify(j.action));
  if (r.headers['x-agent-games-signature'] !== hmac(Buffer.from(r.body))) return record(name, false, 'response signature invalid');
  if (!j.policyProof || !j.policyProof.proof || !j.policyProof.public_signals) return record(name, false, 'missing policyProof');
  const code = { HOLD: 0, FORTIFY: 1, EXTRACT: 2 }[expectedAction];
  const amt = expectedAction === 'EXTRACT' ? expectedAmount : 0;
  const wantHash = expectedHash({ commitment: commitmentDec, matchId: MATCH, turn: env.turn, selfBalance: env.state.selfBalance, opponentBalance: env.state.opponentBalance, actionCode: code, amount: amt });
  if (j.policyProof.publicInputsHash !== wantHash) return record(name, false, `publicInputsHash mismatch: got ${j.policyProof.publicInputsHash} want ${wantHash}`);
  const ok = await snarkjs.groth16.verify(VK, j.policyProof.public_signals, j.policyProof.proof);
  if (!ok) return record(name, false, 'snarkjs verify FAILED');
  const sig = j.policyProof.public_signals;
  const sigOk = sig.length === 9 && sig[1] === commitmentDec && sig[2] === BigInt('0x' + MATCH.replace(/-/g, '')).toString()
    && sig[3] === String(env.turn) && sig[4] === env.state.selfBalance && sig[5] === env.state.opponentBalance
    && sig[6] === String(code) && sig[7] === String(amt) && sig[8] === '1';
  return record(name, ok && sigOk, `verify=OK signalsOk=${sigOk} ${Date.now() - t0} ms`);
}

// --- simulated match resolver (OUR model of the /build rules) ---
// Simultaneous submission on prior state. FORTIFY costs 2, blocks up to 6
// of incoming extraction. EXTRACT takes up to N from the opponent's
// balance (reduced by 6 if the opponent fortified this turn).
// This is a model for strategy sanity-checking, NOT the platform resolver.
function simulate(opponentFn, turns = 20) {
  let self = 100, opp = 100;
  const log = [];
  for (let t = 1; t <= turns; t++) {
    const me = decide(self, opp, DEFAULT_PARAMS);
    const them = opponentFn(self, opp, t);
    const meFort = me.type === 'FORTIFY', themFort = them.type === 'FORTIFY';
    const meCost = meFort ? 2 : 0, themCost = themFort ? 2 : 0;
    const meGain = me.type === 'EXTRACT' ? Math.max(0, Math.min(me.amount, opp) - (themFort ? 6 : 0)) : 0;
    const themGain = them.type === 'EXTRACT' ? Math.max(0, Math.min(them.amount, self) - (meFort ? 6 : 0)) : 0;
    self = Math.max(0, self + meGain - themGain - meCost);
    opp = Math.max(0, opp + themGain - meGain - themCost);
    log.push(`t${t} me=${me.type}${me.amount || ''} them=${them.type}${them.amount || ''} -> ${self}/${opp}`);
  }
  return { self, opp, log, outcome: self > opp ? 'WIN' : self < opp ? 'LOSS' : 'DRAW' };
}
const OPPONENTS = {
  'Always-EXTRACT-10': () => ({ type: 'EXTRACT', amount: 10 }),
  'Always-HOLD': () => ({ type: 'HOLD' }),
  'Always-FORTIFY': () => ({ type: 'FORTIFY' }),
  'Mirror (same policy)': (s, o) => decide(o, s, DEFAULT_PARAMS),
};

async function main() {
  const poseidon = await require('circomlibjs').buildPoseidon();
  const commitmentDec = poseidon.F.toString(poseidon([...DEFAULT_PARAMS.map(BigInt), BigInt(SALT)]));
  const commitmentHex = '0x' + BigInt(commitmentDec).toString(16);

  const server = spawn(process.execPath, [path.join(DIR, 'server.cjs')], {
    cwd: DIR,
    env: { ...process.env, PORT: String(PORT), AGENT_GAMES_HMAC_SECRET: SECRET, ALLOW_DEV_SECRET: '1', STEAL_SALT: SALT, STRATEGY_PARAMS: DEFAULT_PARAMS.join(','), STRATEGY_COMMITMENT: commitmentHex },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
  server.stderr.on('data', (d) => process.stdout.write('[server:err] ' + d));
  let up = false;
  for (let i = 0; i < 50; i++) {
    try { const r = await get('/health'); if (r.status === 200) { up = true; break; } } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  record('server starts + GET /health', up);
  if (!up) { server.kill(); process.exit(1); }
  const health = JSON.parse((await get('/health')).body);
  record('health reports registered commitment', health.strategyCommitment === commitmentHex, health.strategyCommitment);

  const pre = await post('/agent', { type: 'agent-games.preflight.v1', agent_id: 'agt_test', issued_at: new Date().toISOString(), nonce: 'abc123' });
  let pj = null; try { pj = JSON.parse(pre.body); } catch {}
  record('preflight -> {ok:true, protocolVersion:v1} signed', pre.status === 200 && pj && pj.ok === true && pj.protocolVersion === 'v1', pre.body.slice(0, 100));
  const bad = await post('/agent', turnEnv(1, 100, 100, commitmentHex), 'wrong-secret');
  record('bad HMAC -> 401', bad.status === 401, 'status=' + bad.status);

  await checkTurn('turn 100/100 -> EXTRACT 10 + valid proof + hash', turnEnv(1, 100, 100, commitmentHex), 'EXTRACT', 10, commitmentDec);
  await checkTurn('turn 40/100 -> FORTIFY (no amount) + valid proof', turnEnv(2, 40, 100, commitmentHex), 'FORTIFY', undefined, commitmentDec);
  await checkTurn('turn 100/0 -> HOLD (no amount) + valid proof', turnEnv(3, 100, 0, commitmentHex), 'HOLD', undefined, commitmentDec);
  // Wrong commitment in envelope -> HOLD, no proof.
  const wrong = await post('/agent', turnEnv(4, 100, 100, '0x1234'));
  let wj = null; try { wj = JSON.parse(wrong.body); } catch {}
  record('wrong envelope commitment -> HOLD, no proof', wrong.status === 200 && wj && wj.action.type === 'HOLD' && !wj.policyProof, wrong.body.slice(0, 150));

  // Strategy unit checks (no HTTP): decoded policy boundaries.
  const unit = [
    ['decide 100/100 -> EXTRACT 10', decide(100, 100).type === 'EXTRACT' && decide(100, 100).amount === 10],
    ['decide 50/100 -> EXTRACT (50 not < 50)', decide(50, 100).type === 'EXTRACT'],
    ['decide 49/100 -> FORTIFY', decide(49, 100).type === 'FORTIFY'],
    ['decide 40/0 -> FORTIFY (fortify beats hold)', decide(40, 0).type === 'FORTIFY'],
    ['decide 100/0 -> HOLD', decide(100, 0).type === 'HOLD'],
    ['decide mode1 100/100 -> HOLD (no extract)', decide(100, 100, [5, 50, 0, 1, 0, 0, 0, 0]).type === 'HOLD'],
    ['decide mode1 40/100 -> FORTIFY', decide(40, 100, [5, 50, 0, 1, 0, 0, 0, 0]).type === 'FORTIFY'],
    ['decide minOpp10: opp10 HOLD, opp11 EXTRACT', decide(100, 10, [5, 50, 10, 0, 0, 0, 0, 0]).type === 'HOLD' && decide(100, 11, [5, 50, 10, 0, 0, 0, 0, 0]).type === 'EXTRACT'],
  ];
  for (const [n, ok] of unit) record(n, ok);

  // Simulated matches.
  for (const [name, fn] of Object.entries(OPPONENTS)) {
    const m = simulate(fn);
    console.log(`SIM vs ${name}: ${m.outcome} final ${m.self}/${m.opp}`);
    record(`simulated match vs ${name} (model resolver)`, true, `${m.outcome} ${m.self}/${m.opp}`);
  }

  const passed = results.filter((x) => x.pass).length;
  fs.writeFileSync(path.join(DIR, 'test-results.json'), JSON.stringify({ ran_at: new Date().toISOString(), passed, total: results.length, results }, null, 2));
  console.log(`\nSTEAL: ${passed}/${results.length} passed`);
  server.kill();
  process.exit(passed === results.length ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
