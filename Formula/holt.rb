# typed: true
# frozen_string_literal: true
#
# holt — Homebrew formula.
#
# Installs holt from the GitHub release tarball. This formula lives in the project's own tap so
# users run:
#
#   brew tap Raed2180416/holt https://github.com/Raed2180416/holt
#   brew install holt
#
# It depends on Node.js (Homebrew's `node` formula) and uses Homebrew's `std_npm_args` helper,
# which sets up the correct libexec prefix and npm environment for a global-style install that
# stays inside the Homebrew cellar. The bin shims (`holt`, `holt.cmd`, `holt.ps1`) that npm
# generates are symlinked into Homebrew's `bin`.

require "language/node"

class Holt < Formula
  desc "Coordinate, preserve, and safely clean parallel agent worktrees"
  homepage "https://raed2180416.github.io/holt/"
  url "https://github.com/Raed2180416/holt/releases/download/v0.3.1/holt.tgz"
  sha256 "008fdffc96968d4288a6bc0b1ad84e9803d1c399a0b10eb05a5a474a9a9a5800"
  # The tarball contains FSL-1.1-MIT core files and separately licensed commercial Team files.
  # See LICENSE-NOTICE.md in the installed package for the per-path terms.
  license :cannot_represent

  # Bump this when a new version is released, then update the sha256.
  # `shasum -a 256 <tarball>` or `curl -sL <url> | shasum -a 256`
  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/holt --version")
  end
end
