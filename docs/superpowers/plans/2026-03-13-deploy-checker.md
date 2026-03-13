# Deploy Checker Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace push-based GitHub Actions deploy with a pull-based launchd job that checks for new commits on the `deploy` branch every 5 minutes.

**Architecture:** A new `deploy-check.sh` script fetches and compares SHAs. If the `deploy` branch is ahead, it runs the existing `deploy.sh`. A launchd plist runs the checker every 300 seconds. The GitHub Actions workflow is removed.

**Tech Stack:** bash, launchd, git

**Spec:** `docs/superpowers/specs/2026-03-13-deploy-checker-design.md`

---

## Chunk 1: Deploy Checker + Plist + Cleanup

### File Structure

| File | Action | Responsibility |
|---|---|---|
| `service/deploy-check.sh` | Create | Fetch deploy branch, compare SHAs, trigger deploy if needed |
| `setup/generate-plist.ts` | Modify | Add deploy-check plist generation |
| `service/install.sh` | Modify | Add deploy-check to symlink/bootstrap/chmod |
| `service/rotate-logs.sh` | Modify | Add deploy-check log to rotation |
| `.github/workflows/deploy.yml` | Delete | No longer needed |

---

### Task 1: Create `service/deploy-check.sh`

**Files:**
- Create: `service/deploy-check.sh`

- [ ] **Step 1: Create the script**

```bash
#!/usr/bin/env bash
set -euo pipefail

BUILD_DIR="${BUILD_DIR:-$HOME/build/hive}"

cd "$BUILD_DIR"
[[ "$(git branch --show-current)" == "deploy" ]] || { echo "ERROR: Build dir not on deploy branch"; exit 1; }

echo "Checking for updates on deploy branch..."
git fetch origin deploy --quiet

LOCAL_SHA=$(git rev-parse HEAD)
REMOTE_SHA=$(git rev-parse origin/deploy)

if [[ "$LOCAL_SHA" == "$REMOTE_SHA" ]]; then
  echo "Up to date ($LOCAL_SHA). Nothing to deploy."
  exit 0
fi

echo "New commits detected: $LOCAL_SHA -> $REMOTE_SHA"
echo "Starting deploy..."

DEPLOY_DIR="${DEPLOY_DIR:-$HOME/services/hive}"
exec "$DEPLOY_DIR/service/deploy.sh"
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x service/deploy-check.sh`

- [ ] **Step 3: Verify syntax**

Run: `bash -n service/deploy-check.sh`
Expected: No output

- [ ] **Step 4: Commit**

```bash
git add service/deploy-check.sh
git commit -m "feat: add deploy-check.sh — pull-based deploy trigger"
```

---

### Task 2: Add deploy-check plist to `setup/generate-plist.ts`

**Files:**
- Modify: `setup/generate-plist.ts:22-23` (add label constant)
- Modify: `setup/generate-plist.ts:126-130` (add plist generation after rotate-logs plist)

- [ ] **Step 1: Add the label constant**

In `setup/generate-plist.ts`, after line 23 (`const LABEL_LOGS = "com.hive.rotate-logs";`), add:

```typescript
const LABEL_DEPLOY = "com.hive.deploy-check";
```

- [ ] **Step 2: Add deploy-check plist generation**

After line 129 (`console.log(\`  Label: ${LABEL_LOGS}\`);`), add:

```typescript
// ── Deploy checker plist ──────────────────────────────────────────

const deployCheckPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL_DEPLOY}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${DEPLOY_DIR}/service/deploy-check.sh</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${pathEnv}</string>
    <key>HOME</key>
    <string>${home}</string>
  </dict>

  <key>StartInterval</key>
  <integer>300</integer>

  <key>StandardOutPath</key>
  <string>${LOGS_DIR}/deploy-check.log</string>
  <key>StandardErrorPath</key>
  <string>${LOGS_DIR}/deploy-check.log</string>
</dict>
</plist>
`;

const deployCheckPlistPath = join(SERVICE_DIR, `${LABEL_DEPLOY}.plist`);
writeFileSync(deployCheckPlistPath, deployCheckPlist);
console.log(`Generated: ${deployCheckPlistPath}`);
console.log(`  Label: ${LABEL_DEPLOY}`);
```

- [ ] **Step 3: Commit**

```bash
git add setup/generate-plist.ts
git commit -m "feat: add deploy-check launchd plist generation"
```

---

### Task 3: Update `service/install.sh`

**Files:**
- Modify: `service/install.sh:15` (add label)
- Modify: `service/install.sh:28-30` (add to bootout loop)
- Modify: `service/install.sh:33-34` (add symlink)
- Modify: `service/install.sh:40` (add chmod)
- Modify: `service/install.sh:43-44` (add bootstrap)

- [ ] **Step 1: Add the label constant**

After line 15 (`LABEL_LOGS="com.hive.rotate-logs"`), add:

```bash
LABEL_DEPLOY="com.hive.deploy-check"
```

- [ ] **Step 2: Add to the bootout loop**

Change line 28 from:

```bash
for lbl in "$LABEL" "$LABEL_LOGS"; do
```

to:

```bash
for lbl in "$LABEL" "$LABEL_LOGS" "$LABEL_DEPLOY"; do
```

- [ ] **Step 3: Add symlink**

After line 34 (`ln -sf "$HIVE_ROOT/service/$LABEL_LOGS.plist" "$LAUNCH_AGENTS_DIR/$LABEL_LOGS.plist"`), add:

```bash
ln -sf "$HIVE_ROOT/service/$LABEL_DEPLOY.plist" "$LAUNCH_AGENTS_DIR/$LABEL_DEPLOY.plist"
```

- [ ] **Step 4: Add chmod for deploy scripts**

Change line 40 from:

```bash
chmod +x "$HIVE_ROOT/service/rotate-logs.sh"
```

to:

```bash
chmod +x "$HIVE_ROOT/service/rotate-logs.sh"
chmod +x "$HIVE_ROOT/service/deploy-check.sh"
```

- [ ] **Step 5: Add bootstrap**

After line 44 (`launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENTS_DIR/$LABEL_LOGS.plist"`), add:

```bash
launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENTS_DIR/$LABEL_DEPLOY.plist"
```

- [ ] **Step 6: Commit**

```bash
git add service/install.sh
git commit -m "feat: add deploy-check to install.sh — symlink, chmod, bootstrap"
```

---

### Task 4: Update `service/rotate-logs.sh`

**Files:**
- Modify: `service/rotate-logs.sh:19-27` (add deploy-check log rotation)

- [ ] **Step 1: Add deploy-check log to rotation**

After line 27 (`find "$HIVE_LOG_DIR" -name "hive.*.2*" -mtime +${KEEP_DAYS} -delete 2>/dev/null || true`), add:

```bash
# --- Deploy checker ---
for logfile in deploy-check.log; do
  src="$HIVE_LOG_DIR/$logfile"
  if [ -s "$src" ]; then
    cp "$src" "$HIVE_LOG_DIR/${logfile}.${TIMESTAMP}"
    : > "$src"
  fi
done
find "$HIVE_LOG_DIR" -name "deploy-check.*.2*" -mtime +${KEEP_DAYS} -delete 2>/dev/null || true
```

- [ ] **Step 2: Commit**

```bash
git add service/rotate-logs.sh
git commit -m "feat: add deploy-check log rotation"
```

---

### Task 5: Delete GitHub Actions workflow

**Files:**
- Delete: `.github/workflows/deploy.yml`

- [ ] **Step 1: Delete the workflow file**

```bash
rm .github/workflows/deploy.yml
rmdir .github/workflows 2>/dev/null || true
rmdir .github 2>/dev/null || true
```

- [ ] **Step 2: Commit**

```bash
git add -A .github/
git commit -m "chore: remove GitHub Actions deploy workflow — replaced by pull-based checker"
```

---

### Task 6: Update CD pipeline spec

**Files:**
- Modify: `docs/superpowers/specs/2026-03-12-cd-pipeline-design.md`

- [ ] **Step 1: Add note at top of old spec**

Add after the `## Overview` paragraph:

```markdown
> **Superseded:** The push-based GitHub Actions approach was replaced by a pull-based deploy checker. See `docs/superpowers/specs/2026-03-13-deploy-checker-design.md`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-03-12-cd-pipeline-design.md
git commit -m "docs: mark CD pipeline spec as superseded by deploy checker"
```
