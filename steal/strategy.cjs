'use strict';
/**
 * AKANG-GK — Steal the VFY committed strategy.
 *
 * The policy is COMMITTED, not chosen per turn: the circuit
 * (VfyPolicyProof, vfy-policy.wasm/zkey) proves the action follows
 * deterministically from the game state and these 8 parameters.
 * params[0..7] are hashed with a fixed salt into the strategy commitment
 *   commitment = Poseidon(params[0..7], salt)
 * which is registered on the dashboard BEFORE Swiss Round 1 and frozen
 * while matches are paired. Changing any parameter (or the salt) changes
 * the commitment and invalidates the registration — so tune BEFORE
 * registering, never mid-tournament.
 *
 * Verified against the official circuit (local oracle probing, see
 * steal/TEST-LOG.md). For params [5,50,0,0,0,0,0,0]:
 *  - commitment MUST equal Poseidon(params, salt) or the witness fails
 *    at VfyPolicyProof_154 line 72.
 *  - EXTRACT amount MUST equal params[0] exactly (line 149 refuses 3, 10).
 *  - The action is a deterministic function of (selfBalance,
 *    opponentBalance, params) ONLY — the circuit has no input for
 *    fortification state, turn history, or opponent identity, so the
 *    policy cannot react to those. Any deviation is unprovable (line 140).
 *
 * Decoded policy for the default params:
 *   params[0] = extract amount (1..10) ............ 10
 *   params[1] = fortify threshold ................. 50
 *   params[2] = min opponent balance for EXTRACT .. 0
 *   params[3] = mode: 0 = normal, 1 = defensive (no EXTRACT)
 *   params[4..7] = must be 0.
 *
 * Decision (mode 0), verified case by case:
 *   1. selfBalance < params[1]            -> FORTIFY
 *      (even when opponentBalance is 0 — FORTIFY beats HOLD there)
 *   2. opponentBalance <= params[2]       -> HOLD
 *      (nothing worth taking; extracting is refused by the circuit)
 *   3. otherwise                          -> EXTRACT params[0]
 *   Boundary checks verified: self=50 extracts (50 is NOT < 50);
 *   opp=10 with params[2]=10 holds, opp=11 extracts (strictly greater).
 *
 * Decision (mode 1, defensive): EXTRACT is refused by the circuit;
 *   selfBalance < params[1] -> FORTIFY, else HOLD.
 *
 * Reasoning (why this shape, not random):
 *  - EXTRACT is free and the only way to gain; whenever the opponent
 *    has anything to take and we are not fragile, take the maximum 10.
 *    Under the published rules EXTRACT has no cost, so amount 10 weakly
 *    dominates any smaller amount: it draws equal extractors (10v10),
 *    beats smaller extractors (10v5 ends 195/5 in simulation), and
 *    drains holders/fortifiers fastest. Simulated sweep (model resolver,
 *    see test-steal.cjs): params[0]=5 LOSES 0/182 to Always-EXTRACT-10
 *    and to a Mirror-10-50, while params[0]=10 draws both and wins
 *    182/0 vs Mirror-5-50. params[0]=7 still loses 31/163 to
 *    Always-EXTRACT-10. The reference repo's default of 5 was tested
 *    and REJECTED on this evidence — 10 is the committed value.
 *    Caveat: the sweep uses our model of the resolver (simultaneous,
 *    fortify blocks 6, balances clamped at 0); the platform's exact
 *    "exposed balance" is not fully specified in the public docs, but
 *    no published rule penalises a larger extract, so 10 is safe.
 *  - FORTIFY costs 2 and blocks up to 6 of incoming extraction. It only
 *    pays when we are low: below 50 our remaining balance is worth
 *    protecting more than the 2 cost, and a low balance means the
 *    opponent's extract would otherwise eat a large share of what is
 *    left. In the sweep the threshold (30/50/70) never changed an
 *    outcome against these opponents — it only matters when we are
 *    already losing the exchange — so 50 is kept as the middle default.
 *    The circuit's fixed policy does not let us fortify above the
 *    threshold; that is a limitation of the commitment, not a choice.
 *  - HOLD when the opponent is at/below params[2]: extracting 0 is
 *    impossible (circuit refuses), fortifying wastes 2 when there is
 *    nothing to steal and we are not fragile.
 *  - Endgame: the policy does not change in the last turns (no turn
 *    input to the policy beyond the binding public signals) — a
 *    trailing agent cannot "go for broke" inside this commitment.
 *    That is a limitation of the committed policy language, not a bug.
 */
const DEFAULT_PARAMS = [10, 50, 0, 0, 0, 0, 0, 0];

const ACTION = { HOLD: 0, FORTIFY: 1, EXTRACT: 2 };
const ACTION_NAME = ['HOLD', 'FORTIFY', 'EXTRACT'];

/**
 * @param {number|bigint|string} selfBalance
 * @param {number|bigint|string} opponentBalance
 * @param {number[]} params strategyParams[0..7]
 * @returns {{type:string, code:number, amount?:number}} amount omitted for HOLD/FORTIFY
 */
function decide(selfBalance, opponentBalance, params = DEFAULT_PARAMS) {
  const self = Number(selfBalance);
  const opp = Number(opponentBalance);
  const [extractAmount, fortifyThreshold, minOppBalance, mode] = params.map(Number);
  if (!Number.isFinite(self) || !Number.isFinite(opp) || self < 0 || opp < 0) {
    throw new Error('invalid balances');
  }
  if (mode === 1) {
    // Defensive: EXTRACT is refused by the circuit in this mode.
    if (self < fortifyThreshold) return { type: 'FORTIFY', code: ACTION.FORTIFY };
    return { type: 'HOLD', code: ACTION.HOLD };
  }
  if (self < fortifyThreshold) return { type: 'FORTIFY', code: ACTION.FORTIFY };
  if (opp <= minOppBalance) return { type: 'HOLD', code: ACTION.HOLD };
  return { type: 'EXTRACT', code: ACTION.EXTRACT, amount: extractAmount };
}

module.exports = { DEFAULT_PARAMS, ACTION, ACTION_NAME, decide };
