# Contributing

## The one rule that matters

holt's promise is that it never reports work as safe to delete when it is not. Every change is
judged against that first. If a change makes holt faster, cleaner, or more featureful while
making that promise weaker, it will not be merged.

## Sign your commits

Every commit needs a `Signed-off-by` line — use `git commit -s`. That is the
[Developer Certificate of Origin](https://developercertificate.org/): you are asserting you have
the right to contribute that code under this project's license. CI checks it; nothing else about
it will ever bother you.

## Before you open a pull request

```bash
npm test                 # the full suite
npm run test:mutation    # deliberate defects must all still be caught
npm run typecheck        # the diagnostic count may go down, never up
npm run hosts:check      # HOSTS.md must match src/integrate/hosts.mjs
```

All four must be green. If you fix a bug, add the test that would have caught it — the suite is
mostly a record of things that actually went wrong. `typecheck` is a ratchet, not a pass/fail
checker with a fixed bar: it fails if your change adds diagnostics, however small, even though the
repository does not (and will not) reach zero. Fixing pre-existing diagnostics your change touches
is welcome; adding new ones is not. If you edit `src/integrate/hosts.mjs` (add/change a host), run
`npm run hosts:generate` and commit the regenerated `HOSTS.md` — `hosts:check` fails the build
otherwise; see the comment at the top of `scripts/generate-hosts.mjs`.

## Things reviewers look for

- **Fail-closed on missing evidence.** For every new input, ask what happens when it is absent.
  The answer must be "refuse", not "assume fine". Several of the tests exist because that
  answer was once "assume fine".
- **No silent bounds.** If a result is truncated, sampled or capped, the output must say so.
  A bounded answer that does not announce its bound reads as complete coverage.
- **Refusals explain themselves.** Every refusal states what was missing and what to do next.
- **The read-only guarantee.** The analysis path may not reach a mutating git verb. Mutating
  commands opt in explicitly, and the classifier's allowlist is tested directly.

## Adding a language

Symbols come from universal-ctags. If a language is missing, add it to `src/optlib/holt.ctags`
and a case to `test/unit/languages.test.mjs` asserting a real symbol is found in a real snippet.

## Reporting a security issue

See [SECURITY.md](SECURITY.md) — please do not open a public issue.
