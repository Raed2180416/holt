/**
 * grove — the relationship graph and the decisions that fall out of it.
 *
 * This is the layer that does not exist anywhere else. Verified against the closest prior
 * art: treehouse-worktree (MCP) exposes create/list/status/remove/lock/conflicts and treats
 * each worktree as independent; gwq shows per-worktree status only; Vibe Kanban / Conductor /
 * Superset / Nimbalyst model a worktree as a session card. The published worktree-comparison
 * skills are interactive PAIRWISE diff viewers ("compare this worktree with my workspace").
 * None of them relate N workstreams to each other by CONTENT.
 *
 * Five of the seven documented parallel-agent problems reduce to one query — what is the
 * content relationship between N workstreams — so they are answered from one graph:
 *
 *   P0 invisible/lost work   -> uniqueWork()      "this exists nowhere else"
 *   P1 hotspot collision     -> collisions()      "these two will fight"
 *   P2 context blindness     -> contextDigest()   "here's what your siblings did"
 *   P3 redundant work        -> duplicates()      "these two built the same thing"
 *   P6 safe deletion         -> safeToDelete()    "this one is provably disposable"
 *
 * P5 (review bottleneck) is served by landingPlan(), which orders and deduplicates rather
 * than reviewing. P4 (semantic conflict) is deliberately NOT attempted: it is unresolved
 * research, and a confident wrong answer there is worse than no answer.
 */
// @ts-nocheck
function stryNS_9fa48() {
  var g = typeof globalThis === 'object' && globalThis && globalThis.Math === Math && globalThis || new Function("return this")();
  var ns = g.__stryker__ || (g.__stryker__ = {});
  if (ns.activeMutant === undefined && g.process && g.process.env && g.process.env.__STRYKER_ACTIVE_MUTANT__) {
    ns.activeMutant = g.process.env.__STRYKER_ACTIVE_MUTANT__;
  }
  function retrieveNS() {
    return ns;
  }
  stryNS_9fa48 = retrieveNS;
  return retrieveNS();
}
stryNS_9fa48();
function stryCov_9fa48() {
  var ns = stryNS_9fa48();
  var cov = ns.mutantCoverage || (ns.mutantCoverage = {
    static: {},
    perTest: {}
  });
  function cover() {
    var c = cov.static;
    if (ns.currentTestId) {
      c = cov.perTest[ns.currentTestId] = cov.perTest[ns.currentTestId] || {};
    }
    var a = arguments;
    for (var i = 0; i < a.length; i++) {
      c[a[i]] = (c[a[i]] || 0) + 1;
    }
  }
  stryCov_9fa48 = cover;
  cover.apply(null, arguments);
}
function stryMutAct_9fa48(id) {
  var ns = stryNS_9fa48();
  function isActive(id) {
    if (ns.activeMutant === id) {
      if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit) {
        throw new Error('Stryker: Hit count limit reached (' + ns.hitCount + ')');
      }
      return true;
    }
    return false;
  }
  stryMutAct_9fa48 = isActive;
  return isActive(id);
}
import { git, pmap } from './git.mjs';
import { symbolKey } from './symbols.mjs';

/* ------------------------------------------------------------------ helpers ---- */

const setOf = stryMutAct_9fa48("0") ? () => undefined : (stryCov_9fa48("0"), (() => {
  const setOf = arr => new Set(arr);
  return setOf;
})());
function intersect(aSet, bArr) {
  if (stryMutAct_9fa48("1")) {
    {}
  } else {
    stryCov_9fa48("1");
    const out = stryMutAct_9fa48("2") ? ["Stryker was here"] : (stryCov_9fa48("2"), []);
    for (const x of bArr) if (stryMutAct_9fa48("4") ? false : stryMutAct_9fa48("3") ? true : (stryCov_9fa48("3", "4"), aSet.has(x))) out.push(x);
    return out;
  }
}

/**
 * DISCRIMINATIVE SYMBOLS — the filter that makes pair findings usable.
 *
 * MEASURED on a real 39-workstream repository: the unfiltered run reported 628 collisions and
 * 685 duplicate pairs. Nearly all of them were driven by symbols like `generatedAt`, `head`
 * and `$comment` — JSON metadata keys that appear in every receipt file in the repo. Every
 * workstream "shares" them with every other, so they generate a near-complete graph carrying
 * no information. 628 findings and 6 real ones are worse than useless: the real ones are
 * unreachable.
 *
 * The fix is inverse document frequency, not a blocklist. A symbol present in many workstreams
 * is boilerplate BY DEFINITION — no list of known-bad names is needed, and none has to be
 * maintained as new frameworks invent new metadata keys. This generalises to repos we have
 * never seen, which a curated list never would.
 *
 * Threshold: a symbol carried by more than 25% of live workstreams (minimum 3) is boilerplate.
 * Deliberately generous — with 4 workstreams nothing is filtered unless all but one share it.
 *
 * This filters the EVIDENCE for pair findings only. Per-workstream `added` lists keep every
 * symbol, because "what did this workstream contribute" is a different question from "what do
 * these two have in common".
 */
export function discriminativeSymbols(live, {
  maxShareRatio = 0.25,
  floor = 3
} = {}) {
  if (stryMutAct_9fa48("5")) {
    {}
  } else {
    stryCov_9fa48("5");
    const owners = new Map();
    for (const w of live) {
      if (stryMutAct_9fa48("6")) {
        {}
      } else {
        stryCov_9fa48("6");
        for (const k of stryMutAct_9fa48("7") ? w.addedKeys && [] : (stryCov_9fa48("7"), w.addedKeys ?? (stryMutAct_9fa48("8") ? ["Stryker was here"] : (stryCov_9fa48("8"), [])))) owners.set(k, stryMutAct_9fa48("9") ? (owners.get(k) ?? 0) - 1 : (stryCov_9fa48("9"), (stryMutAct_9fa48("10") ? owners.get(k) && 0 : (stryCov_9fa48("10"), owners.get(k) ?? 0)) + 1));
      }
    }
    const limit = stryMutAct_9fa48("11") ? Math.min(floor, Math.ceil(live.length * maxShareRatio)) : (stryCov_9fa48("11"), Math.max(floor, Math.ceil(stryMutAct_9fa48("12") ? live.length / maxShareRatio : (stryCov_9fa48("12"), live.length * maxShareRatio))));
    const keep = new Set();
    const dropped = stryMutAct_9fa48("13") ? ["Stryker was here"] : (stryCov_9fa48("13"), []);
    for (const [k, n] of owners) {
      if (stryMutAct_9fa48("14")) {
        {}
      } else {
        stryCov_9fa48("14");
        if (stryMutAct_9fa48("18") ? n > limit : stryMutAct_9fa48("17") ? n < limit : stryMutAct_9fa48("16") ? false : stryMutAct_9fa48("15") ? true : (stryCov_9fa48("15", "16", "17", "18"), n <= limit)) keep.add(k);else dropped.push(stryMutAct_9fa48("19") ? {} : (stryCov_9fa48("19"), {
          symbol: k,
          workstreams: n
        }));
      }
    }
    stryMutAct_9fa48("20") ? dropped : (stryCov_9fa48("20"), dropped.sort(stryMutAct_9fa48("21") ? () => undefined : (stryCov_9fa48("21"), (a, b) => stryMutAct_9fa48("22") ? b.workstreams + a.workstreams : (stryCov_9fa48("22"), b.workstreams - a.workstreams))));
    return stryMutAct_9fa48("23") ? {} : (stryCov_9fa48("23"), {
      keep,
      dropped,
      limit
    });
  }
}

/** A workstream's added keys, restricted to the discriminative ones. */
function discriminativeKeys(w, keep) {
  if (stryMutAct_9fa48("24")) {
    {}
  } else {
    stryCov_9fa48("24");
    return stryMutAct_9fa48("25") ? w.addedKeys ?? [] : (stryCov_9fa48("25"), (stryMutAct_9fa48("26") ? w.addedKeys && [] : (stryCov_9fa48("26"), w.addedKeys ?? (stryMutAct_9fa48("27") ? ["Stryker was here"] : (stryCov_9fa48("27"), [])))).filter(stryMutAct_9fa48("28") ? () => undefined : (stryCov_9fa48("28"), k => keep.has(k))));
  }
}

/** Pairs of workstreams that share at least one touched file. The collision prefilter. */
export function overlappingPairs(workstreams) {
  if (stryMutAct_9fa48("29")) {
    {}
  } else {
    stryCov_9fa48("29");
    // Invert to file -> [workstream index], so we never do the full O(n^2) comparison.
    const byFile = new Map();
    workstreams.forEach((w, i) => {
      if (stryMutAct_9fa48("30")) {
        {}
      } else {
        stryCov_9fa48("30");
        for (const f of stryMutAct_9fa48("31") ? w.touched && [] : (stryCov_9fa48("31"), w.touched ?? (stryMutAct_9fa48("32") ? ["Stryker was here"] : (stryCov_9fa48("32"), [])))) {
          if (stryMutAct_9fa48("33")) {
            {}
          } else {
            stryCov_9fa48("33");
            if (stryMutAct_9fa48("36") ? false : stryMutAct_9fa48("35") ? true : stryMutAct_9fa48("34") ? byFile.has(f) : (stryCov_9fa48("34", "35", "36"), !byFile.has(f))) byFile.set(f, stryMutAct_9fa48("37") ? ["Stryker was here"] : (stryCov_9fa48("37"), []));
            byFile.get(f).push(i);
          }
        }
      }
    });
    const pairKey = stryMutAct_9fa48("38") ? () => undefined : (stryCov_9fa48("38"), (() => {
      const pairKey = (i, j) => (stryMutAct_9fa48("42") ? i >= j : stryMutAct_9fa48("41") ? i <= j : stryMutAct_9fa48("40") ? false : stryMutAct_9fa48("39") ? true : (stryCov_9fa48("39", "40", "41", "42"), i < j)) ? stryMutAct_9fa48("43") ? `` : (stryCov_9fa48("43"), `${i}:${j}`) : stryMutAct_9fa48("44") ? `` : (stryCov_9fa48("44"), `${j}:${i}`);
      return pairKey;
    })());
    const pairs = new Map();
    for (const [file, idxs] of byFile) {
      if (stryMutAct_9fa48("45")) {
        {}
      } else {
        stryCov_9fa48("45");
        if (stryMutAct_9fa48("49") ? idxs.length >= 2 : stryMutAct_9fa48("48") ? idxs.length <= 2 : stryMutAct_9fa48("47") ? false : stryMutAct_9fa48("46") ? true : (stryCov_9fa48("46", "47", "48", "49"), idxs.length < 2)) continue;
        for (let a = 0; stryMutAct_9fa48("52") ? a >= idxs.length : stryMutAct_9fa48("51") ? a <= idxs.length : stryMutAct_9fa48("50") ? false : (stryCov_9fa48("50", "51", "52"), a < idxs.length); stryMutAct_9fa48("53") ? a-- : (stryCov_9fa48("53"), a++)) {
          if (stryMutAct_9fa48("54")) {
            {}
          } else {
            stryCov_9fa48("54");
            for (let b = stryMutAct_9fa48("55") ? a - 1 : (stryCov_9fa48("55"), a + 1); stryMutAct_9fa48("58") ? b >= idxs.length : stryMutAct_9fa48("57") ? b <= idxs.length : stryMutAct_9fa48("56") ? false : (stryCov_9fa48("56", "57", "58"), b < idxs.length); stryMutAct_9fa48("59") ? b-- : (stryCov_9fa48("59"), b++)) {
              if (stryMutAct_9fa48("60")) {
                {}
              } else {
                stryCov_9fa48("60");
                const k = pairKey(idxs[a], idxs[b]);
                if (stryMutAct_9fa48("63") ? false : stryMutAct_9fa48("62") ? true : stryMutAct_9fa48("61") ? pairs.has(k) : (stryCov_9fa48("61", "62", "63"), !pairs.has(k))) pairs.set(k, stryMutAct_9fa48("64") ? {} : (stryCov_9fa48("64"), {
                  i: stryMutAct_9fa48("65") ? Math.max(idxs[a], idxs[b]) : (stryCov_9fa48("65"), Math.min(idxs[a], idxs[b])),
                  j: stryMutAct_9fa48("66") ? Math.min(idxs[a], idxs[b]) : (stryCov_9fa48("66"), Math.max(idxs[a], idxs[b])),
                  files: stryMutAct_9fa48("67") ? ["Stryker was here"] : (stryCov_9fa48("67"), [])
                }));
                pairs.get(k).files.push(file);
              }
            }
          }
        }
      }
    }
    return stryMutAct_9fa48("68") ? [] : (stryCov_9fa48("68"), [...pairs.values()]);
  }
}

/* ------------------------------------------------------ P0: unique work ---- */

/**
 * What would be LOST if this workstream vanished?
 *
 * A symbol is unique to W when no other workstream added it and base does not have it.
 * (Base-absence is already guaranteed: `added` is computed as head-minus-base.)
 *
 * This is the finding that justified the tool. In the reference repo the committed layer
 * flagged 4 worktrees; the uncommitted layer held 52 registry keys absent from base. Both
 * layers feed this function, which is the entire point.
 */
export function uniqueWork(scanResult) {
  if (stryMutAct_9fa48("69")) {
    {}
  } else {
    stryCov_9fa48("69");
    const live = stryMutAct_9fa48("70") ? scanResult.workstreams : (stryCov_9fa48("70"), scanResult.workstreams.filter(stryMutAct_9fa48("71") ? () => undefined : (stryCov_9fa48("71"), w => w.ok)));
    const symbolOwners = new Map(); // symbolKey -> [workstream id]
    for (const w of live) {
      if (stryMutAct_9fa48("72")) {
        {}
      } else {
        stryCov_9fa48("72");
        for (const k of stryMutAct_9fa48("73") ? w.addedKeys && [] : (stryCov_9fa48("73"), w.addedKeys ?? (stryMutAct_9fa48("74") ? ["Stryker was here"] : (stryCov_9fa48("74"), [])))) {
          if (stryMutAct_9fa48("75")) {
            {}
          } else {
            stryCov_9fa48("75");
            if (stryMutAct_9fa48("78") ? false : stryMutAct_9fa48("77") ? true : stryMutAct_9fa48("76") ? symbolOwners.has(k) : (stryCov_9fa48("76", "77", "78"), !symbolOwners.has(k))) symbolOwners.set(k, stryMutAct_9fa48("79") ? ["Stryker was here"] : (stryCov_9fa48("79"), []));
            symbolOwners.get(k).push(w.id);
          }
        }
      }
    }
    return stryMutAct_9fa48("80") ? live.map(w => {
      const uniqueSymbols = (w.addedKeys ?? []).filter(k => symbolOwners.get(k).length === 1);
      const byLayer = {
        committed: [],
        uncommitted: [],
        untracked: []
      };
      const uniqueSet = setOf(uniqueSymbols);
      for (const s of w.added ?? []) {
        if (!uniqueSet.has(symbolKey(s))) continue;
        const layer = w.committed.files.includes(s.file) ? 'committed' : w.uncommitted.untracked.includes(s.file) ? 'untracked' : 'uncommitted';
        byLayer[layer].push({
          ...s,
          key: symbolKey(s)
        });
      }

      // Work that only exists uncommitted is the highest-risk class: git itself cannot
      // relate it, so nothing else in the user's toolchain will warn before it is deleted.
      const atRisk = byLayer.uncommitted.length + byLayer.untracked.length;
      return {
        id: w.id,
        path: w.path,
        family: w.family,
        uniqueSymbolCount: uniqueSymbols.length,
        uniqueSymbols,
        byLayer,
        uncommittedOnlyCount: atRisk,
        committedFiles: w.committed.count,
        verdict: atRisk > 0 ? 'unique-work-uncommitted' : uniqueSymbols.length > 0 ? 'unique-work-committed' : w.committed.count > 0 ? 'committed-delta-no-unique-symbols' : 'nothing-unique'
      };
    }) : (stryCov_9fa48("80"), live.map(w => {
      if (stryMutAct_9fa48("81")) {
        {}
      } else {
        stryCov_9fa48("81");
        const uniqueSymbols = stryMutAct_9fa48("82") ? w.addedKeys ?? [] : (stryCov_9fa48("82"), (stryMutAct_9fa48("83") ? w.addedKeys && [] : (stryCov_9fa48("83"), w.addedKeys ?? (stryMutAct_9fa48("84") ? ["Stryker was here"] : (stryCov_9fa48("84"), [])))).filter(stryMutAct_9fa48("85") ? () => undefined : (stryCov_9fa48("85"), k => stryMutAct_9fa48("88") ? symbolOwners.get(k).length !== 1 : stryMutAct_9fa48("87") ? false : stryMutAct_9fa48("86") ? true : (stryCov_9fa48("86", "87", "88"), symbolOwners.get(k).length === 1))));
        const byLayer = stryMutAct_9fa48("89") ? {} : (stryCov_9fa48("89"), {
          committed: stryMutAct_9fa48("90") ? ["Stryker was here"] : (stryCov_9fa48("90"), []),
          uncommitted: stryMutAct_9fa48("91") ? ["Stryker was here"] : (stryCov_9fa48("91"), []),
          untracked: stryMutAct_9fa48("92") ? ["Stryker was here"] : (stryCov_9fa48("92"), [])
        });
        const uniqueSet = setOf(uniqueSymbols);
        for (const s of stryMutAct_9fa48("93") ? w.added && [] : (stryCov_9fa48("93"), w.added ?? (stryMutAct_9fa48("94") ? ["Stryker was here"] : (stryCov_9fa48("94"), [])))) {
          if (stryMutAct_9fa48("95")) {
            {}
          } else {
            stryCov_9fa48("95");
            if (stryMutAct_9fa48("98") ? false : stryMutAct_9fa48("97") ? true : stryMutAct_9fa48("96") ? uniqueSet.has(symbolKey(s)) : (stryCov_9fa48("96", "97", "98"), !uniqueSet.has(symbolKey(s)))) continue;
            const layer = w.committed.files.includes(s.file) ? stryMutAct_9fa48("99") ? "" : (stryCov_9fa48("99"), 'committed') : w.uncommitted.untracked.includes(s.file) ? stryMutAct_9fa48("100") ? "" : (stryCov_9fa48("100"), 'untracked') : stryMutAct_9fa48("101") ? "" : (stryCov_9fa48("101"), 'uncommitted');
            byLayer[layer].push(stryMutAct_9fa48("102") ? {} : (stryCov_9fa48("102"), {
              ...s,
              key: symbolKey(s)
            }));
          }
        }

        // Work that only exists uncommitted is the highest-risk class: git itself cannot
        // relate it, so nothing else in the user's toolchain will warn before it is deleted.
        const atRisk = stryMutAct_9fa48("103") ? byLayer.uncommitted.length - byLayer.untracked.length : (stryCov_9fa48("103"), byLayer.uncommitted.length + byLayer.untracked.length);
        return stryMutAct_9fa48("104") ? {} : (stryCov_9fa48("104"), {
          id: w.id,
          path: w.path,
          family: w.family,
          uniqueSymbolCount: uniqueSymbols.length,
          uniqueSymbols,
          byLayer,
          uncommittedOnlyCount: atRisk,
          committedFiles: w.committed.count,
          verdict: (stryMutAct_9fa48("108") ? atRisk <= 0 : stryMutAct_9fa48("107") ? atRisk >= 0 : stryMutAct_9fa48("106") ? false : stryMutAct_9fa48("105") ? true : (stryCov_9fa48("105", "106", "107", "108"), atRisk > 0)) ? stryMutAct_9fa48("109") ? "" : (stryCov_9fa48("109"), 'unique-work-uncommitted') : (stryMutAct_9fa48("113") ? uniqueSymbols.length <= 0 : stryMutAct_9fa48("112") ? uniqueSymbols.length >= 0 : stryMutAct_9fa48("111") ? false : stryMutAct_9fa48("110") ? true : (stryCov_9fa48("110", "111", "112", "113"), uniqueSymbols.length > 0)) ? stryMutAct_9fa48("114") ? "" : (stryCov_9fa48("114"), 'unique-work-committed') : (stryMutAct_9fa48("118") ? w.committed.count <= 0 : stryMutAct_9fa48("117") ? w.committed.count >= 0 : stryMutAct_9fa48("116") ? false : stryMutAct_9fa48("115") ? true : (stryCov_9fa48("115", "116", "117", "118"), w.committed.count > 0)) ? stryMutAct_9fa48("119") ? "" : (stryCov_9fa48("119"), 'committed-delta-no-unique-symbols') : stryMutAct_9fa48("120") ? "" : (stryCov_9fa48("120"), 'nothing-unique')
        });
      }
    }).sort(stryMutAct_9fa48("121") ? () => undefined : (stryCov_9fa48("121"), (a, b) => stryMutAct_9fa48("124") ? b.uncommittedOnlyCount - a.uncommittedOnlyCount && b.uniqueSymbolCount - a.uniqueSymbolCount : stryMutAct_9fa48("123") ? false : stryMutAct_9fa48("122") ? true : (stryCov_9fa48("122", "123", "124"), (stryMutAct_9fa48("125") ? b.uncommittedOnlyCount + a.uncommittedOnlyCount : (stryCov_9fa48("125"), b.uncommittedOnlyCount - a.uncommittedOnlyCount)) || (stryMutAct_9fa48("126") ? b.uniqueSymbolCount + a.uniqueSymbolCount : (stryCov_9fa48("126"), b.uniqueSymbolCount - a.uniqueSymbolCount))))));
  }
}

/* ------------------------------------------------- P6: safe to delete ---- */

/**
 * Provably disposable: nothing committed that base lacks, nothing uncommitted, nothing unique.
 *
 * FAIL-CLOSED BY CONSTRUCTION. Any workstream grove could not fully scan is reported as
 * 'unknown', never as safe. Absence of evidence must produce a refusal, not a green light —
 * a cleanup tool that says "safe" because it failed to look is the worst possible defect.
 */
export function safeToDelete(scanResult, unique = null) {
  if (stryMutAct_9fa48("127")) {
    {}
  } else {
    stryCov_9fa48("127");
    const uniq = stryMutAct_9fa48("128") ? unique && uniqueWork(scanResult) : (stryCov_9fa48("128"), unique ?? uniqueWork(scanResult));
    const uniqById = new Map(uniq.map(stryMutAct_9fa48("129") ? () => undefined : (stryCov_9fa48("129"), u => stryMutAct_9fa48("130") ? [] : (stryCov_9fa48("130"), [u.id, u]))));
    return stryMutAct_9fa48("131") ? scanResult.workstreams.map(w => {
      if (!w.ok) {
        return {
          id: w.id,
          path: w.path,
          safe: false,
          confidence: 'unknown',
          reasons: [w.reason ?? 'not scanned']
        };
      }
      const u = uniqById.get(w.id);
      const reasons = [];
      if (w.committed.count > 0) reasons.push(`${w.committed.count} file(s) base lacks`);
      if (w.uncommitted.count > 0) reasons.push(`${w.uncommitted.count} uncommitted file(s)`);
      if (u && u.uniqueSymbolCount > 0) reasons.push(`${u.uniqueSymbolCount} symbol(s) found nowhere else`);
      if (w.locked) reasons.push(`locked${w.lockReason ? `: ${w.lockReason}` : ''}`);
      return {
        id: w.id,
        path: w.path,
        family: w.family,
        safe: reasons.length === 0,
        confidence: scanResult.strictReadOnly ? 'approximate' : 'measured',
        reasons: reasons.length ? reasons : ['no committed delta, no uncommitted changes, no unique symbols']
      };
    }) : (stryCov_9fa48("131"), scanResult.workstreams.map(w => {
      if (stryMutAct_9fa48("132")) {
        {}
      } else {
        stryCov_9fa48("132");
        if (stryMutAct_9fa48("135") ? false : stryMutAct_9fa48("134") ? true : stryMutAct_9fa48("133") ? w.ok : (stryCov_9fa48("133", "134", "135"), !w.ok)) {
          if (stryMutAct_9fa48("136")) {
            {}
          } else {
            stryCov_9fa48("136");
            return stryMutAct_9fa48("137") ? {} : (stryCov_9fa48("137"), {
              id: w.id,
              path: w.path,
              safe: stryMutAct_9fa48("138") ? true : (stryCov_9fa48("138"), false),
              confidence: stryMutAct_9fa48("139") ? "" : (stryCov_9fa48("139"), 'unknown'),
              reasons: stryMutAct_9fa48("140") ? [] : (stryCov_9fa48("140"), [stryMutAct_9fa48("141") ? w.reason && 'not scanned' : (stryCov_9fa48("141"), w.reason ?? (stryMutAct_9fa48("142") ? "" : (stryCov_9fa48("142"), 'not scanned')))])
            });
          }
        }
        const u = uniqById.get(w.id);
        const reasons = stryMutAct_9fa48("143") ? ["Stryker was here"] : (stryCov_9fa48("143"), []);
        if (stryMutAct_9fa48("147") ? w.committed.count <= 0 : stryMutAct_9fa48("146") ? w.committed.count >= 0 : stryMutAct_9fa48("145") ? false : stryMutAct_9fa48("144") ? true : (stryCov_9fa48("144", "145", "146", "147"), w.committed.count > 0)) reasons.push(stryMutAct_9fa48("148") ? `` : (stryCov_9fa48("148"), `${w.committed.count} file(s) base lacks`));
        if (stryMutAct_9fa48("152") ? w.uncommitted.count <= 0 : stryMutAct_9fa48("151") ? w.uncommitted.count >= 0 : stryMutAct_9fa48("150") ? false : stryMutAct_9fa48("149") ? true : (stryCov_9fa48("149", "150", "151", "152"), w.uncommitted.count > 0)) reasons.push(stryMutAct_9fa48("153") ? `` : (stryCov_9fa48("153"), `${w.uncommitted.count} uncommitted file(s)`));
        if (stryMutAct_9fa48("156") ? u || u.uniqueSymbolCount > 0 : stryMutAct_9fa48("155") ? false : stryMutAct_9fa48("154") ? true : (stryCov_9fa48("154", "155", "156"), u && (stryMutAct_9fa48("159") ? u.uniqueSymbolCount <= 0 : stryMutAct_9fa48("158") ? u.uniqueSymbolCount >= 0 : stryMutAct_9fa48("157") ? true : (stryCov_9fa48("157", "158", "159"), u.uniqueSymbolCount > 0)))) reasons.push(stryMutAct_9fa48("160") ? `` : (stryCov_9fa48("160"), `${u.uniqueSymbolCount} symbol(s) found nowhere else`));
        if (stryMutAct_9fa48("162") ? false : stryMutAct_9fa48("161") ? true : (stryCov_9fa48("161", "162"), w.locked)) reasons.push(stryMutAct_9fa48("163") ? `` : (stryCov_9fa48("163"), `locked${w.lockReason ? stryMutAct_9fa48("164") ? `` : (stryCov_9fa48("164"), `: ${w.lockReason}`) : stryMutAct_9fa48("165") ? "Stryker was here!" : (stryCov_9fa48("165"), '')}`));
        return stryMutAct_9fa48("166") ? {} : (stryCov_9fa48("166"), {
          id: w.id,
          path: w.path,
          family: w.family,
          safe: stryMutAct_9fa48("169") ? reasons.length !== 0 : stryMutAct_9fa48("168") ? false : stryMutAct_9fa48("167") ? true : (stryCov_9fa48("167", "168", "169"), reasons.length === 0),
          confidence: scanResult.strictReadOnly ? stryMutAct_9fa48("170") ? "" : (stryCov_9fa48("170"), 'approximate') : stryMutAct_9fa48("171") ? "" : (stryCov_9fa48("171"), 'measured'),
          reasons: reasons.length ? reasons : stryMutAct_9fa48("172") ? [] : (stryCov_9fa48("172"), [stryMutAct_9fa48("173") ? "" : (stryCov_9fa48("173"), 'no committed delta, no uncommitted changes, no unique symbols')])
        });
      }
    }).sort(stryMutAct_9fa48("174") ? () => undefined : (stryCov_9fa48("174"), (a, b) => stryMutAct_9fa48("175") ? Number(b.safe) + Number(a.safe) : (stryCov_9fa48("175"), Number(b.safe) - Number(a.safe)))));
  }
}

/* ------------------------------------------------------- P1: collisions ---- */

/**
 * Pairs that will fight.
 *
 * Two tiers, and the distinction is reported rather than blurred:
 *
 *   PROVEN    — both sides have committed content and `merge-tree` reports a real conflict.
 *               This is git's own answer, not a heuristic.
 *   PREDICTED — the sides share a file but at least one side's changes are uncommitted, so
 *               merge-tree cannot see them. Confidence is raised when both sides added the
 *               SAME symbol, which is the registry-hotspot signature.
 *
 * We never call a predicted collision proven. The literature names "shared hotspot files
 * (routes, configs, registries)" as the top collision class, and those live overwhelmingly in
 * the uncommitted layer while an agent is still working — precisely where proof is impossible.
 */
export async function collisions(scanResult, opts = {}) {
  if (stryMutAct_9fa48("176")) {
    {}
  } else {
    stryCov_9fa48("176");
    const {
      concurrency = 6,
      timeout = 60_000
    } = opts;
    const live = stryMutAct_9fa48("177") ? scanResult.workstreams : (stryCov_9fa48("177"), scanResult.workstreams.filter(stryMutAct_9fa48("178") ? () => undefined : (stryCov_9fa48("178"), w => w.ok)));
    const pairs = overlappingPairs(live);
    const {
      keep
    } = discriminativeSymbols(live);
    const results = await pmap(pairs, async p => {
      if (stryMutAct_9fa48("179")) {
        {}
      } else {
        stryCov_9fa48("179");
        const a = live[p.i];
        const b = live[p.j];
        const aKeys = setOf(discriminativeKeys(a, keep));
        const sharedSymbols = intersect(aKeys, discriminativeKeys(b, keep));

        // Can merge-tree see both sides? Only if both have committed content that base lacks.
        const bothCommitted = stryMutAct_9fa48("182") ? a.committed.count > 0 || b.committed.count > 0 : stryMutAct_9fa48("181") ? false : stryMutAct_9fa48("180") ? true : (stryCov_9fa48("180", "181", "182"), (stryMutAct_9fa48("185") ? a.committed.count <= 0 : stryMutAct_9fa48("184") ? a.committed.count >= 0 : stryMutAct_9fa48("183") ? true : (stryCov_9fa48("183", "184", "185"), a.committed.count > 0)) && (stryMutAct_9fa48("188") ? b.committed.count <= 0 : stryMutAct_9fa48("187") ? b.committed.count >= 0 : stryMutAct_9fa48("186") ? true : (stryCov_9fa48("186", "187", "188"), b.committed.count > 0)));
        let proven = null;
        if (stryMutAct_9fa48("191") ? bothCommitted && !scanResult.strictReadOnly && a.head || b.head : stryMutAct_9fa48("190") ? false : stryMutAct_9fa48("189") ? true : (stryCov_9fa48("189", "190", "191"), (stryMutAct_9fa48("193") ? bothCommitted && !scanResult.strictReadOnly || a.head : stryMutAct_9fa48("192") ? true : (stryCov_9fa48("192", "193"), (stryMutAct_9fa48("195") ? bothCommitted || !scanResult.strictReadOnly : stryMutAct_9fa48("194") ? true : (stryCov_9fa48("194", "195"), bothCommitted && (stryMutAct_9fa48("196") ? scanResult.strictReadOnly : (stryCov_9fa48("196"), !scanResult.strictReadOnly)))) && a.head)) && b.head)) {
          if (stryMutAct_9fa48("197")) {
            {}
          } else {
            stryCov_9fa48("197");
            const mt = await git(stryMutAct_9fa48("198") ? [] : (stryCov_9fa48("198"), [stryMutAct_9fa48("199") ? "" : (stryCov_9fa48("199"), 'merge-tree'), stryMutAct_9fa48("200") ? "" : (stryCov_9fa48("200"), '--write-tree'), a.head, b.head]), stryMutAct_9fa48("201") ? {} : (stryCov_9fa48("201"), {
              cwd: scanResult.root,
              timeout
            }));
            if (stryMutAct_9fa48("205") ? mt.code > 1 : stryMutAct_9fa48("204") ? mt.code < 1 : stryMutAct_9fa48("203") ? false : stryMutAct_9fa48("202") ? true : (stryCov_9fa48("202", "203", "204", "205"), mt.code <= 1)) proven = stryMutAct_9fa48("208") ? mt.code !== 1 : stryMutAct_9fa48("207") ? false : stryMutAct_9fa48("206") ? true : (stryCov_9fa48("206", "207", "208"), mt.code === 1);
          }
        }
        const uncommittedInvolved = stryMutAct_9fa48("211") ? a.uncommitted.count > 0 && b.uncommitted.count > 0 : stryMutAct_9fa48("210") ? false : stryMutAct_9fa48("209") ? true : (stryCov_9fa48("209", "210", "211"), (stryMutAct_9fa48("214") ? a.uncommitted.count <= 0 : stryMutAct_9fa48("213") ? a.uncommitted.count >= 0 : stryMutAct_9fa48("212") ? false : (stryCov_9fa48("212", "213", "214"), a.uncommitted.count > 0)) || (stryMutAct_9fa48("217") ? b.uncommitted.count <= 0 : stryMutAct_9fa48("216") ? b.uncommitted.count >= 0 : stryMutAct_9fa48("215") ? false : (stryCov_9fa48("215", "216", "217"), b.uncommitted.count > 0)));

        // A COLLISION REQUIRES EVIDENCE, NOT CO-LOCATION.
        //
        // Measured on a real 39-worktree repository: treating "shares a file and someone has
        // uncommitted changes" as a medium collision produced 616 findings, 313 of them with no
        // evidence beyond both sides having touched the same hot file. In a repo where 491 pairs
        // all touch scripts/armed-config.mjs, that is a near-complete graph. 616 findings with 6
        // real ones is strictly worse than 6, because the real ones become unreachable.
        //
        // Evidence is: git proved a conflict, OR both sides added the same discriminative symbol.
        // Bare file overlap is downgraded to 'low' and excluded from the default report — still
        // available via --all, because it is not nothing, it is just not actionable on its own.
        let severity;
        let kind;
        if (stryMutAct_9fa48("220") ? proven !== true : stryMutAct_9fa48("219") ? false : stryMutAct_9fa48("218") ? true : (stryCov_9fa48("218", "219", "220"), proven === (stryMutAct_9fa48("221") ? false : (stryCov_9fa48("221"), true)))) {
          if (stryMutAct_9fa48("222")) {
            {}
          } else {
            stryCov_9fa48("222");
            kind = stryMutAct_9fa48("223") ? "" : (stryCov_9fa48("223"), 'proven');
            severity = stryMutAct_9fa48("224") ? "" : (stryCov_9fa48("224"), 'high');
          }
        } else if (stryMutAct_9fa48("228") ? sharedSymbols.length <= 0 : stryMutAct_9fa48("227") ? sharedSymbols.length >= 0 : stryMutAct_9fa48("226") ? false : stryMutAct_9fa48("225") ? true : (stryCov_9fa48("225", "226", "227", "228"), sharedSymbols.length > 0)) {
          if (stryMutAct_9fa48("229")) {
            {}
          } else {
            stryCov_9fa48("229");
            kind = stryMutAct_9fa48("230") ? "" : (stryCov_9fa48("230"), 'predicted');
            severity = uncommittedInvolved ? stryMutAct_9fa48("231") ? "" : (stryCov_9fa48("231"), 'high') : stryMutAct_9fa48("232") ? "" : (stryCov_9fa48("232"), 'medium');
          }
        } else if (stryMutAct_9fa48("235") ? proven !== false : stryMutAct_9fa48("234") ? false : stryMutAct_9fa48("233") ? true : (stryCov_9fa48("233", "234", "235"), proven === (stryMutAct_9fa48("236") ? true : (stryCov_9fa48("236"), false)))) {
          if (stryMutAct_9fa48("237")) {
            {}
          } else {
            stryCov_9fa48("237");
            kind = stryMutAct_9fa48("238") ? "" : (stryCov_9fa48("238"), 'proven-clean');
            severity = stryMutAct_9fa48("239") ? "" : (stryCov_9fa48("239"), 'none');
          }
        } else {
          if (stryMutAct_9fa48("240")) {
            {}
          } else {
            stryCov_9fa48("240");
            kind = stryMutAct_9fa48("241") ? "" : (stryCov_9fa48("241"), 'co-located');
            severity = stryMutAct_9fa48("242") ? "" : (stryCov_9fa48("242"), 'low');
          }
        }
        return stryMutAct_9fa48("243") ? {} : (stryCov_9fa48("243"), {
          a: a.id,
          b: b.id,
          aPath: a.path,
          bPath: b.path,
          sameFamily: stryMutAct_9fa48("246") ? a.family !== b.family : stryMutAct_9fa48("245") ? false : stryMutAct_9fa48("244") ? true : (stryCov_9fa48("244", "245", "246"), a.family === b.family),
          sharedFiles: stryMutAct_9fa48("247") ? p.files : (stryCov_9fa48("247"), p.files.sort()),
          sharedFileCount: p.files.length,
          sharedSymbols,
          kind,
          severity,
          mergeTreeConflict: proven,
          why: (stryMutAct_9fa48("250") ? proven !== true : stryMutAct_9fa48("249") ? false : stryMutAct_9fa48("248") ? true : (stryCov_9fa48("248", "249", "250"), proven === (stryMutAct_9fa48("251") ? false : (stryCov_9fa48("251"), true)))) ? stryMutAct_9fa48("252") ? "" : (stryCov_9fa48("252"), 'git merge-tree reports a real conflict between these two heads') : (stryMutAct_9fa48("256") ? sharedSymbols.length <= 0 : stryMutAct_9fa48("255") ? sharedSymbols.length >= 0 : stryMutAct_9fa48("254") ? false : stryMutAct_9fa48("253") ? true : (stryCov_9fa48("253", "254", "255", "256"), sharedSymbols.length > 0)) ? (stryMutAct_9fa48("257") ? `` : (stryCov_9fa48("257"), `both added the same symbol(s): ${stryMutAct_9fa48("258") ? sharedSymbols.join(', ') : (stryCov_9fa48("258"), sharedSymbols.slice(0, 3).join(stryMutAct_9fa48("259") ? "" : (stryCov_9fa48("259"), ', ')))}${(stryMutAct_9fa48("263") ? sharedSymbols.length <= 3 : stryMutAct_9fa48("262") ? sharedSymbols.length >= 3 : stryMutAct_9fa48("261") ? false : stryMutAct_9fa48("260") ? true : (stryCov_9fa48("260", "261", "262", "263"), sharedSymbols.length > 3)) ? stryMutAct_9fa48("264") ? "" : (stryCov_9fa48("264"), '…') : stryMutAct_9fa48("265") ? "Stryker was here!" : (stryCov_9fa48("265"), '')}`)) + (uncommittedInvolved ? stryMutAct_9fa48("266") ? "" : (stryCov_9fa48("266"), ' — and at least one side is uncommitted, so merge-tree cannot confirm it') : stryMutAct_9fa48("267") ? "Stryker was here!" : (stryCov_9fa48("267"), '')) : stryMutAct_9fa48("268") ? `` : (stryCov_9fa48("268"), `co-located in ${p.files.length} shared file(s), no symbol-level overlap`)
        });
      }
    }, concurrency);
    const order = stryMutAct_9fa48("269") ? {} : (stryCov_9fa48("269"), {
      high: 0,
      medium: 1,
      low: 2,
      none: 3
    });
    const keepLow = stryMutAct_9fa48("272") ? opts.includeCoLocated !== true : stryMutAct_9fa48("271") ? false : stryMutAct_9fa48("270") ? true : (stryCov_9fa48("270", "271", "272"), opts.includeCoLocated === (stryMutAct_9fa48("273") ? false : (stryCov_9fa48("273"), true)));
    return stryMutAct_9fa48("276") ? results.filter(r => keepLow || r.severity !== 'low').sort((x, y) => order[x.severity] - order[y.severity] || y.sharedSymbols.length - x.sharedSymbols.length) : stryMutAct_9fa48("275") ? results.filter(r => r.severity !== 'none').sort((x, y) => order[x.severity] - order[y.severity] || y.sharedSymbols.length - x.sharedSymbols.length) : stryMutAct_9fa48("274") ? results.filter(r => r.severity !== 'none').filter(r => keepLow || r.severity !== 'low') : (stryCov_9fa48("274", "275", "276"), results.filter(stryMutAct_9fa48("277") ? () => undefined : (stryCov_9fa48("277"), r => stryMutAct_9fa48("280") ? r.severity === 'none' : stryMutAct_9fa48("279") ? false : stryMutAct_9fa48("278") ? true : (stryCov_9fa48("278", "279", "280"), r.severity !== (stryMutAct_9fa48("281") ? "" : (stryCov_9fa48("281"), 'none'))))).filter(stryMutAct_9fa48("282") ? () => undefined : (stryCov_9fa48("282"), r => stryMutAct_9fa48("285") ? keepLow && r.severity !== 'low' : stryMutAct_9fa48("284") ? false : stryMutAct_9fa48("283") ? true : (stryCov_9fa48("283", "284", "285"), keepLow || (stryMutAct_9fa48("287") ? r.severity === 'low' : stryMutAct_9fa48("286") ? false : (stryCov_9fa48("286", "287"), r.severity !== (stryMutAct_9fa48("288") ? "" : (stryCov_9fa48("288"), 'low'))))))).sort(stryMutAct_9fa48("289") ? () => undefined : (stryCov_9fa48("289"), (x, y) => stryMutAct_9fa48("292") ? order[x.severity] - order[y.severity] && y.sharedSymbols.length - x.sharedSymbols.length : stryMutAct_9fa48("291") ? false : stryMutAct_9fa48("290") ? true : (stryCov_9fa48("290", "291", "292"), (stryMutAct_9fa48("293") ? order[x.severity] + order[y.severity] : (stryCov_9fa48("293"), order[x.severity] - order[y.severity])) || (stryMutAct_9fa48("294") ? y.sharedSymbols.length + x.sharedSymbols.length : (stryCov_9fa48("294"), y.sharedSymbols.length - x.sharedSymbols.length))))));
  }
}

/* -------------------------------------------------------- P3: duplicates ---- */

/**
 * Two workstreams that built the same thing.
 *
 * Cross-family duplication is waste — two independent dispatches solving one problem.
 * Same-family duplication is usually expected (a fan-out deliberately samples the same task
 * N times), so it is reported but ranked below cross-family.
 *
 * Symbol-identity is the cheap signal and it is exact. `grove duplicates --deep` additionally
 * runs jscpd (Rabin-Karp token clone detection, 150+ languages, Rust engine) to catch the
 * case symbol-identity misses: the same logic written twice under different names.
 */
export function duplicates(scanResult, {
  minShared = 1
} = {}) {
  if (stryMutAct_9fa48("295")) {
    {}
  } else {
    stryCov_9fa48("295");
    const all = stryMutAct_9fa48("296") ? scanResult.workstreams : (stryCov_9fa48("296"), scanResult.workstreams.filter(stryMutAct_9fa48("297") ? () => undefined : (stryCov_9fa48("297"), w => w.ok)));
    const {
      keep
    } = discriminativeSymbols(all);
    const live = stryMutAct_9fa48("298") ? all : (stryCov_9fa48("298"), all.filter(stryMutAct_9fa48("299") ? () => undefined : (stryCov_9fa48("299"), w => discriminativeKeys(w, keep).length)));
    const owners = new Map(); // symbolKey -> [index]
    live.forEach((w, i) => {
      if (stryMutAct_9fa48("300")) {
        {}
      } else {
        stryCov_9fa48("300");
        for (const k of discriminativeKeys(w, keep)) {
          if (stryMutAct_9fa48("301")) {
            {}
          } else {
            stryCov_9fa48("301");
            if (stryMutAct_9fa48("304") ? false : stryMutAct_9fa48("303") ? true : stryMutAct_9fa48("302") ? owners.has(k) : (stryCov_9fa48("302", "303", "304"), !owners.has(k))) owners.set(k, stryMutAct_9fa48("305") ? ["Stryker was here"] : (stryCov_9fa48("305"), []));
            owners.get(k).push(i);
          }
        }
      }
    });
    const pairKey = stryMutAct_9fa48("306") ? () => undefined : (stryCov_9fa48("306"), (() => {
      const pairKey = (i, j) => (stryMutAct_9fa48("310") ? i >= j : stryMutAct_9fa48("309") ? i <= j : stryMutAct_9fa48("308") ? false : stryMutAct_9fa48("307") ? true : (stryCov_9fa48("307", "308", "309", "310"), i < j)) ? stryMutAct_9fa48("311") ? `` : (stryCov_9fa48("311"), `${i}:${j}`) : stryMutAct_9fa48("312") ? `` : (stryCov_9fa48("312"), `${j}:${i}`);
      return pairKey;
    })());
    const pairs = new Map();
    for (const [key, idxs] of owners) {
      if (stryMutAct_9fa48("313")) {
        {}
      } else {
        stryCov_9fa48("313");
        if (stryMutAct_9fa48("317") ? idxs.length >= 2 : stryMutAct_9fa48("316") ? idxs.length <= 2 : stryMutAct_9fa48("315") ? false : stryMutAct_9fa48("314") ? true : (stryCov_9fa48("314", "315", "316", "317"), idxs.length < 2)) continue;
        for (let a = 0; stryMutAct_9fa48("320") ? a >= idxs.length : stryMutAct_9fa48("319") ? a <= idxs.length : stryMutAct_9fa48("318") ? false : (stryCov_9fa48("318", "319", "320"), a < idxs.length); stryMutAct_9fa48("321") ? a-- : (stryCov_9fa48("321"), a++)) {
          if (stryMutAct_9fa48("322")) {
            {}
          } else {
            stryCov_9fa48("322");
            for (let b = stryMutAct_9fa48("323") ? a - 1 : (stryCov_9fa48("323"), a + 1); stryMutAct_9fa48("326") ? b >= idxs.length : stryMutAct_9fa48("325") ? b <= idxs.length : stryMutAct_9fa48("324") ? false : (stryCov_9fa48("324", "325", "326"), b < idxs.length); stryMutAct_9fa48("327") ? b-- : (stryCov_9fa48("327"), b++)) {
              if (stryMutAct_9fa48("328")) {
                {}
              } else {
                stryCov_9fa48("328");
                const k = pairKey(idxs[a], idxs[b]);
                if (stryMutAct_9fa48("331") ? false : stryMutAct_9fa48("330") ? true : stryMutAct_9fa48("329") ? pairs.has(k) : (stryCov_9fa48("329", "330", "331"), !pairs.has(k))) pairs.set(k, stryMutAct_9fa48("332") ? {} : (stryCov_9fa48("332"), {
                  i: stryMutAct_9fa48("333") ? Math.max(idxs[a], idxs[b]) : (stryCov_9fa48("333"), Math.min(idxs[a], idxs[b])),
                  j: stryMutAct_9fa48("334") ? Math.min(idxs[a], idxs[b]) : (stryCov_9fa48("334"), Math.max(idxs[a], idxs[b])),
                  shared: stryMutAct_9fa48("335") ? ["Stryker was here"] : (stryCov_9fa48("335"), [])
                }));
                pairs.get(k).shared.push(key);
              }
            }
          }
        }
      }
    }
    return stryMutAct_9fa48("337") ? [...pairs.values()].map(p => {
      const a = live[p.i];
      const b = live[p.j];
      return {
        a: a.id,
        b: b.id,
        aFamily: a.family,
        bFamily: b.family,
        sameFamily: a.family === b.family,
        sharedSymbols: p.shared.sort(),
        sharedCount: p.shared.length,
        classification: a.family === b.family ? 'expected-fanout' : 'cross-dispatch-waste',
        // Jaccard over DISCRIMINATIVE added symbols: 1.0 means the two workstreams contributed
        // identical sets. Computed on the filtered sets so shared boilerplate cannot inflate it.
        similarity: p.shared.length / new Set([...discriminativeKeys(a, keep), ...discriminativeKeys(b, keep)]).size
      };
    }).sort((x, y) => {
      if (x.sameFamily !== y.sameFamily) return x.sameFamily ? 1 : -1;
      return y.sharedCount - x.sharedCount;
    }) : stryMutAct_9fa48("336") ? [...pairs.values()].filter(p => p.shared.length >= minShared).map(p => {
      const a = live[p.i];
      const b = live[p.j];
      return {
        a: a.id,
        b: b.id,
        aFamily: a.family,
        bFamily: b.family,
        sameFamily: a.family === b.family,
        sharedSymbols: p.shared.sort(),
        sharedCount: p.shared.length,
        classification: a.family === b.family ? 'expected-fanout' : 'cross-dispatch-waste',
        // Jaccard over DISCRIMINATIVE added symbols: 1.0 means the two workstreams contributed
        // identical sets. Computed on the filtered sets so shared boilerplate cannot inflate it.
        similarity: p.shared.length / new Set([...discriminativeKeys(a, keep), ...discriminativeKeys(b, keep)]).size
      };
    }) : (stryCov_9fa48("336", "337"), (stryMutAct_9fa48("338") ? [] : (stryCov_9fa48("338"), [...pairs.values()])).filter(stryMutAct_9fa48("339") ? () => undefined : (stryCov_9fa48("339"), p => stryMutAct_9fa48("343") ? p.shared.length < minShared : stryMutAct_9fa48("342") ? p.shared.length > minShared : stryMutAct_9fa48("341") ? false : stryMutAct_9fa48("340") ? true : (stryCov_9fa48("340", "341", "342", "343"), p.shared.length >= minShared))).map(p => {
      if (stryMutAct_9fa48("344")) {
        {}
      } else {
        stryCov_9fa48("344");
        const a = live[p.i];
        const b = live[p.j];
        return stryMutAct_9fa48("345") ? {} : (stryCov_9fa48("345"), {
          a: a.id,
          b: b.id,
          aFamily: a.family,
          bFamily: b.family,
          sameFamily: stryMutAct_9fa48("348") ? a.family !== b.family : stryMutAct_9fa48("347") ? false : stryMutAct_9fa48("346") ? true : (stryCov_9fa48("346", "347", "348"), a.family === b.family),
          sharedSymbols: stryMutAct_9fa48("349") ? p.shared : (stryCov_9fa48("349"), p.shared.sort()),
          sharedCount: p.shared.length,
          classification: (stryMutAct_9fa48("352") ? a.family !== b.family : stryMutAct_9fa48("351") ? false : stryMutAct_9fa48("350") ? true : (stryCov_9fa48("350", "351", "352"), a.family === b.family)) ? stryMutAct_9fa48("353") ? "" : (stryCov_9fa48("353"), 'expected-fanout') : stryMutAct_9fa48("354") ? "" : (stryCov_9fa48("354"), 'cross-dispatch-waste'),
          // Jaccard over DISCRIMINATIVE added symbols: 1.0 means the two workstreams contributed
          // identical sets. Computed on the filtered sets so shared boilerplate cannot inflate it.
          similarity: stryMutAct_9fa48("355") ? p.shared.length * new Set([...discriminativeKeys(a, keep), ...discriminativeKeys(b, keep)]).size : (stryCov_9fa48("355"), p.shared.length / new Set(stryMutAct_9fa48("356") ? [] : (stryCov_9fa48("356"), [...discriminativeKeys(a, keep), ...discriminativeKeys(b, keep)])).size)
        });
      }
    }).sort((x, y) => {
      if (stryMutAct_9fa48("357")) {
        {}
      } else {
        stryCov_9fa48("357");
        if (stryMutAct_9fa48("360") ? x.sameFamily === y.sameFamily : stryMutAct_9fa48("359") ? false : stryMutAct_9fa48("358") ? true : (stryCov_9fa48("358", "359", "360"), x.sameFamily !== y.sameFamily)) return x.sameFamily ? 1 : stryMutAct_9fa48("361") ? +1 : (stryCov_9fa48("361"), -1);
        return stryMutAct_9fa48("362") ? y.sharedCount + x.sharedCount : (stryCov_9fa48("362"), y.sharedCount - x.sharedCount);
      }
    }));
  }
}

/* ------------------------------------------------- P2: context digest ---- */

/**
 * What an agent working in workstream X needs to know about its siblings.
 *
 * This is the direct answer to context blindness: each agent sees the repo as it was when it
 * started and has no awareness of concurrent work. The digest is intentionally SMALL — it is
 * meant to be pasted into a running agent's context, so it reports decisions (avoid this file,
 * this symbol already exists next door) rather than dumping diffs.
 */
export function contextDigest(scanResult, workstreamId, {
  maxItems = 12
} = {}) {
  if (stryMutAct_9fa48("363")) {
    {}
  } else {
    stryCov_9fa48("363");
    const live = stryMutAct_9fa48("364") ? scanResult.workstreams : (stryCov_9fa48("364"), scanResult.workstreams.filter(stryMutAct_9fa48("365") ? () => undefined : (stryCov_9fa48("365"), w => w.ok)));
    const me = live.find(stryMutAct_9fa48("366") ? () => undefined : (stryCov_9fa48("366"), w => stryMutAct_9fa48("369") ? w.id !== workstreamId : stryMutAct_9fa48("368") ? false : stryMutAct_9fa48("367") ? true : (stryCov_9fa48("367", "368", "369"), w.id === workstreamId)));
    if (stryMutAct_9fa48("372") ? false : stryMutAct_9fa48("371") ? true : stryMutAct_9fa48("370") ? me : (stryCov_9fa48("370", "371", "372"), !me)) {
      if (stryMutAct_9fa48("373")) {
        {}
      } else {
        stryCov_9fa48("373");
        return stryMutAct_9fa48("374") ? {} : (stryCov_9fa48("374"), {
          ok: stryMutAct_9fa48("375") ? true : (stryCov_9fa48("375"), false),
          error: stryMutAct_9fa48("376") ? `` : (stryCov_9fa48("376"), `no scanned workstream with id '${workstreamId}'`),
          known: live.map(stryMutAct_9fa48("377") ? () => undefined : (stryCov_9fa48("377"), w => w.id))
        });
      }
    }
    const {
      keep
    } = discriminativeSymbols(live);
    const myFiles = setOf(stryMutAct_9fa48("378") ? me.touched && [] : (stryCov_9fa48("378"), me.touched ?? (stryMutAct_9fa48("379") ? ["Stryker was here"] : (stryCov_9fa48("379"), []))));
    const myKeys = setOf(discriminativeKeys(me, keep));
    const contested = stryMutAct_9fa48("380") ? ["Stryker was here"] : (stryCov_9fa48("380"), []);
    const alreadyBuilt = stryMutAct_9fa48("381") ? ["Stryker was here"] : (stryCov_9fa48("381"), []);
    for (const other of live) {
      if (stryMutAct_9fa48("382")) {
        {}
      } else {
        stryCov_9fa48("382");
        if (stryMutAct_9fa48("385") ? other.id !== me.id : stryMutAct_9fa48("384") ? false : stryMutAct_9fa48("383") ? true : (stryCov_9fa48("383", "384", "385"), other.id === me.id)) continue;
        const sharedFiles = intersect(myFiles, stryMutAct_9fa48("386") ? other.touched && [] : (stryCov_9fa48("386"), other.touched ?? (stryMutAct_9fa48("387") ? ["Stryker was here"] : (stryCov_9fa48("387"), []))));
        if (stryMutAct_9fa48("389") ? false : stryMutAct_9fa48("388") ? true : (stryCov_9fa48("388", "389"), sharedFiles.length)) {
          if (stryMutAct_9fa48("390")) {
            {}
          } else {
            stryCov_9fa48("390");
            contested.push(stryMutAct_9fa48("391") ? {} : (stryCov_9fa48("391"), {
              workstream: other.id,
              family: other.family,
              files: stryMutAct_9fa48("393") ? sharedFiles.slice(0, maxItems) : stryMutAct_9fa48("392") ? sharedFiles.sort() : (stryCov_9fa48("392", "393"), sharedFiles.sort().slice(0, maxItems)),
              fileCount: sharedFiles.length,
              hasUncommitted: stryMutAct_9fa48("397") ? other.uncommitted.count <= 0 : stryMutAct_9fa48("396") ? other.uncommitted.count >= 0 : stryMutAct_9fa48("395") ? false : stryMutAct_9fa48("394") ? true : (stryCov_9fa48("394", "395", "396", "397"), other.uncommitted.count > 0)
            }));
          }
        }
        const sharedSyms = intersect(myKeys, discriminativeKeys(other, keep));
        if (stryMutAct_9fa48("399") ? false : stryMutAct_9fa48("398") ? true : (stryCov_9fa48("398", "399"), sharedSyms.length)) {
          if (stryMutAct_9fa48("400")) {
            {}
          } else {
            stryCov_9fa48("400");
            alreadyBuilt.push(stryMutAct_9fa48("401") ? {} : (stryCov_9fa48("401"), {
              workstream: other.id,
              family: other.family,
              symbols: stryMutAct_9fa48("402") ? sharedSyms : (stryCov_9fa48("402"), sharedSyms.slice(0, maxItems)),
              count: sharedSyms.length
            }));
          }
        }
      }
    }
    stryMutAct_9fa48("403") ? contested : (stryCov_9fa48("403"), contested.sort(stryMutAct_9fa48("404") ? () => undefined : (stryCov_9fa48("404"), (a, b) => stryMutAct_9fa48("405") ? b.fileCount + a.fileCount : (stryCov_9fa48("405"), b.fileCount - a.fileCount))));
    stryMutAct_9fa48("406") ? alreadyBuilt : (stryCov_9fa48("406"), alreadyBuilt.sort(stryMutAct_9fa48("407") ? () => undefined : (stryCov_9fa48("407"), (a, b) => stryMutAct_9fa48("408") ? b.count + a.count : (stryCov_9fa48("408"), b.count - a.count))));
    return stryMutAct_9fa48("409") ? {} : (stryCov_9fa48("409"), {
      ok: stryMutAct_9fa48("410") ? false : (stryCov_9fa48("410"), true),
      workstream: me.id,
      family: me.family,
      siblings: stryMutAct_9fa48("411") ? live.map(w => w.id) : (stryCov_9fa48("411"), live.filter(stryMutAct_9fa48("412") ? () => undefined : (stryCov_9fa48("412"), w => stryMutAct_9fa48("415") ? w.family === me.family || w.id !== me.id : stryMutAct_9fa48("414") ? false : stryMutAct_9fa48("413") ? true : (stryCov_9fa48("413", "414", "415"), (stryMutAct_9fa48("417") ? w.family !== me.family : stryMutAct_9fa48("416") ? true : (stryCov_9fa48("416", "417"), w.family === me.family)) && (stryMutAct_9fa48("419") ? w.id === me.id : stryMutAct_9fa48("418") ? true : (stryCov_9fa48("418", "419"), w.id !== me.id))))).map(stryMutAct_9fa48("420") ? () => undefined : (stryCov_9fa48("420"), w => w.id))),
      contestedFiles: stryMutAct_9fa48("421") ? contested : (stryCov_9fa48("421"), contested.slice(0, maxItems)),
      duplicatedSymbols: stryMutAct_9fa48("422") ? alreadyBuilt : (stryCov_9fa48("422"), alreadyBuilt.slice(0, maxItems)),
      advice: buildAdvice(contested, alreadyBuilt)
    });
  }
}
function buildAdvice(contested, alreadyBuilt) {
  if (stryMutAct_9fa48("423")) {
    {}
  } else {
    stryCov_9fa48("423");
    const out = stryMutAct_9fa48("424") ? ["Stryker was here"] : (stryCov_9fa48("424"), []);
    if (stryMutAct_9fa48("426") ? false : stryMutAct_9fa48("425") ? true : (stryCov_9fa48("425", "426"), alreadyBuilt.length)) {
      if (stryMutAct_9fa48("427")) {
        {}
      } else {
        stryCov_9fa48("427");
        const top = alreadyBuilt[0];
        out.push(stryMutAct_9fa48("428") ? `` : (stryCov_9fa48("428"), `${top.count} symbol(s) you added also exist in '${top.workstream}' — check before duplicating: ${stryMutAct_9fa48("429") ? top.symbols.join(', ') : (stryCov_9fa48("429"), top.symbols.slice(0, 3).join(stryMutAct_9fa48("430") ? "" : (stryCov_9fa48("430"), ', ')))}`));
      }
    }
    if (stryMutAct_9fa48("432") ? false : stryMutAct_9fa48("431") ? true : (stryCov_9fa48("431", "432"), contested.length)) {
      if (stryMutAct_9fa48("433")) {
        {}
      } else {
        stryCov_9fa48("433");
        const top = contested[0];
        out.push(stryMutAct_9fa48("434") ? `` : (stryCov_9fa48("434"), `'${top.workstream}' is editing ${top.fileCount} of the same file(s)${top.hasUncommitted ? stryMutAct_9fa48("435") ? "" : (stryCov_9fa48("435"), ' with uncommitted changes') : stryMutAct_9fa48("436") ? "Stryker was here!" : (stryCov_9fa48("436"), '')} — highest contention: ${top.files[0]}`));
      }
    }
    if (stryMutAct_9fa48("439") ? false : stryMutAct_9fa48("438") ? true : stryMutAct_9fa48("437") ? out.length : (stryCov_9fa48("437", "438", "439"), !out.length)) out.push(stryMutAct_9fa48("440") ? "" : (stryCov_9fa48("440"), 'no contested files and no duplicated symbols against any other workstream'));
    return out;
  }
}

/* --------------------------------------------------- P5: landing plan ---- */

/**
 * An ORDER to land N workstreams in, not a review.
 *
 * The review bottleneck is asymmetric — agents produce far faster than humans can review —
 * so the leverage is in reviewing LESS, not reviewing faster: drop provably-disposable
 * workstreams, collapse duplicates to one representative, and order what remains so each
 * landing does not invalidate the next.
 *
 * Ordering rule: land the least-entangled first. A workstream that collides with nothing can
 * be landed and forgotten; one that collides with four others should be landed when the
 * others are already resolved, so its conflicts are real rather than speculative.
 *
 * Executing the rebases is explicitly NOT grove's job — git-machete, stack-pr and Graphite
 * already do stacked-branch restacking well. grove produces the order; they apply it.
 */
export function landingPlan(scanResult, {
  collisions: cols = stryMutAct_9fa48("441") ? ["Stryker was here"] : (stryCov_9fa48("441"), []),
  duplicates: dups = stryMutAct_9fa48("442") ? ["Stryker was here"] : (stryCov_9fa48("442"), [])
} = {}) {
  if (stryMutAct_9fa48("443")) {
    {}
  } else {
    stryCov_9fa48("443");
    const uniq = uniqueWork(scanResult);
    const safe = safeToDelete(scanResult, uniq);
    const safeIds = setOf(stryMutAct_9fa48("444") ? safe.map(s => s.id) : (stryCov_9fa48("444"), safe.filter(stryMutAct_9fa48("445") ? () => undefined : (stryCov_9fa48("445"), s => s.safe)).map(stryMutAct_9fa48("446") ? () => undefined : (stryCov_9fa48("446"), s => s.id))));
    const live = stryMutAct_9fa48("447") ? scanResult.workstreams : (stryCov_9fa48("447"), scanResult.workstreams.filter(stryMutAct_9fa48("448") ? () => undefined : (stryCov_9fa48("448"), w => w.ok)));
    const entanglement = new Map();
    for (const c of cols) {
      if (stryMutAct_9fa48("449")) {
        {}
      } else {
        stryCov_9fa48("449");
        if (stryMutAct_9fa48("452") ? c.severity !== 'none' : stryMutAct_9fa48("451") ? false : stryMutAct_9fa48("450") ? true : (stryCov_9fa48("450", "451", "452"), c.severity === (stryMutAct_9fa48("453") ? "" : (stryCov_9fa48("453"), 'none')))) continue;
        const w = (stryMutAct_9fa48("456") ? c.severity !== 'high' : stryMutAct_9fa48("455") ? false : stryMutAct_9fa48("454") ? true : (stryCov_9fa48("454", "455", "456"), c.severity === (stryMutAct_9fa48("457") ? "" : (stryCov_9fa48("457"), 'high')))) ? 3 : (stryMutAct_9fa48("460") ? c.severity !== 'medium' : stryMutAct_9fa48("459") ? false : stryMutAct_9fa48("458") ? true : (stryCov_9fa48("458", "459", "460"), c.severity === (stryMutAct_9fa48("461") ? "" : (stryCov_9fa48("461"), 'medium')))) ? 2 : 1;
        entanglement.set(c.a, stryMutAct_9fa48("462") ? (entanglement.get(c.a) ?? 0) - w : (stryCov_9fa48("462"), (stryMutAct_9fa48("463") ? entanglement.get(c.a) && 0 : (stryCov_9fa48("463"), entanglement.get(c.a) ?? 0)) + w));
        entanglement.set(c.b, stryMutAct_9fa48("464") ? (entanglement.get(c.b) ?? 0) - w : (stryCov_9fa48("464"), (stryMutAct_9fa48("465") ? entanglement.get(c.b) && 0 : (stryCov_9fa48("465"), entanglement.get(c.b) ?? 0)) + w));
      }
    }

    // Collapse cross-family duplicate groups to one representative: the one with more unique work.
    const uniqById = new Map(uniq.map(stryMutAct_9fa48("466") ? () => undefined : (stryCov_9fa48("466"), u => stryMutAct_9fa48("467") ? [] : (stryCov_9fa48("467"), [u.id, u]))));
    const supersededBy = new Map();
    for (const d of dups) {
      if (stryMutAct_9fa48("468")) {
        {}
      } else {
        stryCov_9fa48("468");
        if (stryMutAct_9fa48("470") ? false : stryMutAct_9fa48("469") ? true : (stryCov_9fa48("469", "470"), d.sameFamily)) continue;
        if (stryMutAct_9fa48("474") ? d.similarity >= 0.6 : stryMutAct_9fa48("473") ? d.similarity <= 0.6 : stryMutAct_9fa48("472") ? false : stryMutAct_9fa48("471") ? true : (stryCov_9fa48("471", "472", "473", "474"), d.similarity < 0.6)) continue; // only collapse when the overlap is substantial
        const ua = stryMutAct_9fa48("475") ? uniqById.get(d.a)?.uniqueSymbolCount && 0 : (stryCov_9fa48("475"), (stryMutAct_9fa48("476") ? uniqById.get(d.a).uniqueSymbolCount : (stryCov_9fa48("476"), uniqById.get(d.a)?.uniqueSymbolCount)) ?? 0);
        const ub = stryMutAct_9fa48("477") ? uniqById.get(d.b)?.uniqueSymbolCount && 0 : (stryCov_9fa48("477"), (stryMutAct_9fa48("478") ? uniqById.get(d.b).uniqueSymbolCount : (stryCov_9fa48("478"), uniqById.get(d.b)?.uniqueSymbolCount)) ?? 0);
        const [keep, drop] = (stryMutAct_9fa48("482") ? ua < ub : stryMutAct_9fa48("481") ? ua > ub : stryMutAct_9fa48("480") ? false : stryMutAct_9fa48("479") ? true : (stryCov_9fa48("479", "480", "481", "482"), ua >= ub)) ? stryMutAct_9fa48("483") ? [] : (stryCov_9fa48("483"), [d.a, d.b]) : stryMutAct_9fa48("484") ? [] : (stryCov_9fa48("484"), [d.b, d.a]);
        if (stryMutAct_9fa48("487") ? false : stryMutAct_9fa48("486") ? true : stryMutAct_9fa48("485") ? supersededBy.has(drop) : (stryCov_9fa48("485", "486", "487"), !supersededBy.has(drop))) supersededBy.set(drop, keep);
      }
    }
    const candidates = stryMutAct_9fa48("489") ? scanResult.workstreams.filter(w => !safeIds.has(w.id)).map(w => {
      const u = uniqById.get(w.id);
      return {
        id: w.id,
        path: w.path,
        family: w.family,
        uniqueSymbols: u?.uniqueSymbolCount ?? 0,
        uncommittedOnly: u?.uncommittedOnlyCount ?? 0,
        entanglement: entanglement.get(w.id) ?? 0,
        supersededBy: supersededBy.get(w.id) ?? null,
        filesToReview: w.touched.length
      };
    }) : stryMutAct_9fa48("488") ? scanResult.workstreams.filter(w => w.ok).map(w => {
      const u = uniqById.get(w.id);
      return {
        id: w.id,
        path: w.path,
        family: w.family,
        uniqueSymbols: u?.uniqueSymbolCount ?? 0,
        uncommittedOnly: u?.uncommittedOnlyCount ?? 0,
        entanglement: entanglement.get(w.id) ?? 0,
        supersededBy: supersededBy.get(w.id) ?? null,
        filesToReview: w.touched.length
      };
    }) : (stryCov_9fa48("488", "489"), scanResult.workstreams.filter(stryMutAct_9fa48("490") ? () => undefined : (stryCov_9fa48("490"), w => w.ok)).filter(stryMutAct_9fa48("491") ? () => undefined : (stryCov_9fa48("491"), w => stryMutAct_9fa48("492") ? safeIds.has(w.id) : (stryCov_9fa48("492"), !safeIds.has(w.id)))).map(w => {
      if (stryMutAct_9fa48("493")) {
        {}
      } else {
        stryCov_9fa48("493");
        const u = uniqById.get(w.id);
        return stryMutAct_9fa48("494") ? {} : (stryCov_9fa48("494"), {
          id: w.id,
          path: w.path,
          family: w.family,
          uniqueSymbols: stryMutAct_9fa48("495") ? u?.uniqueSymbolCount && 0 : (stryCov_9fa48("495"), (stryMutAct_9fa48("496") ? u.uniqueSymbolCount : (stryCov_9fa48("496"), u?.uniqueSymbolCount)) ?? 0),
          uncommittedOnly: stryMutAct_9fa48("497") ? u?.uncommittedOnlyCount && 0 : (stryCov_9fa48("497"), (stryMutAct_9fa48("498") ? u.uncommittedOnlyCount : (stryCov_9fa48("498"), u?.uncommittedOnlyCount)) ?? 0),
          entanglement: stryMutAct_9fa48("499") ? entanglement.get(w.id) && 0 : (stryCov_9fa48("499"), entanglement.get(w.id) ?? 0),
          supersededBy: stryMutAct_9fa48("500") ? supersededBy.get(w.id) && null : (stryCov_9fa48("500"), supersededBy.get(w.id) ?? null),
          filesToReview: w.touched.length
        });
      }
    }));
    const toLand = stryMutAct_9fa48("502") ? candidates.sort((a, b) => a.entanglement - b.entanglement || b.uniqueSymbols - a.uniqueSymbols) : stryMutAct_9fa48("501") ? candidates.filter(c => !c.supersededBy) : (stryCov_9fa48("501", "502"), candidates.filter(stryMutAct_9fa48("503") ? () => undefined : (stryCov_9fa48("503"), c => stryMutAct_9fa48("504") ? c.supersededBy : (stryCov_9fa48("504"), !c.supersededBy))).sort(stryMutAct_9fa48("505") ? () => undefined : (stryCov_9fa48("505"), (a, b) => stryMutAct_9fa48("508") ? a.entanglement - b.entanglement && b.uniqueSymbols - a.uniqueSymbols : stryMutAct_9fa48("507") ? false : stryMutAct_9fa48("506") ? true : (stryCov_9fa48("506", "507", "508"), (stryMutAct_9fa48("509") ? a.entanglement + b.entanglement : (stryCov_9fa48("509"), a.entanglement - b.entanglement)) || (stryMutAct_9fa48("510") ? b.uniqueSymbols + a.uniqueSymbols : (stryCov_9fa48("510"), b.uniqueSymbols - a.uniqueSymbols))))));
    return stryMutAct_9fa48("511") ? {} : (stryCov_9fa48("511"), {
      drop: stryMutAct_9fa48("512") ? safe.map(s => ({
        id: s.id,
        why: 'nothing unique, nothing uncommitted, nothing base lacks'
      })) : (stryCov_9fa48("512"), safe.filter(stryMutAct_9fa48("513") ? () => undefined : (stryCov_9fa48("513"), s => s.safe)).map(stryMutAct_9fa48("514") ? () => undefined : (stryCov_9fa48("514"), s => stryMutAct_9fa48("515") ? {} : (stryCov_9fa48("515"), {
        id: s.id,
        why: stryMutAct_9fa48("516") ? "" : (stryCov_9fa48("516"), 'nothing unique, nothing uncommitted, nothing base lacks')
      })))),
      collapse: stryMutAct_9fa48("517") ? candidates.map(c => ({
        id: c.id,
        into: c.supersededBy,
        why: 'duplicate of another dispatch'
      })) : (stryCov_9fa48("517"), candidates.filter(stryMutAct_9fa48("518") ? () => undefined : (stryCov_9fa48("518"), c => c.supersededBy)).map(stryMutAct_9fa48("519") ? () => undefined : (stryCov_9fa48("519"), c => stryMutAct_9fa48("520") ? {} : (stryCov_9fa48("520"), {
        id: c.id,
        into: c.supersededBy,
        why: stryMutAct_9fa48("521") ? "" : (stryCov_9fa48("521"), 'duplicate of another dispatch')
      })))),
      order: toLand.map(stryMutAct_9fa48("522") ? () => undefined : (stryCov_9fa48("522"), (c, i) => stryMutAct_9fa48("523") ? {} : (stryCov_9fa48("523"), {
        step: stryMutAct_9fa48("524") ? i - 1 : (stryCov_9fa48("524"), i + 1),
        ...c
      }))),
      reviewReduction: stryMutAct_9fa48("525") ? {} : (stryCov_9fa48("525"), {
        total: live.length,
        dropped: stryMutAct_9fa48("526") ? safe.length : (stryCov_9fa48("526"), safe.filter(stryMutAct_9fa48("527") ? () => undefined : (stryCov_9fa48("527"), s => s.safe)).length),
        collapsed: stryMutAct_9fa48("528") ? candidates.length : (stryCov_9fa48("528"), candidates.filter(stryMutAct_9fa48("529") ? () => undefined : (stryCov_9fa48("529"), c => c.supersededBy)).length),
        toReview: toLand.length
      }),
      reviewSurface: reviewSurface(live, safeIds),
      note: stryMutAct_9fa48("530") ? "" : (stryCov_9fa48("530"), 'grove produces the ORDER. Executing rebases is git-machete / stack-pr / Graphite territory.')
    });
  }
}

/**
 * REVIEW SURFACE — the honest measure of P5, and the one that makes it a product.
 *
 * Counting workstreams was measuring the wrong thing. On a real 39-workstream repo the plan
 * "reduced" review from 39 to 36 — an 8% saving that nobody would pay for. But a reviewer does
 * not read workstreams, they read CHANGES, and the same change appears in many workstreams: when
 * five agents each add `ARC_MEMORY_PROMOTION_K`, a human needs to understand it ONCE and then
 * only confirm the other four match.
 *
 * So the real quantity is: how many DISTINCT things need human eyes, versus how many a
 * PR-by-PR review would put in front of them.
 *
 *   naive       sum over workstreams of files touched   (what reviewing each PR costs today)
 *   distinct    the union of those files                (what actually needs reading)
 *   novel       symbols that appear in exactly ONE workstream — genuine review
 *   corroborated symbols in 2+ workstreams — read once, then compare
 *
 * This is a measurement, not a promise: it says what the redundancy IS, and the reduction is
 * only realised by a reviewer who uses the grouping. Reported as such.
 */
export function reviewSurface(live, safeIds = new Set()) {
  if (stryMutAct_9fa48("531")) {
    {}
  } else {
    stryCov_9fa48("531");
    const inPlay = stryMutAct_9fa48("532") ? live : (stryCov_9fa48("532"), live.filter(stryMutAct_9fa48("533") ? () => undefined : (stryCov_9fa48("533"), w => stryMutAct_9fa48("534") ? safeIds.has(w.id) : (stryCov_9fa48("534"), !safeIds.has(w.id)))));
    let naiveFiles = 0;
    let naiveSymbols = 0;
    const distinctFiles = new Set();
    const symbolOwners = new Map();
    for (const w of inPlay) {
      if (stryMutAct_9fa48("535")) {
        {}
      } else {
        stryCov_9fa48("535");
        stryMutAct_9fa48("536") ? naiveFiles -= w.touched.length : (stryCov_9fa48("536"), naiveFiles += w.touched.length);
        for (const f of w.touched) distinctFiles.add(f);
        const keys = stryMutAct_9fa48("537") ? w.addedKeys && [] : (stryCov_9fa48("537"), w.addedKeys ?? (stryMutAct_9fa48("538") ? ["Stryker was here"] : (stryCov_9fa48("538"), [])));
        stryMutAct_9fa48("539") ? naiveSymbols -= keys.length : (stryCov_9fa48("539"), naiveSymbols += keys.length);
        for (const k of keys) {
          if (stryMutAct_9fa48("540")) {
            {}
          } else {
            stryCov_9fa48("540");
            if (stryMutAct_9fa48("543") ? false : stryMutAct_9fa48("542") ? true : stryMutAct_9fa48("541") ? symbolOwners.has(k) : (stryCov_9fa48("541", "542", "543"), !symbolOwners.has(k))) symbolOwners.set(k, 0);
            symbolOwners.set(k, stryMutAct_9fa48("544") ? symbolOwners.get(k) - 1 : (stryCov_9fa48("544"), symbolOwners.get(k) + 1));
          }
        }
      }
    }
    let novel = 0;
    let corroborated = 0;
    for (const count of symbolOwners.values()) {
      if (stryMutAct_9fa48("545")) {
        {}
      } else {
        stryCov_9fa48("545");
        if (stryMutAct_9fa48("548") ? count !== 1 : stryMutAct_9fa48("547") ? false : stryMutAct_9fa48("546") ? true : (stryCov_9fa48("546", "547", "548"), count === 1)) stryMutAct_9fa48("549") ? novel-- : (stryCov_9fa48("549"), novel++);else stryMutAct_9fa48("550") ? corroborated-- : (stryCov_9fa48("550"), corroborated++);
      }
    }
    const pct = stryMutAct_9fa48("551") ? () => undefined : (stryCov_9fa48("551"), (() => {
      const pct = (from, to) => (stryMutAct_9fa48("555") ? from <= 0 : stryMutAct_9fa48("554") ? from >= 0 : stryMutAct_9fa48("553") ? false : stryMutAct_9fa48("552") ? true : (stryCov_9fa48("552", "553", "554", "555"), from > 0)) ? Math.round(stryMutAct_9fa48("556") ? (1 - to / from) / 100 : (stryCov_9fa48("556"), (stryMutAct_9fa48("557") ? 1 + to / from : (stryCov_9fa48("557"), 1 - (stryMutAct_9fa48("558") ? to * from : (stryCov_9fa48("558"), to / from)))) * 100)) : 0;
      return pct;
    })());
    return stryMutAct_9fa48("559") ? {} : (stryCov_9fa48("559"), {
      workstreamsInPlay: inPlay.length,
      files: stryMutAct_9fa48("560") ? {} : (stryCov_9fa48("560"), {
        naive: naiveFiles,
        distinct: distinctFiles.size,
        reductionPct: pct(naiveFiles, distinctFiles.size)
      }),
      symbols: stryMutAct_9fa48("561") ? {} : (stryCov_9fa48("561"), {
        naive: naiveSymbols,
        distinct: symbolOwners.size,
        novel,
        corroborated,
        reductionPct: pct(naiveSymbols, symbolOwners.size)
      }),
      explanation: (stryMutAct_9fa48("562") ? "" : (stryCov_9fa48("562"), 'naive = what PR-by-PR review puts in front of a human; distinct = what actually needs reading. ')) + (stryMutAct_9fa48("563") ? "" : (stryCov_9fa48("563"), 'novel symbols appear in exactly one workstream and need real review; corroborated symbols appear ')) + (stryMutAct_9fa48("564") ? "" : (stryCov_9fa48("564"), 'in several and need reading once, then comparing.'))
    });
  }
}

/* ------------------------------------------------------------- the graph ---- */

/** Nodes + edges, for rendering or for an agent to reason over. */
export function buildGraph(scanResult, {
  collisions: cols = stryMutAct_9fa48("565") ? ["Stryker was here"] : (stryCov_9fa48("565"), []),
  duplicates: dups = stryMutAct_9fa48("566") ? ["Stryker was here"] : (stryCov_9fa48("566"), [])
} = {}) {
  if (stryMutAct_9fa48("567")) {
    {}
  } else {
    stryCov_9fa48("567");
    const live = stryMutAct_9fa48("568") ? scanResult.workstreams : (stryCov_9fa48("568"), scanResult.workstreams.filter(stryMutAct_9fa48("569") ? () => undefined : (stryCov_9fa48("569"), w => w.ok)));
    const uniq = uniqueWork(scanResult);
    const uniqById = new Map(uniq.map(stryMutAct_9fa48("570") ? () => undefined : (stryCov_9fa48("570"), u => stryMutAct_9fa48("571") ? [] : (stryCov_9fa48("571"), [u.id, u]))));
    const safe = new Map(safeToDelete(scanResult, uniq).map(stryMutAct_9fa48("572") ? () => undefined : (stryCov_9fa48("572"), s => stryMutAct_9fa48("573") ? [] : (stryCov_9fa48("573"), [s.id, s]))));
    const nodes = live.map(stryMutAct_9fa48("574") ? () => undefined : (stryCov_9fa48("574"), w => stryMutAct_9fa48("575") ? {} : (stryCov_9fa48("575"), {
      id: w.id,
      family: w.family,
      path: w.path,
      head: w.head ? stryMutAct_9fa48("576") ? w.head : (stryCov_9fa48("576"), w.head.slice(0, 8)) : null,
      branch: w.branch,
      committedFiles: w.committed.count,
      uncommittedFiles: w.uncommitted.count,
      addedSymbols: w.stats.addedSymbols,
      uniqueSymbols: stryMutAct_9fa48("577") ? uniqById.get(w.id)?.uniqueSymbolCount && 0 : (stryCov_9fa48("577"), (stryMutAct_9fa48("578") ? uniqById.get(w.id).uniqueSymbolCount : (stryCov_9fa48("578"), uniqById.get(w.id)?.uniqueSymbolCount)) ?? 0),
      uncommittedOnly: stryMutAct_9fa48("579") ? uniqById.get(w.id)?.uncommittedOnlyCount && 0 : (stryCov_9fa48("579"), (stryMutAct_9fa48("580") ? uniqById.get(w.id).uncommittedOnlyCount : (stryCov_9fa48("580"), uniqById.get(w.id)?.uncommittedOnlyCount)) ?? 0),
      safeToDelete: stryMutAct_9fa48("581") ? safe.get(w.id)?.safe && false : (stryCov_9fa48("581"), (stryMutAct_9fa48("582") ? safe.get(w.id).safe : (stryCov_9fa48("582"), safe.get(w.id)?.safe)) ?? (stryMutAct_9fa48("583") ? true : (stryCov_9fa48("583"), false))),
      verdict: stryMutAct_9fa48("584") ? uniqById.get(w.id)?.verdict && 'unknown' : (stryCov_9fa48("584"), (stryMutAct_9fa48("585") ? uniqById.get(w.id).verdict : (stryCov_9fa48("585"), uniqById.get(w.id)?.verdict)) ?? (stryMutAct_9fa48("586") ? "" : (stryCov_9fa48("586"), 'unknown')))
    })));
    const edges = stryMutAct_9fa48("587") ? ["Stryker was here"] : (stryCov_9fa48("587"), []);
    const families = new Map();
    for (const n of nodes) {
      if (stryMutAct_9fa48("588")) {
        {}
      } else {
        stryCov_9fa48("588");
        if (stryMutAct_9fa48("591") ? false : stryMutAct_9fa48("590") ? true : stryMutAct_9fa48("589") ? families.has(n.family) : (stryCov_9fa48("589", "590", "591"), !families.has(n.family))) families.set(n.family, stryMutAct_9fa48("592") ? ["Stryker was here"] : (stryCov_9fa48("592"), []));
        families.get(n.family).push(n.id);
      }
    }
    for (const [family, ids] of families) {
      if (stryMutAct_9fa48("593")) {
        {}
      } else {
        stryCov_9fa48("593");
        if (stryMutAct_9fa48("597") ? ids.length >= 2 : stryMutAct_9fa48("596") ? ids.length <= 2 : stryMutAct_9fa48("595") ? false : stryMutAct_9fa48("594") ? true : (stryCov_9fa48("594", "595", "596", "597"), ids.length < 2)) continue;
        for (let i = 1; stryMutAct_9fa48("600") ? i >= ids.length : stryMutAct_9fa48("599") ? i <= ids.length : stryMutAct_9fa48("598") ? false : (stryCov_9fa48("598", "599", "600"), i < ids.length); stryMutAct_9fa48("601") ? i-- : (stryCov_9fa48("601"), i++)) {
          if (stryMutAct_9fa48("602")) {
            {}
          } else {
            stryCov_9fa48("602");
            edges.push(stryMutAct_9fa48("603") ? {} : (stryCov_9fa48("603"), {
              type: stryMutAct_9fa48("604") ? "" : (stryCov_9fa48("604"), 'sibling'),
              source: ids[0],
              target: ids[i],
              family,
              weight: 1
            }));
          }
        }
      }
    }
    for (const c of cols) {
      if (stryMutAct_9fa48("605")) {
        {}
      } else {
        stryCov_9fa48("605");
        edges.push(stryMutAct_9fa48("606") ? {} : (stryCov_9fa48("606"), {
          type: stryMutAct_9fa48("607") ? "" : (stryCov_9fa48("607"), 'collision'),
          source: c.a,
          target: c.b,
          weight: c.sharedFileCount,
          severity: c.severity,
          kind: c.kind,
          why: c.why
        }));
      }
    }
    for (const d of dups) {
      if (stryMutAct_9fa48("608")) {
        {}
      } else {
        stryCov_9fa48("608");
        edges.push(stryMutAct_9fa48("609") ? {} : (stryCov_9fa48("609"), {
          type: stryMutAct_9fa48("610") ? "" : (stryCov_9fa48("610"), 'duplicate'),
          source: d.a,
          target: d.b,
          weight: d.sharedCount,
          similarity: Number(d.similarity.toFixed(3)),
          classification: d.classification
        }));
      }
    }
    return stryMutAct_9fa48("611") ? {} : (stryCov_9fa48("611"), {
      nodes,
      edges,
      families: (stryMutAct_9fa48("612") ? [] : (stryCov_9fa48("612"), [...families.entries()])).map(stryMutAct_9fa48("613") ? () => undefined : (stryCov_9fa48("613"), ([name, ids]) => stryMutAct_9fa48("614") ? {} : (stryCov_9fa48("614"), {
        name,
        members: ids
      })))
    });
  }
}

/* --------------------------------------------------------- one-shot report ---- */

/** Everything, computed once. The shape every renderer and the MCP server consume. */
export async function analyze(scanResult, opts = {}) {
  if (stryMutAct_9fa48("615")) {
    {}
  } else {
    stryCov_9fa48("615");
    const cols = await collisions(scanResult, opts);
    const dups = duplicates(scanResult, opts);
    const uniq = uniqueWork(scanResult);
    const safe = safeToDelete(scanResult, uniq);
    const plan = landingPlan(scanResult, stryMutAct_9fa48("616") ? {} : (stryCov_9fa48("616"), {
      collisions: cols,
      duplicates: dups
    }));
    const graph = buildGraph(scanResult, stryMutAct_9fa48("617") ? {} : (stryCov_9fa48("617"), {
      collisions: cols,
      duplicates: dups
    }));

    // Filtering is never silent. A bounded result that does not say what it bounded reads as
    // full coverage, which is how a tool quietly starts lying about what it looked at.
    const live = stryMutAct_9fa48("618") ? scanResult.workstreams : (stryCov_9fa48("618"), scanResult.workstreams.filter(stryMutAct_9fa48("619") ? () => undefined : (stryCov_9fa48("619"), w => w.ok)));
    const {
      dropped,
      limit
    } = discriminativeSymbols(live);
    return stryMutAct_9fa48("620") ? {} : (stryCov_9fa48("620"), {
      base: scanResult.base,
      root: scanResult.root,
      backend: scanResult.backend,
      strictReadOnly: scanResult.strictReadOnly,
      counts: stryMutAct_9fa48("621") ? {} : (stryCov_9fa48("621"), {
        workstreams: scanResult.workstreams.length,
        scanned: stryMutAct_9fa48("622") ? scanResult.workstreams.length : (stryCov_9fa48("622"), scanResult.workstreams.filter(stryMutAct_9fa48("623") ? () => undefined : (stryCov_9fa48("623"), w => w.ok)).length),
        skipped: scanResult.skipped.length,
        families: graph.families.length,
        collisions: cols.length,
        duplicatePairs: dups.length,
        safeToDelete: stryMutAct_9fa48("624") ? safe.length : (stryCov_9fa48("624"), safe.filter(stryMutAct_9fa48("625") ? () => undefined : (stryCov_9fa48("625"), s => s.safe)).length),
        atRisk: stryMutAct_9fa48("626") ? uniq.length : (stryCov_9fa48("626"), uniq.filter(stryMutAct_9fa48("627") ? () => undefined : (stryCov_9fa48("627"), u => stryMutAct_9fa48("631") ? u.uncommittedOnlyCount <= 0 : stryMutAct_9fa48("630") ? u.uncommittedOnlyCount >= 0 : stryMutAct_9fa48("629") ? false : stryMutAct_9fa48("628") ? true : (stryCov_9fa48("628", "629", "630", "631"), u.uncommittedOnlyCount > 0))).length)
      }),
      unique: uniq,
      safe,
      collisions: cols,
      duplicates: dups,
      plan,
      graph,
      skipped: scanResult.skipped,
      filtering: stryMutAct_9fa48("632") ? {} : (stryCov_9fa48("632"), {
        rule: stryMutAct_9fa48("633") ? `` : (stryCov_9fa48("633"), `a symbol carried by more than ${limit} of ${live.length} workstream(s) is treated as boilerplate and excluded from PAIR evidence only`),
        droppedCount: dropped.length,
        dropped: stryMutAct_9fa48("634") ? dropped : (stryCov_9fa48("634"), dropped.slice(0, 15)),
        note: stryMutAct_9fa48("635") ? "" : (stryCov_9fa48("635"), 'per-workstream added/unique symbol lists are NOT filtered')
      })
    });
  }
}