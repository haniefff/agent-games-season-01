'use strict';
/**
 * Generate a fresh Steal the VFY strategy salt + commitment for registration.
 *
 * Run ONCE before registering (or re-registering) the Steal agent:
 *   node steal/gen-commitment.cjs [params]
 *   e.g. node steal/gen-commitment.cjs 10,50,0,0,0,0,0,0
 *
 * Prints:
 *   STEAL_SALT=<random decimal>          -> put in .env (NEVER commit, NEVER log elsewhere)
 *   STRATEGY_COMMITMENT=0x...           -> paste into Dashboard -> My Agents -> Edit agent (Steal section)
 *   commitment (decimal)                -> same value, decimal form
 *
 * The salt is random per run. The commitment is Poseidon(params, salt),
 * verified against the official vfy-policy circuit. If you re-run this,
 * you get a DIFFERENT salt/commitment — you must then re-register the new
 * commitment before Swiss Round 1; never change the salt mid-tournament.
 * The test salt "123" used in test-steal.cjs is NOT a production salt.
 */
const crypto = require('crypto');

async function main() {
  const params = (process.argv[2] || '10,50,0,0,0,0,0,0').split(',').map((s) => {
    const n = Number(s.trim());
    if (!Number.isInteger(n) || n < 0) throw new Error('params must be non-negative integers');
    return n;
  });
  if (params.length !== 8) throw new Error('params must have exactly 8 values');
  const salt = BigInt('0x' + crypto.randomBytes(16).toString('hex')).toString();
  const { buildPoseidon } = require('circomlibjs');
  const poseidon = await buildPoseidon();
  const commitment = poseidon.F.toString(poseidon([...params.map(BigInt), BigInt(salt)]));
  console.log('# Steal the VFY — strategy commitment (generate once, register before Swiss Round 1)');
  console.log('# params: [' + params.join(', ') + ']');
  console.log('STEAL_SALT=' + salt);
  console.log('STRATEGY_COMMITMENT=0x' + BigInt(commitment).toString(16));
  console.log('# commitment (decimal): ' + commitment);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
