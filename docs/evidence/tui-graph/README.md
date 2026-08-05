# Holt TUI and relationship-graph product audit — 2026-08-05

## Verdict

The TUI and both graph surfaces are **genuinely useful product features**, not decorative demos.
Together they answer two different questions well:

1. **TUI:** “What work is in danger right now, what exactly would be lost, and what is the safe
   next command?”
2. **Graph:** “Which workstreams are entangled, why, and which can be reasoned about independently?”

The final evidence supports marketing those concrete outcomes. The first hands-on pass found four
release-relevant defects that the existing green test corpus missed. All four were fixed, rebuilt
into a fresh real-Git fixture, and independently re-exercised in Chromium and a PTY. A regression
introduced by the first keyboard-filter fix was also caught in the intermediate run, fixed, and
revalidated. For the audited functionality, the TUI and graph are release-ready; the remaining
items are non-blocking visual-density polish and are stated plainly below.

## Scope and denominators

| Surface | Controlled ground-truth repo | Live Grove repo |
|---|---:|---:|
| Workstreams | 10/10 scanned | 9/9 scanned |
| Families | 3 | 4 |
| Graph relationships | 10 | 67 |
| Proven collisions | 1 expected, 1 found | 27 |
| Duplicate pairs | 2 expected, 2 found | 35 |
| TUI snapshots | 120×36 and 80×20 | 120×36 and 80×20 |
| Exports | terminal, JSON, standalone HTML | terminal, JSON, standalone HTML |

Ten shipped-CLI invocations were retained: two TUI sizes plus text graph, JSON graph, and HTML
graph on each repository. The final HTML export was exercised in Chromium 150 at 1440×900:
search, slash shortcut, Escape reset, decision filters, relationship filters, hover trace,
click-to-pin, sidebar scroll, zoom, keyboard traversal, network requests, and screenshots. The
focused automated corpus passed **28/28**, with zero failures, skips, or todos. Typecheck also
finished with zero diagnostics.

The controlled fixture is retained at:

```text
/home/raed/.cache/holt-tui-graph-audit/fixture-2026-08-05-final/repo
```

It contains two uncommitted-only workstreams, five committed holders, one real collision pair,
two exactly redundant twins, one cross-dispatch duplicate implementation pair, and one genuinely
empty worktree. Independent `git merge-tree --write-tree` returned exit 1 and a content conflict
for the collision pair; it returned exit 0 for the redundant twins. Holt then found the exact
10 nodes, the same collision, the same duplicate pair, and both conditional-redundancy links.

Full final machine-readable evidence is in
[oracle-and-measurements.json](run-2026-08-05-final/oracle-and-measurements.json) and
[browser-observations.json](run-2026-08-05-final/browser-observations.json). The original and
intermediate runs remain intact so the before/fix/regression/final chain can be audited.

## What is materially useful

### TUI: strong for immediate human triage

- Risk sorting is the core value. The only-copy, uncommitted workstreams are first without a user
  having to interpret Git state.
- The selected pane names the exact unique symbols and whether they are committed, untracked, or
  uncommitted. This turns an alarm into inspectable evidence.
- It distinguishes a genuinely empty worktree from one that is disposable only while a redundant
  sibling survives (`● DISPOSABLE` versus `◐ DISPOSABLE*`). That distinction prevents a plausible
  “delete every green row” failure.
- It ends with the concrete resolving command. For unsafe work it points to `holt rescue ...
  --release`; for clean work it accurately says quarantine is recoverable and retains the branch.
- `j` changed selection, `f` narrowed the real model from `all` to `atRisk`, and `q` restored the
  cursor and main screen. No mutating key was used. The uppercase, two-press dry-run design keeps
  accidental actions out of ordinary navigation.
- `--snapshot` uses the production renderer and exits, so this surface can be tested and attached
  to review artifacts rather than trusted by eye.

![Controlled 120-column TUI](run-2026-08-05-final/controlled-tui-120x36.png)

### Terminal graph: the best basic-user graph

The terminal graph deliberately renders connected components rather than a force-directed ASCII
hairball. On the fixture it immediately separated:

- the proven payments conflict;
- the conditional redundant twins;
- the duplicated implementation pair; and
- four independent workstreams that can be reasoned about separately.

On live Grove it reduced 67 raw relationships to one nine-member tangle, printed the highest-value
16 relationships, and explicitly disclosed that 20 more were omitted with the command that lists
them all. This is a useful, low-annoyance default for both basic users and agents reading terminal
output.

### HTML graph: useful for advanced exploration

- It is a single offline file. Browser instrumentation observed **zero resource requests** after
  the document itself; there are no CDN, font, telemetry, or API dependencies.
- Proven conflicts are visible by default while duplicate and family edges are opt-in. On the
  fixture, enabling duplicates added exactly two dashed edges (1 → 3 total), avoiding default
  clutter while preserving deeper inspection.
- `/` focuses search. Searching `collision-payments` left exactly the two intended labels opaque
  and dimmed the other eight nodes; Escape restored all ten.
- The risk and disposable decision rows are real keyboard controls. Enter on risk selected the
  exact 2/10 at-risk nodes; Space on disposable selected the exact 3/10 safe nodes; focus remained
  on the control through SVG redraw. A mouse click produced the same risk result.
- Every node is a focusable button with a descriptive accessible name. Enter pinned node 0,
  ArrowRight moved to node 1, ArrowLeft returned to node 0, and focus survived each redraw.
- Hover tracing and click-to-pin expose branch, verdict, committed/uncommitted counts, unique work,
  and relationship reasons. Pinning remained stable when the pointer moved away.
- Zoom changed the SVG transform from scale 1.000 to 1.120, and pan/drag affordances are explained
  in-place.
- Conditional redundancy has its own dashed ring and explicit warning, so it cannot be mistaken
  for an empty green node.

![Default controlled graph](run-2026-08-05-final/controlled-graph-default.png)

![Duplicate relationships enabled](run-2026-08-05-final/controlled-graph-duplicates-enabled.png)

![Search isolates the exact pair](run-2026-08-05-final/controlled-graph-search.png)

![Keyboard focus is visible on the selected node](run-2026-08-05-final/controlled-graph-keyboard-focus.png)

The live Grove view proves the renderer remains legible on a dense, genuinely messy checkout, and
the hover detail turns the dense subgraph into a per-node explanation:

![Live Grove graph](run-2026-08-05-final/live-grove-graph-default.png)

![Live Grove relationship detail](run-2026-08-05-final/live-grove-graph-node-detail.png)

## Defects found, fixed, and independently revalidated

### P1 — Fixed: TUI frames exceeded their physical terminal width

The original 120×36 controlled summary measured 128 visible columns. At 80×20, the controlled
header/summary/footer/provenance measured 90/128/98/120; the live summary/footer/provenance
measured 94/97/120. Real terminals wrapped those logical lines into extra physical rows:

![Original 80-column wrap defect](run-2026-08-05/controlled-tui-80x20-wrap-defect.png)

The final renderer applies ANSI-safe, width-aware clipping to the full frame. Fresh measurements
on both repositories are exact and have no overflow:

| Repository | Requested frame | Logical rows | Maximum visible width | Overflow rows |
|---|---:|---:|---:|---:|
| Controlled | 120×36 | 36 | 120 | 0 |
| Controlled | 80×20 | 20 | 80 | 0 |
| Live Grove | 120×36 | 36 | 120 | 0 |
| Live Grove | 80×20 | 20 | 80 | 0 |

![Final 80-column TUI](run-2026-08-05-final/controlled-tui-80x20.png)

The focused corpus now contains a real 80×20 physical-row regression and an incomplete-ANSI
regression; both passed.

### P1 — Fixed: HTML graph understated committed held work

The original HTML graph colored the two committed, symbol-free payments branches gray even though
the TUI correctly classified them as `HOLDS`. The final graph derives color from the decision
contract: the two at-risk nodes are red, all five holders—including both payments branches—are
yellow, and the three disposable nodes are green. The controlled browser oracle checked every
node by name and fill.

### P2 — Fixed: node detail silently truncated relationships

The original live detail declared `edges (15)` but rendered 14. The final live page rendered
**15/15**, including the last `duplicate wf_28cc3a43-545-4` row. The display cap now discloses any
larger remainder and the command for exhaustive output; the automated cap regression passed.

### P2 — Fixed: graph nodes were mouse-only

All 10 final controlled nodes have `tabindex="0"`, `role="button"`, and a descriptive
`aria-label`. Enter pins, ArrowRight/ArrowLeft traverse, focus survives redraw, and the focused
node has a visible ring. Risk/disposable summary rows also work with Enter/Space and preserve
focus. Exact decision results were 2 risk and 3 disposable—the independently expected sets.

### Intermediate regression caught before sign-off

The first keyboard-filter fix coerced a missing node index with `Number(null)`, which selected node
0 and made the risk filter show 8 nodes instead of 2. The intermediate artifact retained in
[`run-2026-08-05-postfix/`](run-2026-08-05-postfix/) reproduces it. The final build no longer
coerces missing focus to node 0 and clears node emphasis before applying a decision filter. Fresh
keyboard and mouse trials both selected the exact expected sets.

## Residual non-blocking polish

- **TUI selection emphasis:** the inverse-video row is reset by the colored marker, so only the
  first cell appears inverted. Navigation and detail correctness are unaffected, but a whole-row
  focus treatment would be clearer.
- **80-column information density:** the frame no longer wraps or emits broken ANSI, but long
  header/detail text and part of the summary are intentionally ellipsized. It remains a safe
  fallback; 100–120 columns expose the fuller explanation.
- **Small-graph fit:** at 1440×900 the ten-node fixture leaves substantial empty canvas. Search,
  decision filters, and focus make it usable, but fit-to-visible-nodes would improve first-glance
  clarity.

## Honest product story

Claims supported by the final evidence:

- **“See the only-copy work first.”** The TUI ranks work by loss risk and names the bytes/symbols
  that justify the verdict.
- **“Understand the tangle without reading every pair.”** The terminal graph groups entangled and
  independent workstreams, preserves why each visible edge exists, bounds noise, and discloses
  omissions.
- **“Explore the full relationship map offline.”** The HTML export is self-contained, searchable,
  filterable, zoomable, keyboard-operable, and keeps exact per-node evidence one click or keypress
  away.
- **“Conditional safety is visible.”** Empty and redundant-safe worktrees are different in all
  three surfaces.

The graph should not be marketed as a generic “AI work graph.” Its defensible advantage is that
every node and relationship is tied to Holt’s concrete preservation, collision, duplicate, and
landing evidence. That is both easier to understand and more valuable in an agentic workflow.

## Reproduction

Build a fresh retained fixture and artifact directory without overwriting this run:

```bash
HOLT_TUI_GRAPH_RUN=run-YYYY-MM-DD-audit \
HOLT_TUI_GRAPH_FIXTURE=/home/raed/.cache/holt-tui-graph-audit/fixture-YYYY-MM-DD-audit \
node docs/evidence/tui-graph/build-audit-fixture.mjs
```

The builder refuses to overwrite either path and never removes a worktree. Focused regression
corpus used during the audit:

```bash
node --test test/e2e/tui.test.mjs test/e2e/graph-html.test.mjs test/unit/ascii-graph.test.mjs
```

Final result: 28 passed, 0 failed, 0 skipped, 0 todo. `npm run typecheck` reported zero
diagnostics.
