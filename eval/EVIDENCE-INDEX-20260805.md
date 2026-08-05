# Codex + Holt evaluation evidence index — 2026-08-05

## Current verdict

There is **no valid full-product paired Codex result yet**, so there is no measured Holt lift,
time saving, or token saving to publish. Both paid pairs are preserved as evaluator failures, not
relabelled product wins. The deterministic product gate passes; the installed-runtime transport
probe passes; the next paid pair must wait for the final release artifact and its version-strict
freeze/preflight.

## Preserved evidence

| Evidence | Exact file SHA-256 | Verdict |
|---|---|---|
| `results-corrected-overrefusal-matrix-20260805.json` | `2840b90f63bed477d670f3307b6f2492f2227d4c46304078065b1a3d29107e91` | PASS: 7 safe cases, zero safe-case false interventions; authored-only-copy denial and recoverable generated cleanup both execute correctly. |
| `results-codex-luna-full-product-cleanup-smoke-20260805.json` | `5a02af921920428f5a91e8e36cd2c38513d0d8d9c5f6a61f4a89760d070f6edf` | INVALID full-product pair: evaluator shim buffered MCP stdin until EOF; Codex timed out handshaking. Hooks and CLI were live, MCP was not. Semantic identity `sha256:3ea29d1e54f1e9e5ad45803c521b0a8237475fe208623540c67b0d80a06afc96`. |
| `results-codex-luna-full-product-cleanup-smoke-mcp-v2-20260805.json` | `207fa595f906adb04257b3fa77bbcef7eaf09b1bd7e9dfe2f39154dcbdba17a3` | INVALID full-product pair: fixed streaming shim forwarded initialize, then the unpacked tarball exited because its npm dependencies had never been installed. The new activation gate correctly invalidated the arm. Semantic identity `sha256:b1b6fe7a8c795b9e7c3e65e287f7e42847ef9eef2999205098e59fdcd710a394`. |
| `results-installed-runtime-mcp-preflight-20260805.json.mcp-preflight.json` | `4a033ba8d2c308f9e78cdc41fa7a230dbbcaf2cfd081ceb4f8ba37f1db6c29f3` | PASS for dependency closure and MCP transport: isolated normal install contains SDK 1.30.0; initialize, 16-tool tools/list, empty stderr, and clean EOF exit 0 succeed with ambient HOME masked. Semantic identity `sha256:38f88497a54b5588711accc86d3e3bfe62fd3e6a4d9108b23d8b0c0bfd992a0f`. It also exposed package/MCP version drift: package 0.3.1 advertised MCP 0.2.0. The final gate now rejects that mismatch. |
| `results-installed-runtime-version-strict-preflight-20260805.json.mcp-preflight.json` | `4faae56349626fe62cc00b0d544019d451e1e30b8c66cc600805b01cf4ae9bd4` | EXPECTED FAIL before model spend: dependency closure, initialize, all 16 tools, stderr, and clean shutdown remain good, but the release-strict gate rejects advertised MCP 0.2.0 versus installed package 0.3.1. Semantic identity `sha256:7a42330392c454e07939f64eab722dd357daf6420d6e6989bae3dc53db622fbd`. |
| `results-freeze-script-selftest-20260805.json` | `b97deba88b27f6bafb0c36e069430f6f1e08640ea63fcbbccd31801fb6b75a79` | Historical self-test of the one-command installer before version parity became mandatory. It proves ambient-masked npm install and transport behavior, but is not a final-release pass because the candidate still advertised MCP 0.2.0. |

The two invalid pairs retain complete transcripts and per-row descriptive values, but those values
must not be compared causally. In particular, the second pair's valid control was safe but removed
only 2/5 disposable worktrees (utility 0.40, 57.021 s); its treated row is ungraded.

## Installed runtime evidence

The isolated install was created from tarball SHA-256
`029e025c3c0886febf2ee6c1038e1794c7402a54bac0725e08062a34c0d90ad0` under bubblewrap with
`/home/raed` replaced by tmpfs and only the new install root rebound. A normal full install did
include `@modelcontextprotocol/sdk@1.30.0`.

- Holt package tree: `75300282115c0efc19c9ab203d1126770b196154525806680a3cb336573b66c7`
  (65 files, 2,000,703 bytes)
- Complete installed tree: `40b88c39d819cb2c57039c8bb4e71d33e718e0145a807674b3cefc622f8866db`
  (4,165 entries; 3,596 files; 3 symlinks; 566 directories; 22,121,708 bytes)
- Install lock: `7da9484b6f467d498786a3fc50db80a8de6780e4c68ea1d50db47cc3d45ce4a0`
- Installed package JSON: `a34e3bef7d5df93491b7c502a8381bdeffa641da8f750cd201adfc47ed59a60f`
- Shipped shrinkwrap: `b8ce5410bf86476c03e26dcae088aed064318265f9da38d80b78ace866cee5ba`
- Installed executable: `58e70588e683e82fafe30186f9bbd34efc3bc1e137d8f085357150642b2e8427`
- MCP SDK package JSON: `0690cbe02511a95d1ff199acf20b5a12ac4dfde1bbe30c82a0de73afa92dffc9`

## Measurement contract for the final pair and long run

Every Codex row records the exact wall time and filesystem-derived cleanup utility. From Codex
JSONL it records `turn.completed.usage.input_tokens`, `cached_input_tokens`, `output_tokens`, and
`reasoning_output_tokens`, plus one count per completed tool/action item ID and a breakdown by item
type (including command execution and MCP tool calls). Summaries carry coverage denominators for
tokens and tool calls. Missing/non-numeric token fields or an unclassified future item type produce
`null`/unknown with a reason; they are never coerced to zero or guessed. Monetary cost remains
unknown because this Codex JSONL does not emit it.

The minimum publication floor remains 20 valid trials per named treatment. One valid final pair is
only a smoke gate; it cannot support a rate, lift, or long-run savings claim.

## One-command final freeze

After the release source and exact npm tarball are frozen, run this once with new, absent paths:

```bash
node eval/freeze-installed-runtime.mjs --tarball /ABS/PATH/holt-VERSION.tgz --runtime /ABS/PATH/holt-VERSION-installed --evidence /ABS/PATH/holt-VERSION-runtime-evidence.json
```

That command refuses existing targets, installs the exact tarball with optional dependencies under
an ambient-masked HOME, removes all write bits, hashes the tarball/package/lock/shrinkwrap/binary/
SDK/full tree, and then requires real MCP initialize, package-version parity, tools/list with the
required diagnostic and acting tools, exact stream hashes, empty-protocol parsing errors, and clean
exit after stdin EOF. It emits a checksummed evidence artifact. Only its returned package root,
install root, binary, tarball, and evidence hashes should be passed into the subsequently authorized
paired smoke.
