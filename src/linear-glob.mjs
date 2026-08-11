// SPDX-License-Identifier: FSL-1.1-MIT
/** Linear-time glob execution over precompiled tokens. No user input enters RegExp. */

const fold = (value, icase) => (icase ? String(value).toLowerCase() : String(value));

/**
 * @typedef {{kind:'star',crossSlash:boolean}|{kind:'one',crossSlash:boolean}|
 *   {kind:'literal',value:string}|{kind:'class',matches:(char:string,icase:boolean)=>boolean}} GlobToken
 */

/**
 * Compile an already-tokenized glob into an O(pattern × subject) NFA simulation.
 * @param {GlobToken[]} tokens
 * @param {{icase?:boolean,maxSubjectCodeUnits?:number,overflowMatches?:boolean}} [opts]
 */
export function compileLinearGlobTokens(tokens, {
  icase = false, maxSubjectCodeUnits = 32_768, overflowMatches = false,
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
      let state = epsilonClose(Uint8Array.from({ length: size + 1 }, (_, i) => (i === 0 ? 1 : 0)));
      for (let offset = 0; offset < subject.length; offset++) {
        const char = subject[offset];
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
          } else if (token.matches(char, icase)) {
            next[i + 1] = 1;
            any = true;
          }
        }
        if (!any) return false;
        state = epsilonClose(next);
      }
      return epsilonClose(state)[size] === 1;
    },
  });
}
