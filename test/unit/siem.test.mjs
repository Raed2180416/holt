/**
 * holt — SIEM export, attacked.
 *
 * An export whose escaping is wrong is not a cosmetic bug. Every format here is line- or
 * key=value-oriented, so a newline or a bare `=` inside a value FORGES A SECOND AUDIT RECORD in
 * the destination system. This is an audit log: a forged record is the entire threat model. So
 * the central test below feeds each emitter a value engineered to break out of its own record
 * and asserts the record COUNT does not move.
 *
 * The other property that matters: the export must refuse a log that does not verify. Feeding a
 * SIEM records from a possibly-rewritten journal launders the tampering — downstream it is
 * indistinguishable from a clean one, and the SIEM is the copy the auditor will believe.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toOcsf, toEcs, toCef, toInToto, exportJournal, ACTION_MAP, OCSF_VERSION, SIEM_FORMATS,
} from '../../src/siem.mjs';

const actor = { user: 'alice', host: 'lab-7', agent: 'claude-code', session: 'sess-1' };
const EVENTS = [
  { at: '2026-08-01T10:00:00.000Z', seq: 0, prev: '0'.repeat(64), actor, action: 'protect', id: 'wt-a', path: '/r/wt-a', reason: 'holt: holds work found nowhere else', leaf: 'aa11' },
  { at: '2026-08-01T10:05:00.000Z', seq: 1, prev: 'aa11', actor, action: 'unprotect', id: 'wt-a', path: '/r/wt-a', reason: 'holt: holds work found nowhere else', forced: false, leaf: 'bb22' },
  { at: '2026-08-01T10:06:00.000Z', seq: 2, prev: 'bb22', actor, action: 'blocked', command: 'rm -rf wt-a', reason: 'holds unique work', leaf: 'cc33' },
];
const OK = { ok: true, code: 'ok', root: 'deadbeef', size: 3, checkpoint: { origin: 'holt.dev/journal/r', size: 3, root: 'deadbeef', signed: false, signers: [] } };
const BROKEN = { ok: false, code: 'prev-mismatch', reason: 'entry 2 was edited', root: 'x', size: 3, legacy: 0, checkpoint: null, broken: { line: 2 } };

/* ------------------------------------------------------------------- OCSF ---- */

test('OCSF: API Activity 6003 in category 6, with type_uid = class_uid*100 + activity_id', () => {
  for (const e of EVENTS) {
    const d = toOcsf(e, { repo: '/r' });
    assert.equal(d.class_uid, 6003);
    assert.equal(d.category_uid, 6);
    assert.equal(d.type_uid, 6003 * 100 + d.activity_id, 'type_uid is not derived from the class and activity');
    assert.equal(d.metadata.version, OCSF_VERSION);
    assert.equal(d.time, Date.parse(e.at));
    assert.ok(d.metadata.uid, 'every record needs a stable id so re-ingestion de-duplicates');
    assert.equal(d.actor.user.name, 'alice');
    assert.equal(d.device.hostname, 'lab-7');
    assert.equal(d.api.operation, e.action);
  }
});

test('OCSF: a REFUSED destructive command is a Delete that FAILED — not a success', () => {
  const d = toOcsf(EVENTS[2]);
  assert.equal(d.activity_id, 4, 'a blocked rm must map to Delete');
  assert.equal(d.status_id, 2, 'the delete did not happen, so its status is Failure');
  assert.equal(d.status, 'Failure');
});

test('OCSF: unprotect is the highest-severity action holt emits', () => {
  const sev = (a) => toOcsf({ ...EVENTS[0], action: a }).severity_id;
  const others = Object.keys(ACTION_MAP).filter((a) => a !== 'unprotect');
  for (const a of others) {
    assert.ok(sev('unprotect') >= sev(a), `'${a}' is rated at or above unprotect — releasing protection must rank highest`);
  }
  assert.ok(sev('unprotect') > sev('protect'));
});

/* -------------------------------------------------------------------- ECS ---- */

test('ECS: the core fields an Elastic pipeline indexes on are all present and correctly typed', () => {
  const d = toEcs(EVENTS[1], { repo: '/r' });
  assert.equal(d['@timestamp'], EVENTS[1].at);
  assert.equal(d.event.action, 'unprotect');
  assert.equal(d.event.dataset, 'holt.journal');
  assert.equal(d.event.module, 'holt');
  assert.ok(Array.isArray(d.event.category) && Array.isArray(d.event.type), 'ECS category/type must be arrays');
  assert.equal(d.user.name, 'alice');
  assert.equal(d.host.name, 'lab-7');
  assert.equal(d.file.path, '/r/wt-a');
  assert.equal(d.labels.session, 'sess-1');
  assert.equal(d.event.outcome, 'success');
  assert.equal(toEcs(EVENTS[2]).event.outcome, 'failure', 'a refused command is not a successful one');
});

/* -------------------------------------------------------------------- CEF ---- */

test('CEF:0 header has exactly seven pipe-delimited fields before the extension', () => {
  const line = toCef(EVENTS[0], { repo: '/r' });
  assert.ok(line.startsWith('CEF:0|'));
  const head = line.split('|').slice(0, 7);
  assert.equal(head.length, 7);
  assert.equal(head[0], 'CEF:0');
  assert.equal(head[4], 'protect', 'the signature id must be the action');
  assert.match(head[6], /^\d+$/, 'severity must be numeric');
  assert.match(line, /duser=alice/);
  assert.match(line, /cs1Label=holtSession cs1=sess-1/);
});

test('FOUND IN A LIVE RUN: no CEF label may appear without its value beside it', () => {
  // cs4Label=holtEntryHash was emitted alone whenever the entry hash was absent. A label naming
  // a field that is not present is a broken CEF record, and some parsers reject the line.
  const line = toCef({ at: '2026-08-01T10:00:00.000Z', actor, action: 'protect' });
  for (const m of line.matchAll(/\b(cs\d|cn\d)Label=/g)) {
    assert.match(line, new RegExp(`\\b${m[1]}=[^ ]`), `${m[1]}Label was emitted with no ${m[1]} value`);
  }
  // And every value that IS emitted must have its label, or the field is unnamed.
  for (const m of line.matchAll(/\b(cs\d|cn\d)=/g)) {
    assert.match(line, new RegExp(`\\b${m[1]}Label=`), `${m[1]} was emitted with no label`);
  }
});

test('every exported record carries its RFC 6962 leaf hash as the de-duplication id', () => {
  // The hash is DERIVED, never stored, so if the export does not compute it the id silently
  // degrades to something non-unique — and a SIEM re-ingesting the log doubles every count.
  const chained = EVENTS.map(({ leaf, ...rest }) => rest); // strip the pre-set ids
  const ocsf = exportJournal(chained, 'ocsf', { verification: OK }).trim().split('\n').map((l) => JSON.parse(l));
  const ids = ocsf.map((d) => d.metadata.uid);
  assert.equal(new Set(ids).size, 3, 'exported ids are not unique per record');
  for (const id of ids) assert.match(id, /^[0-9a-f]{64}$/, `id is not a SHA-256 digest: ${id}`);

  const ecs = exportJournal(chained, 'ecs', { verification: OK }).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(ecs.map((d) => d.event.id), ids, 'ECS and OCSF disagree about a record id');
  const cef = exportJournal(chained, 'cef', { verification: OK }).trim().split('\n');
  for (const [i, l] of cef.entries()) assert.ok(l.includes(`cs4=${ids[i]}`), 'CEF carries no entry hash');
});

/* ------------------------------------------------------- THE INJECTION TEST ---- */

test('ATTACK: a hostile value cannot forge an extra record in ANY line-oriented format', () => {
  // Every one of these is a real break-out attempt for the format it targets.
  const hostile = {
    at: '2026-08-01T11:00:00.000Z',
    seq: 0,
    prev: '0'.repeat(64),
    actor: { user: 'eve', host: 'h', agent: 'a', session: 's' },
    action: 'unprotect',
    id: 'wt-x',
    // CEF break-out: a literal newline plus a whole forged CEF header, and a bare `=`.
    reason: 'benign\nCEF:0|Evil|Evil|1|forged|TOTALLY FINE|0|duser=root\nkey=value',
    // NDJSON break-out: a newline plus a complete forged JSON document.
    path: '/r/x\n{"event":{"action":"nothing-happened"}}',
  };

  for (const fmt of ['cef', 'ocsf', 'ecs', 'csv']) {
    const overhead = fmt === 'csv' ? 1 : 0; // CSV's one header line, and nothing else
    for (const n of [1, 3]) {
      const text = exportJournal(Array(n).fill(hostile), fmt, { verification: OK, repo: '/r' });
      const lines = text.split('\n').filter(Boolean).length;
      assert.equal(lines, n + overhead,
        `${fmt}: ${n} journal entry(ies) produced ${lines - overhead} record(s) — a value broke out of its record`);
    }
  }

  // Prove the instrument can detect presence: the SAME payload, emitted without escaping, DOES
  // forge extra records. Without this, the assertions above could be passing for the wrong reason.
  const unescaped = `CEF:0|v|p|1|${hostile.action}|x|5|reason=${hostile.reason}`;
  assert.ok(unescaped.split('\n').length > 1,
    'the hostile payload does not actually contain a break-out — this test proves nothing as written');

  // The escaped forms must still carry the information, not silently drop it.
  const cef = exportJournal([hostile], 'cef', { verification: OK });
  assert.match(cef, /\\n/, 'the newline was dropped rather than escaped — evidence must survive');
  assert.match(cef, /\\=/, 'a bare = in a CEF value was not escaped');
  const ecs = JSON.parse(exportJournal([hostile], 'ecs', { verification: OK }).trim());
  assert.ok(ecs.event.reason.includes('CEF:0|Evil'), 'ECS dropped the hostile text instead of carrying it safely');
});

/* ------------------------------------------------------------- INTEGRITY ---- */

test('a journal that does not VERIFY refuses to export, in every format', () => {
  for (const fmt of SIEM_FORMATS.filter((f) => f !== 'intoto')) {
    assert.throws(() => exportJournal(EVENTS, fmt, { verification: BROKEN }),
      (e) => e.code === 'EINTEGRITY' && /does not verify/.test(e.message),
      `${fmt} exported records from a log that failed verification`);
  }
});

test('--force exports anyway, and STAMPS every record with the integrity failure', () => {
  // The warning must live in the data, not on a terminal nobody read: the SIEM has to be able
  // to alert on it.
  const ocsf = exportJournal(EVENTS, 'ocsf', { verification: BROKEN, force: true })
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(ocsf.length, 3);
  for (const d of ocsf) assert.equal(d.unmapped.holt_integrity.code, 'prev-mismatch');

  const ecs = exportJournal(EVENTS, 'ecs', { verification: BROKEN, force: true })
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (const d of ecs) assert.equal(d.holt.integrity.verified, false);

  const cef = exportJournal(EVENTS, 'cef', { verification: BROKEN, force: true });
  assert.match(cef, /holtIntegrity=prev-mismatch/);

  const json = JSON.parse(exportJournal(EVENTS, 'json', { verification: BROKEN, force: true }));
  assert.equal(json.integrity.verified, false);
});

test('in-toto: the checkpoint as a Statement v1, subject = the Merkle root', () => {
  const s = toInToto(OK, { repo: 'r', version: '0.2.0' });
  assert.equal(s._type, 'https://in-toto.io/Statement/v1');
  assert.equal(s.subject[0].digest.sha256, 'deadbeef');
  assert.equal(s.predicate.format, 'c2sp.org/tlog-checkpoint');
  assert.equal(s.predicate.hashAlgorithm, 'RFC6962-SHA256');
  assert.equal(s.predicate.treeSize, 3);
  assert.equal(s.predicate.verified, true);
  // in-toto is the ONE format allowed to describe a broken log, because describing the failure
  // IS its content — it is an attestation about the log, not a copy of the log's records.
  const bad = JSON.parse(exportJournal([], 'intoto', { verification: BROKEN }));
  assert.equal(bad.predicate.verified, false);
  assert.equal(bad.predicate.verificationCode, 'prev-mismatch');
});

test('an unknown format is refused by name rather than silently producing JSON', () => {
  assert.throws(() => exportJournal(EVENTS, 'splunk', { verification: OK }), /unknown export format/);
  assert.throws(() => exportJournal(EVENTS, '', { verification: OK }), /unknown export format/);
});

test('CSV carries the actor columns — a trail without WHO is the thing this replaces', () => {
  const csv = exportJournal(EVENTS, 'csv', { verification: OK });
  const [header, ...rows] = csv.trim().split('\n');
  for (const c of ['actor.user', 'actor.host', 'actor.agent', 'actor.session', 'seq', 'prev']) {
    assert.ok(header.split(',').includes(c), `CSV export lost the '${c}' column`);
  }
  assert.equal(rows.length, EVENTS.length);
  assert.ok(rows[1].includes('unprotect'));
  assert.ok(rows[1].includes('alice'));
});
