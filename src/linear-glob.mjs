// SPDX-License-Identifier: FSL-1.1-MIT
/** Bounded glob execution over precompiled tokens. No user input enters RegExp. */

// One unit is one NFA state cell allocated/inspected, or one bracket member inspected. This is
// deliberately a WORK limit rather than a clock: the verdict is identical on a loaded laptop and
// an idle hosted runner. Eight million units leaves ordinary path sets ample headroom while turning
// the largest admitted 8K-token pattern from hundreds of millions of state visits into a bounded
// conservative answer.
export const DEFAULT_GLOB_WORK_BUDGET = 8_000_000;

/**
 * A mutable, deterministic budget that can be shared by every subject in one candidate-path set.
 * The object is frozen; only the counters closed over by spend() can move.
 *
 * @param {number} [maxWork]
 * @returns {{spend:(units:number)=>boolean,readonly maxWork:number,readonly used:number,
 *   readonly remaining:number,readonly exhausted:boolean}}
 */
export function createGlobWorkBudget(maxWork = DEFAULT_GLOB_WORK_BUDGET) {
  if (!Number.isSafeInteger(maxWork) || maxWork < 0) {
    throw new RangeError('glob work budget must be a non-negative safe integer');
  }
  let used = 0;
  let exhausted = false;
  return Object.freeze({
    spend(units) {
      if (!Number.isSafeInteger(units) || units < 0) {
        throw new RangeError('glob work charge must be a non-negative safe integer');
      }
      if (exhausted) return false;
      if (units > maxWork - used) { exhausted = true; return false; }
      used += units;
      return true;
    },
    get maxWork() { return maxWork; },
    get used() { return used; },
    get remaining() { return maxWork - used; },
    get exhausted() { return exhausted; },
  });
}

const fold = (value, icase) => (icase ? String(value).toLowerCase() : String(value));

/**
 * @typedef {{kind:'star',crossSlash:boolean}|{kind:'one',crossSlash:boolean}|
 *   {kind:'literal',value:string}|{kind:'class',matches:(char:string,icase:boolean)=>boolean,
 *   work?:number}} GlobToken
 */

/**
 * Compile an already-tokenized glob into an NFA simulation with a deterministic total work cap.
 * Without workBudget, each test gets a fresh budget. Supplying one shares the total across every
 * test call, which is how destructive target resolution bounds a whole candidate-path set rather
 * than allowing each candidate to restart the meter.
 *
 * @param {GlobToken[]} tokens
 * @param {{icase?:boolean,maxSubjectCodeUnits?:number,overflowMatches?:boolean,
 *   maxWork?:number,workBudget?:ReturnType<typeof createGlobWorkBudget>|null}} [opts]
 */
export function compileLinearGlobTokens(tokens, {
  icase = false, maxSubjectCodeUnits = 32_768, overflowMatches = false,
  maxWork = DEFAULT_GLOB_WORK_BUDGET, workBudget = null,
} = {}) {
  const size = tokens.length;
  const epsilonClose = (state) => {
    for (let i = 0; i < size; i++) {
      if (state[i] && tokens[i].kind === 'star') state[i + 1] = 1;
    }
    return state;
  };
  return Object.freeze({
    test(value) {
      const subject = String(value);
      if (subject.length > maxSubjectCodeUnits) return overflowMatches;
      const meter = workBudget ?? createGlobWorkBudget(maxWork);
      if (meter.exhausted) return overflowMatches;

      // Initial state allocation plus the first epsilon-closure. Charge before doing the work, so
      // a caller never receives a late answer after the advertised total has already been crossed.
      if (!meter.spend((size * 2) + 1)) return overflowMatches;
      let state = new Uint8Array(size + 1);
      state[0] = 1;
      state = epsilonClose(state);
      for (let offset = 0; offset < subject.length; offset++) {
        const char = subject[offset];
        // Allocate the next state vector and inspect the current one. Class callbacks carry their
        // own member-inspection charge below; all other token work is constant per inspected cell.
        if (!meter.spend((size * 2) + 1)) return overflowMatches;
        const next = new Uint8Array(size + 1);
        let any = false;
        for (let i = 0; i < size; i++) {
          if (!state[i]) continue;
          const token = tokens[i];
          if (token.kind === 'star') {
            if (token.crossSlash || char !== '/') { next[i] = 1; any = true; }
          } else if (token.kind === 'one') {
            if (token.crossSlash || char !== '/') { next[i + 1] = 1; any = true; }
          } else if (token.kind === 'literal') {
            if (fold(token.value, icase) === fold(char, icase)) { next[i + 1] = 1; any = true; }
          } else {
            // A bracket token may represent thousands of members while occupying one NFA state.
            // Account for that hidden loop before entering it; otherwise a one-token pattern can
            // still perform pattern×subject work outside the state budget.
            const declaredWork = token.work;
            const classWork = typeof declaredWork === 'number'
              && Number.isSafeInteger(declaredWork) && declaredWork > 0 ? declaredWork : 1;
            const foldedWork = icase && classWork <= Math.floor(Number.MAX_SAFE_INTEGER / 3)
              ? classWork * 3 : classWork;
            if (!meter.spend(foldedWork)) return overflowMatches;
            if (token.matches(char, icase)) { next[i + 1] = 1; any = true; }
          }
        }
        if (!any) return false;
        if (!meter.spend(size)) return overflowMatches;
        state = epsilonClose(next);
      }
      // Every state reaching here has already been epsilon-closed: initially above, then once for
      // each consumed character. A second final closure was redundant O(pattern) work.
      return state[size] === 1;
    },
  });
}
