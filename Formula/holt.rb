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
  desc "Know what your agents made, and don't lose any of it"
  homepage "https://raed2180416.github.io/holt/"
  url "https://github.com/Raed2180416/holt/releases/download/v0.3.1/holt.tgz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "FSL-1.1-MIT"

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
