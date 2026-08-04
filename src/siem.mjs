// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * holt — journal → SIEM wire formats. OFFLINE: this module formats bytes and never ships them.
 *
 * A compliance artefact nobody can ingest is a text file with extra steps. These are the three
 * formats that between them cover essentially every SIEM a buyer already runs, and each one is
 * an EXISTING published schema — holt maps onto them, it does not invent a fourth:
 *
 *   - OCSF 1.7.0 `API Activity` (class_uid 6003, category_uid 6 Application Activity,
 *     type_uid = class_uid*100 + activity_id). The cross-vendor standard behind AWS Security
 *     Lake, Splunk and Sumo. holt's actions are CRUD over worktrees, which is exactly what this
 *     class is for.
 *   - ECS 8 (Elastic Common Schema) — Elasticsearch / OpenSearch / Filebeat, and Splunk via HEC.
 *   - CEF:0 (ArcSight Common Event Format) — the syslog line format QRadar, ArcSight, LogRhythm
 *     and Microsoft Sentinel's CEF connector all parse.
 *
 * Plus in-toto Statement v1 for the CHECKPOINT, which is the vehicle SLSA v1.1 names for
 * provenance and the thing an evidence pipeline already knows how to store.
 *
 * ESCAPING IS SECURITY HERE, NOT TIDINESS. A newline or a bare `=` inside a value forges a
 * second record in a line-oriented format — log injection, and this is an AUDIT log, where a
 * forged record is the entire threat. Every emitter below escapes; a test feeds each one a
 * hostile value and asserts the record count does not change.
 */

import { canonicalJson, entryLeaf } from './attest.mjs';

export const OCSF_VERSION = '1.7.0';
export const ECS_VERSION = '8.11.0';
export const SIEM_FORMATS = ['json', 'csv', 'ocsf', 'ecs', 'cef', 'intoto'];

/**
 * holt action → how each schema classifies it.
 *
 * `unprotect` is deliberately the HIGHEST severity of the six. It is the only action that
 * removes protection from work that exists nowhere else; every other entry here either creates
 * safety or destroys something already proven disposable.
 */
export const ACTION_MAP = {
  //                 ocsf activity   ecs event.type   cef sev  what it is
  unprotect: { activity: 3, ecsType: 'change', severity: 8, outcome: 'success', label: 'protection removed from a workstream' },
  blocked: { activity: 4, ecsType: 'deletion', severity: 6, outcome: 'failure', label: 'destructive command refused' },
  'clean-remove': { activity: 4, ecsType: 'deletion', severity: 5, outcome: 'success', label: 'disposable worktree removed' },
  'branch-delete': { activity: 4, ecsType: 'deletion', severity: 4, outcome: 'success', label: 'landed branch deleted' },
  rescue: { activity: 1, ecsType: 'creation', severity: 3, outcome: 'success', label: 'unique work captured to a ref' },
  protect: { activity: 3, ecsType: 'change', severity: 2, outcome: 'success', label: 'workstream locked against deletion' },
};
const DEFAULT_MAP = { activity: 99, ecsType: 'info', severity: 3, outcome: 'unknown', label: 'holt action' };

const mapOf = (action) => ACTION_MAP[action] ?? DEFAULT_MAP;
const OCSF_ACTIVITY_NAME = { 0: 'Unknown', 1: 'Create', 2: 'Read', 3: 'Update', 4: 'Delete', 99: 'Other' };

/** OCSF severity_id: 1 Informational · 2 Low · 3 Medium · 4 High · 5 Critical. */
function ocsfSeverity(sev) {
  if (sev >= 8) return 4;
  if (sev >= 6) return 3;
  if (sev >= 4) return 2;
  return 1;
}

const actorOf = (e) => e.actor ?? {};
const epoch = (e) => {
  const t = Date.parse(e.at ?? '');
  return Number.isFinite(t) ? t : null;
};

/** Everything that is not a structural field is carried through rather than dropped. */
const STRUCTURAL = new Set(['at', 'seq', 'prev', 'actor', 'action']);
function extras(e) {
  const o = {};
  for (const [k, v] of Object.entries(e)) if (!STRUCTURAL.has(k) && v !== undefined && v !== null) o[k] = v;
  return o;
}

/* =================================================================== OCSF ==== */

/**
 * One journal entry as an OCSF 1.7.0 API Activity (6003) event.
 * @param {any} e
 * @param {{repo?: string|null, product?: string, vendor?: string, version?: string|null}} [opts]
 */
export function toOcsf(e, { repo = null, product = 'holt', vendor = 'Contrare', version = null } = {}) {
  const m = mapOf(e.action);
  const a = actorOf(e);
  return {
    activity_id: m.activity,
    activity_name: OCSF_ACTIVITY_NAME[m.activity] ?? 'Other',
    category_uid: 6,
    category_name: 'Application Activity',
    class_uid: 6003,
    class_name: 'API Activity',
    type_uid: 6003 * 100 + m.activity,
    time: epoch(e),
    severity_id: ocsfSeverity(m.severity),
    status_id: m.outcome === 'failure' ? 2 : 1,
    status: m.outcome === 'failure' ? 'Failure' : 'Success',
    status_detail: e.reason ?? e.evidence ?? m.label,
    message: `${e.action ?? 'unknown'}: ${m.label}`,
    metadata: {
      version: OCSF_VERSION,
      product: { name: product, vendor_name: vendor, version: version ?? undefined },
      logged_time: epoch(e),
      // The leaf hash is a content-addressed, globally unique id for the record. Re-ingesting the
      // same log twice therefore de-duplicates on uid rather than doubling every count.
      uid: e.leaf ?? (typeof e.seq === 'number' ? `${e.prev ?? ''}:${e.seq}` : undefined),
      sequence: typeof e.seq === 'number' ? e.seq : undefined,
    },
    actor: {
      user: { name: a.user ?? 'unknown', type_id: a.agent && a.agent !== 'unknown' ? 3 : 1 },
      session: a.session && a.session !== 'unknown' ? { uid: a.session } : undefined,
      invoked_by: a.agent ?? 'unknown',
    },
    device: { hostname: a.host ?? 'unknown', type_id: 0 },
    api: {
      operation: e.action ?? 'unknown',
      service: { name: product },
      request: typeof e.seq === 'number' ? { uid: String(e.seq) } : undefined,
    },
    resources: [{
      name: e.id ?? e.name ?? e.branch ?? repo ?? 'unknown',
      type: 'git-worktree',
      uid: e.path ?? e.ref ?? e.commit ?? undefined,
    }],
    unmapped: { repo: repo ?? undefined, ...extras(e) },
  };
}

/* ==================================================================== ECS ==== */

/**
 * One journal entry as an ECS 8 document.
 * @param {any} e
 * @param {{repo?: string|null, version?: string|null}} [opts]
 */
export function toEcs(e, { repo = null, version = null } = {}) {
  const m = mapOf(e.action);
  const a = actorOf(e);
  return {
    '@timestamp': e.at ?? null,
    ecs: { version: ECS_VERSION },
    event: {
      kind: 'event',
      category: ['configuration'],
      type: [m.ecsType],
      action: e.action ?? 'unknown',
      outcome: m.outcome,
      severity: m.severity,
      module: 'holt',
      dataset: 'holt.journal',
      provider: a.agent ?? 'unknown',
      sequence: typeof e.seq === 'number' ? e.seq : undefined,
      id: e.leaf ?? undefined,
      reason: e.reason ?? e.evidence ?? m.label,
    },
    user: { name: a.user ?? 'unknown' },
    host: { name: a.host ?? 'unknown' },
    service: { name: 'holt', type: 'vcs', version: version ?? undefined },
    file: e.path ? { path: e.path } : undefined,
    labels: {
      repo: repo ?? undefined,
      workstream: e.id ?? e.name ?? undefined,
      branch: e.branch ?? undefined,
      ref: e.ref ?? undefined,
      commit: e.commit ?? undefined,
      session: a.session ?? undefined,
    },
    holt: extras(e),
  };
}

/* ==================================================================== CEF ==== */

// CEF header fields escape `\` and `|`; extension VALUES escape `\`, `=` and newlines. Getting
// this wrong is not a formatting bug, it is a record-forgery bug.
const cefHeader = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
const cefValue = (s) => String(s)
  .replace(/\\/g, '\\\\').replace(/=/g, '\\=')
  .replace(/\r\n|\r|\n/g, '\\n');

/**
 * One journal entry as a CEF:0 line (no trailing newline).
 * @param {any} e
 * @param {{repo?: string|null, product?: string, vendor?: string, version?: string|null}} [opts]
 */
export function toCef(e, { repo = null, product = 'holt', vendor = 'Contrare', version = '0' } = {}) {
  const m = mapOf(e.action);
  const a = actorOf(e);
  const ext = {
    rt: epoch(e) ?? '',
    duser: a.user ?? 'unknown',
    dvchost: a.host ?? 'unknown',
    suser: a.agent ?? 'unknown',
    // CEF has no "agent session" key; cs1/cs2 with their Labels is the standard custom-string
    // mechanism and every CEF parser understands it.
    cs1Label: 'holtSession', cs1: a.session ?? 'unknown',
    cs2Label: 'holtWorkstream', cs2: e.id ?? e.name ?? '',
    cs3Label: 'holtRepo', cs3: repo ?? '',
    cs4Label: 'holtEntryHash', cs4: e.leaf ?? '',
    cn1Label: 'holtSeq', cn1: typeof e.seq === 'number' ? e.seq : '',
    fname: e.path ?? '',
    outcome: m.outcome,
    reason: e.reason ?? (Array.isArray(e.evidence) ? e.evidence.join('; ') : e.evidence) ?? m.label,
  };
  // A csNLabel with no csN beside it is a broken CEF record — the label names a field that is
  // not there, and some parsers reject the line outright. FOUND IN A LIVE RUN: cs4Label appeared
  // alone whenever the entry hash was absent. Drop label and value together, always.
  const present = (k, v) => {
    if (v === '' || v === null || v === undefined) return false;
    const m = /^(cs\d|cn\d)Label$/.exec(k);
    if (m) { const pair = ext[m[1]]; return pair !== '' && pair !== null && pair !== undefined; }
    return true;
  };
  const extension = Object.entries(ext)
    .filter(([k, v]) => present(k, v))
    .map(([k, v]) => `${k}=${cefValue(v)}`)
    .join(' ');
  return [
    'CEF:0', cefHeader(vendor), cefHeader(product), cefHeader(version),
    cefHeader(e.action ?? 'unknown'), cefHeader(m.label), String(m.severity),
  ].join('|') + `|${extension}`;
}

/* ================================================================ in-toto ==== */

/**
 * The CHECKPOINT as an in-toto Statement v1 — the envelope SLSA v1.1 names, so an evidence
 * pipeline that already stores attestations can store this one without a new integration.
 * The subject is the Merkle root: the single digest that pins the whole log at that size.
 */
export const HOLT_PREDICATE_TYPE = 'https://holt.dev/attestation/journal-checkpoint/v1';

/**
 * @param {any} verification
 * @param {{repo?: string|null, product?: string, version?: string|null}} [opts]
 */
export function toInToto(verification, { repo = null, product = 'holt', version = null } = {}) {
  const cp = verification.checkpoint ?? {};
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{
      name: cp.origin ?? `holt.dev/journal/${repo ?? 'repo'}`,
      digest: { sha256: verification.root ?? cp.root ?? null },
    }],
    predicateType: HOLT_PREDICATE_TYPE,
    predicate: {
      format: 'c2sp.org/tlog-checkpoint',
      hashAlgorithm: 'RFC6962-SHA256',
      origin: cp.origin ?? null,
      treeSize: verification.size ?? cp.size ?? 0,
      rootHash: verification.root ?? cp.root ?? null,
      verified: verification.ok === true,
      verificationCode: verification.code ?? null,
      unchainedLegacyEntries: verification.legacy ?? 0,
      signedBy: cp.signers ?? [],
      producer: { name: product, version: version ?? null },
      repo: repo ?? null,
    },
  };
}

/* ================================================================ EXPORT ==== */

/**
 * Render a whole journal in one format. Returns a string ready to write or pipe.
 *
 * REFUSES TO EXPORT A LOG THAT DOES NOT VERIFY unless `force` is set — an audit export whose
 * integrity is unknown is worse than none, because downstream it is indistinguishable from one
 * that checked out. When forced, every record carries `holt.integrity` saying so, so the SIEM
 * itself can alert on it rather than the warning being lost on a terminal nobody read.
 */
/**
 * @param {any[]} events
 * @param {string} format
 * @param {{verification?: any, repo?: string|null, version?: string|null, force?: boolean, ndjson?: boolean}} [opts]
 */
export function exportJournal(events, format, {
  verification = null, repo = null, version = null, force = false, ndjson = true,
} = {}) {
  const fmt = String(format ?? '').toLowerCase();
  if (!SIEM_FORMATS.includes(fmt)) {
    throw new Error(`unknown export format '${format}' (${SIEM_FORMATS.join(' | ')})`);
  }
  const broken = verification && verification.ok === false;
  if (broken && !force && fmt !== 'intoto') {
    const err = Object.assign(new Error(
      `refusing to export: this journal does not verify (${verification.code}) — ${verification.reason}`),
      { code: 'EINTEGRITY', verification });
    throw err;
  }
  const integrity = verification
    ? { verified: verification.ok, code: verification.code, root: verification.root }
    : { verified: null, code: 'not-checked', root: null };

  // Attach each record's RFC 6962 leaf hash. It is the record's content address, so it becomes
  // the id every format carries (OCSF metadata.uid, ECS event.id, CEF cs4) — which is what lets a
  // SIEM de-duplicate a re-ingested log instead of doubling every count, and what joins a record
  // in Splunk back to an offline `holt journal --prove` proof. It is derived, never stored, so
  // computing it here is the only place it can come from.
  const list = events.filter((e) => e && e.corrupt === undefined)
    .map((e) => (typeof e.seq === 'number' ? { ...e, leaf: entryLeaf(e).toString('hex') } : e));

  if (fmt === 'intoto') {
    return `${JSON.stringify(toInToto(verification ?? {}, { repo, version }), null, 2)}\n`;
  }
  if (fmt === 'json') {
    return `${JSON.stringify({
      exportedAt: new Date().toISOString(), repo, count: list.length, integrity, events: list,
    }, null, 2)}\n`;
  }
  if (fmt === 'csv') {
    const cols = ['at', 'seq', 'action', 'actor.user', 'actor.host', 'actor.agent', 'actor.session',
      'id', 'name', 'path', 'branch', 'ref', 'commit', 'reason', 'evidence', 'prev'];
    const get = (e, c) => (c.startsWith('actor.') ? actorOf(e)[c.slice(6)] : e[c]);
    // FOUND BY ATTACKING THIS FILE. RFC 4180 permits a newline INSIDE a quoted field, and the
    // first version of this emitter did exactly that — producing a single logical record that
    // spanned five physical lines. Every log shipper and `wc -l`-shaped ingest pipeline in
    // existence would read those as five audit records, four of them attacker-authored. So a
    // newline is escaped to the two characters \n and the record stays exactly one line. The
    // value is preserved (recoverable, never dropped); the record boundary is not negotiable.
    const esc = (v) => {
      if (v == null) return '';
      const s = (Array.isArray(v) ? v.join('; ') : String(typeof v === 'object' ? canonicalJson(v) : v))
        .replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n');
      return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [cols.join(','), ...list.map((e) => cols.map((c) => esc(get(e, c))).join(','))].join('\n') + '\n';
  }
  if (fmt === 'cef') {
    return list.map((e) => `${toCef(e, { repo, version })}${broken ? ` holtIntegrity=${cefValue(integrity.code)}` : ''}`)
      .join('\n') + (list.length ? '\n' : '');
  }
  // OCSF and ECS are NDJSON by default: that is what every log shipper on earth tails.
  const render = fmt === 'ocsf' ? toOcsf : toEcs;
  const docs = list.map((e) => {
    const d = render(e, { repo, version });
    if (broken) {
      if (fmt === 'ocsf') d.unmapped = { ...d.unmapped, holt_integrity: integrity };
      else d.holt = { ...d.holt, integrity };
    }
    return d;
  });
  return ndjson
    ? docs.map((d) => JSON.stringify(d)).join('\n') + (docs.length ? '\n' : '')
    : `${JSON.stringify(docs, null, 2)}\n`;
}
