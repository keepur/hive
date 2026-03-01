#!/bin/bash
set -euo pipefail

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║       Hive — Prerequisites Installer         ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

check() { command -v "$1" &>/dev/null; }

ok() { echo -e "${GREEN}✓${NC} $1"; }
need() { echo -e "${YELLOW}→${NC} $1"; }

# 1. Homebrew
if check brew; then
  ok "Homebrew already installed"
else
  need "Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Add to path for this session
  if [ -f /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  fi
  ok "Homebrew installed"
fi

# 2. Node.js
if check node; then
  NODE_VERSION=$(node -v | cut -d. -f1 | tr -d v)
  if [ "$NODE_VERSION" -ge 22 ]; then
    ok "Node.js $(node -v) already installed"
  else
    need "Node.js $(node -v) is too old — installing Node.js 22..."
    brew install node@22
    ok "Node.js updated"
  fi
else
  need "Installing Node.js..."
  brew install node
  ok "Node.js installed"
fi

# 3. MongoDB
if check mongod; then
  ok "MongoDB already installed"
else
  need "Installing MongoDB..."
  brew tap mongodb/brew 2>/dev/null || true
  brew install mongodb-community
  ok "MongoDB installed"
fi

# Start MongoDB if not running
if ! pgrep -x mongod &>/dev/null; then
  need "Starting MongoDB..."
  brew services start mongodb-community
  ok "MongoDB started"
else
  ok "MongoDB already running"
fi

# 4. Git
if check git; then
  ok "Git already installed"
else
  need "Installing Git..."
  brew install git
  ok "Git installed"
fi

echo ""
echo "All prerequisites installed."
echo "Next: run 'npm install && npm run setup' to configure Hive."
echo ""
