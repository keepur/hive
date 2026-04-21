#!/usr/bin/env bash
# Hive bootstrap installer for macOS.
# Idempotent: safe to re-run if it bails partway.
# Usage: curl -fsSL https://raw.githubusercontent.com/keepur/hive-docs/main/install/bootstrap.sh | bash

set -euo pipefail

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m==>\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m==>\033[0m %s\n' "$*" >&2; exit 1; }

# 1. macOS check
[[ "$(uname -s)" == "Darwin" ]] || fail "Hive currently supports macOS only."

# 2. Homebrew (which prompts for Xcode CLI tools if missing)
if ! command -v brew >/dev/null 2>&1; then
  log "Installing Homebrew (will prompt for Xcode Command Line Tools if needed)..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Add brew to PATH for current shell (Apple Silicon path; Intel handled by installer's own shellenv hint)
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  fi
else
  log "Homebrew already installed."
fi

# 3. Node 22 (or higher major)
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [[ "$NODE_MAJOR" -ge 22 ]]; then
    log "Node $(node -v) already installed."
    NODE_OK=1
  else
    warn "Found Node $(node -v); hive needs >=22. Installing node@22 via Homebrew."
  fi
fi
if [[ "$NODE_OK" -eq 0 ]]; then
  brew install node@22
  brew link --force --overwrite node@22
fi

# 4. Install hive globally
log "Installing @keepur/hive..."
npm i -g @keepur/hive

# 5. Hand off to interactive setup (reopen stdin from TTY so the wizard can prompt)
log "Launching 'hive init'..."
exec hive init </dev/tty
