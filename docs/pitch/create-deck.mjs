import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const artifactToolPath = process.env.ARTIFACT_TOOL_PATH;
if (!artifactToolPath) throw new Error("ARTIFACT_TOOL_PATH is required");
const { Presentation, PresentationFile } = await import(artifactToolPath);

const here = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(here, "Holt-Preseed-Deck-2026-08-11.pptx");

const W = 1280;
const H = 720;
const C = {
  canvas: "#F7F5EF",
  ink: "#10231D",
  muted: "#66736E",
  rule: "#C8CEC9",
  panel: "#E9ECE7",
  green: "#173F35",
  mint: "#CDE4D8",
  orange: "#D66A4A",
  white: "#FFFFFF",
};

const deck = Presentation.create({ slideSize: { width: W, height: H } });

function box(slide, x, y, w, h, { fill = "none", line = "none", radius = false } = {}) {
  return slide.shapes.add({
    geometry: radius ? "roundRect" : "rect",
    position: { left: x, top: y, width: w, height: h },
    fill,
    line: line === "none" ? { style: "solid", fill: "none", width: 0 } : { style: "solid", fill: line, width: 1 },
  });
}

function label(slide, value, x, y, w, h, size = 18, options = {}) {
  const shape = slide.shapes.add({
    geometry: "textbox",
    position: { left: x, top: y, width: w, height: h },
    fill: "none",
    line: { style: "solid", fill: "none", width: 0 },
  });
  shape.text = value;
  shape.text.style = {
    fontSize: size,
    typeface: "Helvetica Neue",
    color: options.color || C.ink,
    bold: Boolean(options.bold),
    alignment: options.align || "left",
    verticalAlignment: options.valign || "top",
    autoFit: "shrinkText",
  };
  return shape;
}

function base(kicker, page) {
  const slide = deck.slides.add();
  slide.background.fill = C.canvas;
  label(slide, kicker.toUpperCase(), 42, 30, 720, 26, 13, { bold: true, color: C.green });
  label(slide, String(page).padStart(2, "0"), 1180, 30, 58, 26, 13, { align: "right", color: C.muted });
  box(slide, 42, 67, 1196, 1, { fill: C.rule });
  return slide;
}

function title(slide, value, subtitle) {
  label(slide, value, 42, 92, 1120, 96, 46, { bold: true });
  if (subtitle) label(slide, subtitle, 42, 186, 1080, 54, 20, { color: C.muted });
}

function note(slide, body, sources = []) {
  const lines = [body, "", "[Sources]", ...sources.map((source) => `- ${source}`), "[/Sources]"];
  slide.speakerNotes.textFrame.setText(lines.join("\n"));
  slide.speakerNotes.setVisible(true);
}

function footer(slide, value = "HOLT / PRE-SEED / AUGUST 2026") {
  label(slide, value, 42, 682, 800, 18, 11, { bold: true, color: C.muted });
}

// 1 — cover, adapted from Codex Grid slide 01 (sparse stacked title flow).
{
  const slide = deck.slides.add();
  slide.background.fill = C.green;
  label(slide, "HOLT", 42, 35, 400, 36, 16, { bold: true, color: C.mint });
  label(slide, "Parallel agents need\na transaction layer.", 42, 150, 1050, 230, 68, { bold: true, color: C.white });
  label(slide, "Holt makes destructive repository action inspectable, recoverable, and accountable before the damage becomes a PR.", 42, 455, 760, 110, 26, { color: C.mint });
  box(slide, 1010, 470, 170, 170, { fill: C.orange });
  label(slide, "PRE-SEED\nAUG 2026", 1034, 505, 124, 80, 18, { bold: true, color: C.white, align: "center", valign: "middle" });
  note(slide, "Open with the category change: coding agents can create work faster than repositories can safely coordinate it. Holt is not another agent; it is the independent transaction layer around them.", ["https://git-scm.com/docs/git-worktree", "https://github.com/Raed2180416/holt"]);
}

// 2 — problem, three-column layout.
{
  const slide = base("The problem", 2);
  title(slide, "The failure happens before CI.", "Multiple agents share one repository, but Git still sees files and branches—not intent, ownership, or safe cleanup authority.");
  const xs = [42, 449, 856];
  const heads = ["RELATE", "PROTECT", "RECOVER"];
  const bodies = [
    "Which worktree, branch, stash, receipt, and uncommitted bytes belong to the same task?",
    "Is cleanup actually safe, or is unique work hidden behind a plausible command?",
    "If an action fails halfway, what can be restored—and what remains in doubt?",
  ];
  for (let i = 0; i < 3; i += 1) {
    box(slide, xs[i], 286, 360, 270, { fill: i === 1 ? C.mint : C.panel });
    label(slide, `0${i + 1}`, xs[i] + 24, 310, 50, 32, 16, { bold: true, color: C.orange });
    label(slide, heads[i], xs[i] + 24, 360, 300, 36, 24, { bold: true });
    label(slide, bodies[i], xs[i] + 24, 414, 306, 110, 19, { color: C.muted });
  }
  footer(slide);
  note(slide, "Git worktrees are powerful primitives, but the coordination and recovery semantics around many autonomous workers are left to scripts and human memory. Holt focuses on that missing seam.", ["https://git-scm.com/docs/git-worktree", "https://github.com/Raed2180416/holt/blob/main/docs/FEATURE-PROOF-MATRIX.md"]);
}

// 3 — category shift, large message with callouts.
{
  const slide = base("Why now", 3);
  label(slide, "Agents are multiplying execution.", 42, 104, 770, 80, 46, { bold: true });
  label(slide, "The repository safety model did not multiply with them.", 42, 188, 980, 90, 36, { color: C.orange, bold: true });
  const items = [
    ["MORE ACTORS", "Parallel workers create branches, worktrees, patches, receipts, and interrupted state."],
    ["MORE VELOCITY", "Automation compresses the time between a proposal and a destructive command."],
    ["SAME AUTHORITY GAP", "The acting agent is still often asked to judge whether its own cleanup is safe."],
  ];
  items.forEach(([h, b], i) => {
    const x = 42 + i * 400;
    box(slide, x, 355, 360, 205, { fill: C.panel });
    label(slide, h, x + 22, 380, 310, 28, 16, { bold: true, color: C.green });
    label(slide, b, x + 22, 430, 310, 98, 18, { color: C.muted });
  });
  footer(slide);
  note(slide, "The wedge exists because agent concurrency changes repository risk. The investor claim is a structural category thesis, not a claimed market-size number.", ["https://openai.com/index/introducing-the-codex-app/", "https://claude.com/product/claude-code", "https://git-scm.com/docs/git-worktree"]);
}

// 4 — wedge comparison.
{
  const slide = base("The wedge", 4);
  title(slide, "Holt is independent of the agent that acted.", "A local, evidence-first decision layer between a coding system and destructive Git/worktree operations.");
  box(slide, 42, 284, 540, 285, { fill: C.panel });
  box(slide, 656, 284, 582, 285, { fill: C.green });
  label(slide, "WITHOUT HOLT", 70, 312, 300, 28, 15, { bold: true, color: C.muted });
  label(slide, "Agent proposes action\nAgent judges safety\nAgent executes cleanup", 70, 370, 445, 130, 28, { bold: true });
  label(slide, "WITH HOLT", 684, 312, 300, 28, 15, { bold: true, color: C.mint });
  label(slide, "Observe state\nBuild evidence\nGate action\nPreserve recovery", 684, 366, 470, 154, 28, { bold: true, color: C.white });
  label(slide, "One agent cannot promote its own confidence into deletion authority.", 684, 530, 470, 30, 16, { color: C.mint });
  footer(slide);
  note(slide, "This is the core differentiation: Holt is a neutral repository transaction membrane. It can be used by many agents and IDEs because it does not need to be their planner.", ["https://github.com/Raed2180416/holt", "https://github.com/Raed2180416/holt/blob/main/README.md"]);
}

// 5 — process timeline.
{
  const slide = base("Product", 5);
  title(slide, "Four steps. One recoverable decision.", "The current free local core works against native Git worktrees without uploading source code.");
  const steps = [
    ["1", "INSPECT", "Enumerate worktrees, branches, stashes, dirt, receipts, and risk."],
    ["2", "RELATE", "Connect state to a task and identify unique, landed, or unverifiable work."],
    ["3", "GATE", "Return disposable, hold, or unverifiable before a destructive action."],
    ["4", "RECOVER", "Quarantine first; preserve journals and rescue references for rollback."],
  ];
  box(slide, 95, 405, 1040, 2, { fill: C.rule });
  steps.forEach(([n, h, b], i) => {
    const x = 42 + i * 300;
    box(slide, x, 323, 56, 56, { fill: i === 2 ? C.orange : C.green });
    label(slide, n, x, 334, 56, 30, 20, { bold: true, color: C.white, align: "center" });
    label(slide, h, x, 432, 240, 30, 17, { bold: true });
    label(slide, b, x, 476, 245, 95, 17, { color: C.muted });
  });
  footer(slide);
  note(slide, "Demonstrate the product in this order: inspect, relate, gate, recover. The safest default is quarantine and evidence, not irreversible deletion.", ["https://github.com/Raed2180416/holt/blob/main/README.md", "https://github.com/Raed2180416/holt/blob/main/docs/FEATURE-PROOF-MATRIX.md"]);
}

// 6 — current product / limits.
{
  const slide = base("Truth today", 6);
  title(slide, "Working wedge. Pre-traction company.", "The deck separates what is available now from what funding is meant to prove.");
  const cols = [
    ["AVAILABLE NOW", C.mint, ["Free local CLI", "Native Git worktree inspection", "Read-only risk and gate commands", "Recovery-first quarantine and journal", "Local receipts and evidence"]],
    ["NOT CLAIMED YET", C.panel, ["Customer traction or revenue", "Production SLA or hosted control plane", "SSO / SCIM / enterprise readiness", "Every repository shape on every OS", "Measured productivity lift"]],
  ];
  cols.forEach(([h, fill, list], i) => {
    const x = i === 0 ? 42 : 656;
    box(slide, x, 282, 582, 300, { fill });
    label(slide, h, x + 26, 310, 520, 34, 18, { bold: true, color: i === 0 ? C.green : C.muted });
    list.forEach((item, j) => label(slide, `• ${item}`, x + 26, 368 + j * 38, 520, 28, 18));
  });
  footer(slide);
  note(slide, "Say this plainly. Holt has a working free/local product and extensive internal feature proofs. It does not yet have customer traction, a paid SKU, or enterprise production evidence.", ["https://github.com/Raed2180416/holt/blob/main/README.md", "https://github.com/Raed2180416/holt/blob/main/docs/FEATURE-PROOF-MATRIX.md"]);
}

// 7 — ICP and buyer.
{
  const slide = base("Beachhead", 7);
  title(slide, "Start where concurrency already hurts.", "The first customer is a team using several coding agents or worktrees against the same active repository.");
  const rows = [
    ["USER", "Staff engineer / platform engineer", "Feels the incident and owns the repository workflow."],
    ["CHAMPION", "AI tooling or developer productivity lead", "Wants more agent throughput without opaque cleanup risk."],
    ["BUYER", "Engineering leader / platform owner", "Pays when repeated incidents, audit needs, or workflow policy justify it."],
  ];
  rows.forEach(([r, h, b], i) => {
    const y = 280 + i * 105;
    label(slide, r, 42, y + 18, 150, 24, 14, { bold: true, color: C.orange });
    label(slide, h, 205, y, 360, 52, 21, { bold: true });
    label(slide, b, 600, y, 590, 58, 18, { color: C.muted });
    box(slide, 42, y + 78, 1196, 1, { fill: C.rule });
  });
  footer(slide);
  note(slide, "This is an ICP hypothesis, not a customer list. The design-partner program should test whether concurrency and recovery are painful enough to earn repeated use and budget.", ["https://github.com/Raed2180416/holt/blob/main/docs/launch/DESIGN-PARTNER-PROGRAM.md"]);
}

// 8 — moat.
{
  const slide = base("Why this compounds", 8);
  title(slide, "The moat is the evidence model—not the command count.", "Every real incident can improve the transaction boundary across agents, hosts, and repository shapes.");
  const moat = [
    ["RECOVERY GRAPH", "What can be restored, from which evidence, after partial failure."],
    ["ADVERSARIAL CORPUS", "Broken worktrees, hidden dirt, stale receipts, and ambiguous merges become regression cases."],
    ["CROSS-HOST CONTRACT", "Observed semantics across Linux, macOS, Windows, CI, IDEs, and agent hosts."],
    ["WORKFLOW NEUTRALITY", "One independent layer can serve multiple coding agents instead of competing with them."],
  ];
  moat.forEach(([h, b], i) => {
    const x = 42 + (i % 2) * 614;
    const y = 280 + Math.floor(i / 2) * 150;
    box(slide, x, y, 582, 124, { fill: i === 0 ? C.mint : C.panel });
    label(slide, h, x + 24, y + 22, 520, 28, 17, { bold: true, color: C.green });
    label(slide, b, x + 24, y + 62, 520, 46, 17, { color: C.muted });
  });
  footer(slide);
  note(slide, "The durable advantage comes from accumulated failure evidence, recovery semantics, cross-host conformance, and neutrality across agent ecosystems. This is the hypothesis funding will test.", ["https://github.com/Raed2180416/holt/blob/main/docs/FEATURE-PROOF-MATRIX.md", "https://github.com/Raed2180416/holt/blob/main/docs/PROOF-GRADE-CONTRACT.md"]);
}

// 9 — business model.
{
  const slide = base("Business model", 9);
  title(slide, "Free core earns trust. Shared policy pays.", "A staged commercial hypothesis—there is no public paid tier or checkout today.");
  const tiers = [
    ["CORE", "Now", "Local CLI\nRead-only decisions\nRecovery evidence", C.mint],
    ["TEAM", "Hypothesis", "Shared policy\nHost integrations\nIncident collaboration", C.panel],
    ["ENTERPRISE", "Hypothesis", "Fleet governance\nIdentity and audit\nDeployment controls", C.panel],
  ];
  tiers.forEach(([h, s, b, fill], i) => {
    const x = 42 + i * 407;
    box(slide, x, 284, 360, 292, { fill });
    label(slide, s.toUpperCase(), x + 24, 310, 300, 24, 13, { bold: true, color: i === 0 ? C.green : C.orange });
    label(slide, h, x + 24, 358, 310, 42, 30, { bold: true });
    label(slide, b, x + 24, 430, 310, 108, 19, { color: C.muted });
  });
  footer(slide);
  note(slide, "Do not sell imaginary SKUs. The immediate objective is repeated design-partner use and scoped paid evaluations. Packaging follows observed value and procurement needs.", ["https://github.com/Raed2180416/holt/blob/main/docs/launch/PRESEED-BRIEF.md"]);
}

// 10 — GTM.
{
  const slide = base("Go to market", 10);
  title(slide, "Sell the incident, then the control plane.", "A founder-led proof motion focused on repositories where the failure can be reproduced and measured.");
  const stages = [
    ["01", "CHALLENGE", "15-minute destructive-worktree test on an approved repo or disposable reproduction."],
    ["02", "EVIDENCE", "Compare native workflow vs Holt on holds, false confidence, recovery, and operator time."],
    ["03", "REPEAT", "Weekly use across live agent work; build references and a failure corpus."],
    ["04", "EXPAND", "Integrate GitHub/CI and an agent host only after the local seam earns trust."],
  ];
  stages.forEach(([n, h, b], i) => {
    const x = 42 + i * 300;
    label(slide, n, x, 290, 50, 40, 26, { bold: true, color: C.orange });
    label(slide, h, x, 352, 250, 32, 18, { bold: true });
    label(slide, b, x, 400, 250, 116, 17, { color: C.muted });
  });
  box(slide, 42, 555, 1196, 58, { fill: C.green });
  label(slide, "12-WEEK TARGET: 10 DESIGN PARTNERS • 3 PAID EVALUATIONS • 2 REFERENCES", 70, 573, 1140, 25, 18, { bold: true, color: C.white, align: "center" });
  footer(slide);
  note(slide, "The GTM motion is a concrete challenge, not a generic product demo. Targets are proposed milestones, not current traction.", ["https://github.com/Raed2180416/holt/blob/main/docs/launch/DESIGN-PARTNER-PROGRAM.md", "https://github.com/Raed2180416/holt/blob/main/docs/launch/PRESEED-BRIEF.md"]);
}

// 11 — 12-week plan.
{
  const slide = base("Milestones", 11);
  title(slide, "Fund proof, not breadth.", "Three de-risking gates convert founder-use evidence into a company—or falsify the wedge quickly.");
  const phases = [
    ["WEEKS 0–4", "RELEASE CONTRACT", "Exact-head install and semantics across declared Linux, macOS, and Windows paths."],
    ["WEEKS 3–8", "REPEATED USE", "Design partners use Holt weekly; incidents produce replayable evidence and references."],
    ["WEEKS 7–12", "PAID EVALUATION", "Written acceptance tests, one GitHub/CI path, one agent-host path, and budget signal."],
  ];
  phases.forEach(([d, h, b], i) => {
    const x = 42 + i * 407;
    box(slide, x, 285, 360, 255, { fill: i === 1 ? C.mint : C.panel });
    label(slide, d, x + 24, 310, 300, 25, 14, { bold: true, color: C.orange });
    label(slide, h, x + 24, 360, 300, 55, 22, { bold: true });
    label(slide, b, x + 24, 435, 300, 80, 17, { color: C.muted });
  });
  label(slide, "Kill criteria are explicit: if teams do not repeat the workflow or pay for the seam, narrow or stop.", 42, 578, 1120, 30, 18, { bold: true, color: C.green });
  footer(slide);
  note(slide, "The plan is intentionally falsifiable. Cross-platform conformance, repeated use, and a paid acceptance test matter more than adding more commands.", ["https://github.com/Raed2180416/holt/blob/main/docs/launch/PRESEED-BRIEF.md"]);
}

// 12 — raise.
{
  const slide = base("The raise", 12);
  label(slide, "$1M", 42, 120, 480, 150, 112, { bold: true, color: C.green });
  label(slide, "18-month pre-seed hypothesis", 48, 276, 520, 44, 26, { bold: true });
  label(slide, "The amount, instrument, valuation, and team plan require founder and legal confirmation.", 48, 332, 520, 66, 18, { color: C.muted });
  box(slide, 656, 112, 582, 468, { fill: C.panel });
  label(slide, "WHAT CAPITAL MUST PROVE", 686, 142, 500, 28, 15, { bold: true, color: C.orange });
  const goals = ["10 design-partner teams", "3 paid evaluations or pilots", "A repeatable incident and recovery corpus", "Linux / macOS / Windows release contract", "One CI path + one agent-host integration"];
  goals.forEach((g, i) => label(slide, `${i + 1}.  ${g}`, 686, 205 + i * 58, 500, 38, 20, { bold: i < 2 }));
  footer(slide);
  note(slide, "This is a proposed financing envelope. Confirm runway, instrument, valuation, and founder/team facts before sending. The investment case is to prove repeatable demand and a defensible transaction standard.", ["https://github.com/Raed2180416/holt/blob/main/docs/launch/PRESEED-BRIEF.md", "https://github.com/Raed2180416/holt/blob/main/docs/launch/FUNDRAISING-APPLICATION-PACK.md"]);
}

// 13 — close.
{
  const slide = deck.slides.add();
  slide.background.fill = C.green;
  label(slide, "THE BET", 42, 40, 420, 28, 14, { bold: true, color: C.mint });
  label(slide, "Every autonomous coding system\nwill need an independent\nrepository transaction layer.", 42, 135, 1110, 250, 54, { bold: true, color: C.white });
  label(slide, "Holt starts with the moment developers cannot afford to get wrong: deciding what is safe to destroy—and proving how to recover.", 42, 450, 900, 105, 25, { color: C.mint });
  label(slide, "research.contrare@outlook.com", 42, 635, 500, 26, 17, { bold: true, color: C.white });
  label(slide, "github.com/Raed2180416/holt", 740, 635, 500, 26, 17, { bold: true, color: C.white, align: "right" });
  note(slide, "Close on the category bet and invite a concrete next step: investor diligence or a 15-minute destructive-worktree challenge.", ["https://github.com/Raed2180416/holt"]);
}

await fs.mkdir(here, { recursive: true });
const pptx = await PresentationFile.exportPptx(deck);
await pptx.save(outPath);
console.log(outPath);
