#!/usr/bin/env bash
# holt — clone the real repositories used by test/e2e/real-repos.test.mjs.
#
# The fixture suite proves the logic on repos holt's author constructed, which is exactly the
# setup that hides "works on my fixtures" bugs. These are upstream projects in four languages,
# with real history, real file layouts, and real hot files.
#
#   usage:  scripts/clone-fixtures.sh [target-dir]
#   default target: $HOME/.holt-work/holt-real   (override with HOLT_REAL_REPOS)
#
# Every fixture is detached at an immutable upstream commit. A moving default branch makes a
# "real repository" test non-reproducible: the corpus can change while holt does not. The script
# therefore fetches the exact object, checks it out, and verifies the resulting HEAD. Any clone,
# fetch, checkout, or verification failure aborts the whole gate.

set -euo pipefail

TARGET="${1:-${HOLT_REAL_REPOS:-$HOME/.holt-work/holt-real}}"
mkdir -p "$TARGET"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

clone_one() {
  local url="$1" dir="$2" lang="$3" expected="$4"
  local dest="$TARGET/$dir" actual dirty repo_root physical_dest physical_root

  printf '  %-14s %-12s ' "$dir" "$lang"
  if [ -e "$dest" ]; then
    git -C "$dest" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
      || fail "$dest exists but is not a Git worktree"
    repo_root="$(git -C "$dest" rev-parse --show-toplevel)" \
      || fail "$dest has no verifiable Git root"
    physical_dest="$(cd "$dest" && pwd -P)" \
      || fail "$dest cannot be resolved"
    physical_root="$(cd "$repo_root" && pwd -P)" \
      || fail "$repo_root cannot be resolved"
    [ "$physical_dest" = "$physical_root" ] \
      || fail "$dest is not the fixture repository root (Git resolved $repo_root)"
    printf 'refreshing… '
  else
    printf 'cloning… '
    git clone --depth 1 --no-checkout --quiet "$url" "$dest" \
      || fail "could not clone $url into $dest"
  fi

  # Fetching by object id prevents an upstream branch move from changing the corpus. Do not
  # swallow this failure: a server that no longer serves the pinned object means the gate cannot
  # make its reproducibility claim.
  git -C "$dest" fetch --quiet --depth 1 origin "$expected" \
    || fail "$dir could not fetch pinned commit $expected"
  git -C "$dest" checkout --quiet --detach "$expected" \
    || fail "$dir could not check out pinned commit $expected (is the fixture dirty?)"

  actual="$(git -C "$dest" rev-parse --verify 'HEAD^{commit}')" \
    || fail "$dir has no verifiable HEAD commit"
  [ "$actual" = "$expected" ] \
    || fail "$dir resolved to $actual, expected exactly $expected"
  dirty="$(git -C "$dest" status --porcelain=v1 --untracked-files=all)" \
    || fail "$dir working-tree status could not be verified"
  [ -z "$dirty" ] \
    || fail "$dir is dirty after checkout; the real-repository corpus is not reproducible"

  printf 'ok  %s\n' "$actual"
}

echo "holt test fixtures -> $TARGET"
echo

clone_one https://github.com/pallets/click.git        py-click    Python     00e592cea702e0b2caa0dee42489fdb1c22cd845
clone_one https://github.com/gin-gonic/gin.git        go-gin      Go         34dac209ffb6ef85cc78c5d217bbb7ad001d68fd
clone_one https://github.com/BurntSushi/ripgrep.git   rs-ripgrep  Rust       435f59fc4b43af3ab32f34d53fa34978f393fe52
clone_one https://github.com/expressjs/express.git    js-express  JavaScript a3714473feb3d2908add734d340e7755fd85e0a3

echo
echo "run:  HOLT_REAL_REPOS=$TARGET npm run test:e2e"
