#!/usr/bin/env bash
# grove — clone the real repositories used by test/e2e/real-repos.test.mjs.
#
# The fixture suite proves the logic on repos grove's author constructed, which is exactly the
# setup that hides "works on my fixtures" bugs. These are upstream projects in four languages,
# with real history, real file layouts, and real hot files.
#
#   usage:  scripts/clone-fixtures.sh [target-dir]
#   default target: $HOME/.agentic-os-tmp/grove-real   (override with GROVE_REAL_REPOS)
#
# Shallow clones: grove only needs HEAD plus enough history to make worktrees.

set -euo pipefail

TARGET="${1:-${GROVE_REAL_REPOS:-$HOME/.agentic-os-tmp/grove-real}}"
mkdir -p "$TARGET"

clone_one() {
  url="$1"; dir="$2"; lang="$3"
  if [ -d "$TARGET/$dir/.git" ]; then
    printf '  %-14s %-12s already present\n' "$dir" "$lang"
    return 0
  fi
  printf '  %-14s %-12s cloning… ' "$dir" "$lang"
  if git clone --depth 50 --quiet "$url" "$TARGET/$dir" 2>/dev/null; then
    echo "ok"
  else
    echo "FAILED (suite will SKIP this language, not silently pass)"
  fi
}

echo "grove test fixtures -> $TARGET"
echo

clone_one https://github.com/pallets/click.git        py-click    Python
clone_one https://github.com/gin-gonic/gin.git        go-gin      Go
clone_one https://github.com/BurntSushi/ripgrep.git   rs-ripgrep  Rust
clone_one https://github.com/expressjs/express.git    js-express  JavaScript

echo
echo "run:  GROVE_REAL_REPOS=$TARGET npm run test:e2e"
