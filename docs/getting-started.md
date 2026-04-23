# Getting started with Hive

Stand up your own Hive instance, connect it to Slack, and get a first reply from your Chief of Staff agent. Budget about 20 minutes.

## What you'll need

- A Mac (Apple Silicon recommended)
- An Anthropic API key — create one at [console.anthropic.com](https://console.anthropic.com/)
- Admin access to a Slack workspace (you'll create a Slack app inside it)
- ~20 minutes

The bootstrap script installs Homebrew and Node 22, then hands off to `hive init` which installs the remaining prerequisites (MongoDB, Ollama, Qdrant) as part of the setup wizard.

**Heads-up if you already have Node:** the bootstrap runs `brew link --force --overwrite node@22` when your existing Node is older than 22. That replaces the `node` and `npm` symlinks in your Homebrew prefix. If you actively rely on a different Node version managed via nvm, asdf, or fnm, use the "Already have Node 22" path below instead.

## Install

> **Already running 0.1.x?** Don't follow the install steps below — you need a one-shot migration instead. See [migrating-to-0.2.md](./migrating-to-0.2.md) for the walkthrough. The migration preserves your config, MongoDB data, logs, and agent files, and takes ~5 minutes per instance.

### Fresh Mac (no developer tools)

Run:

```
curl -fsSL https://raw.githubusercontent.com/keepur/hive-docs/main/install/bootstrap.sh | bash
```

Homebrew may pop up a system dialog asking to install Xcode Command Line Tools. Accept it and wait for it to finish — it's a one-time install and can take several minutes. The bootstrap script picks back up automatically and continues into `hive init`.

### Already have Node 22

```
npm i -g @keepur/hive && hive init
```

## Where is my instance?

Your Hive instance lives at `~/services/hive/<your-id>/` by default (pick `<your-id>` during `hive init`). Everything that persists across upgrades — your config, logs, agent data, skills, plugins — is at the instance root.

The engine itself — the code Hive runs — lives in `<instance>/.hive/`. Think of `.hive/` as wipe-and-replace: `hive update` swaps it for a new version, `hive rollback` restores the previous one. Your data is never inside `.hive/`, so upgrades can't touch it.

## Running `hive init`

The wizard walks you through several sections. Here's what to expect at each one:

**1. Business info.** Your company name, what you do, location, timezone, business hours, and your name/role. This context helps your Chief of Staff understand your business from day one.

**2. Slack.** The wizard opens `https://api.slack.com/apps` in your browser and prints a YAML manifest in the terminal. Click **Create New App** → **From a manifest**, choose YAML format, and paste the manifest. After creating the app, install it to your workspace. Slack will then show you two tokens:

- **App-Level Token** (starts with `xapp-`)
- **Bot Token** (starts with `xoxb-`)

Paste both back into the wizard when prompted.

**3. Anthropic API key.** If you have the Claude CLI installed and authenticated, the wizard detects it and uses that session automatically — no API key needed. Otherwise, paste a key from [console.anthropic.com](https://console.anthropic.com/). Either way, credentials are stored in your local `.env` and never sent anywhere except Anthropic.

**4. Optional integrations.** Google, Linear, GitHub, etc. You can skip all of these and add them later via `hive plugin add`. The wizard also offers to install plugins from the registry.

**5. Agent setup.** Names your Chief of Staff bot user and seeds it to MongoDB.

**6. Constitution.** Asks whether agents can send external communications (email, SMS). You can change this later.

**7-10. Memory and service.** Seeds shared memory, sets up the LaunchAgent service, and starts it. (If you installed via npm, the build and deploy steps are already handled — the wizard skips them automatically.) This takes a few minutes. You're done when you see:

```
╔══════════════════════════════════════════════╗
║              Hive is ready!                  ║
╚══════════════════════════════════════════════╝
```

## First Slack message

Open Slack. The wizard told you the bot user's name (default: Chief). Either DM that user or @mention them in a channel they're in. You should see a greeting reply within about 10 seconds.

Nothing happened? See [troubleshooting.md](./troubleshooting.md).

## Adding Google (Gmail + Calendar + Drive)

Install the Google plugin and authorize it:

```
hive plugin add @keepur/hive-plugin-google
gog auth add you@yourdomain.com
```

Replace `you@yourdomain.com` with the Google account you want your agents to use (typically a dedicated bot account, not your personal one). `gog auth add` opens a browser window for OAuth consent.

To verify, ask your Chief of Staff in Slack:

> what's on my calendar today?

You should get a real answer pulled from that Google account.

## Where to next

- [managing-your-hive.md](./managing-your-hive.md) — adding agents, plugins, and channels; updating; backups
- [troubleshooting.md](./troubleshooting.md) — what to check when something doesn't work
