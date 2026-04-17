# Getting started with Hive

Stand up your own Hive instance, connect it to Slack, and get a first reply from your Chief of Staff agent. Budget about 20 minutes.

## What you'll need

- A Mac (Apple Silicon recommended)
- An Anthropic API key — create one at [console.anthropic.com](https://console.anthropic.com/)
- Admin access to a Slack workspace (you'll create a Slack app inside it)
- ~20 minutes

The bootstrap script installs Homebrew, Node 22, MongoDB, Ollama, and Qdrant on your behalf. Nothing else needs to be set up first.

**Heads-up if you already have Node:** the bootstrap runs `brew link --force --overwrite node@22` when your existing Node is older than 22. That replaces the `node` and `npm` symlinks in your Homebrew prefix. If you actively rely on a different Node version managed via nvm, asdf, or fnm, use the "Already have Node 22" path below instead.

## Install

### Fresh Mac (no developer tools)

Run:

```
curl -fsSL https://raw.githubusercontent.com/keepur/hive/main/install/bootstrap.sh | bash
```

Homebrew may pop up a system dialog asking to install Xcode Command Line Tools. Accept it and wait for it to finish — it's a one-time install and can take several minutes. The bootstrap script picks back up automatically and continues into `hive init`.

### Already have Node 22

```
npm i -g @keepur/hive && hive init
```

## Running `hive init`

The wizard walks you through four prompts.

**1. Anthropic API key.** Paste the key from [console.anthropic.com](https://console.anthropic.com/). It's stored in your local `.env` and never sent anywhere except Anthropic.

**2. Slack app.** The wizard prints a Slack manifest URL. Open it in your browser, click **Create App**, and install it to your workspace. Slack will then show you two tokens:

- **App-Level Token** (starts with `xapp-`)
- **Bot Token** (starts with `xoxb-`)

Paste both back into the wizard when prompted.

**3. Instance config.** Ports, instance ID, data directories. Defaults are fine for single-user installs — press Enter through them.

**4. Wait.** The wizard pulls models, seeds your Chief of Staff agent, and starts the service. You're done when you see:

```
Hive is running
Chief of Staff seeded
```

## First Slack message

Open Slack. The wizard told you the bot user's name (default: Mokie). Either DM that user or @mention them in a channel they're in. You should see a greeting reply within about 10 seconds.

Nothing happened? See [troubleshooting.md](./troubleshooting.md).

## Adding Google (Gmail + Calendar + Drive)

Install the Google plugin and authorize it:

```
hive plugin add @keepur/hive-plugin-google
gog auth login
```

`gog auth login` opens a browser window — sign in with the Google account you want your agents to use (typically a dedicated bot account, not your personal one).

To verify, ask your Chief of Staff in Slack:

> what's on my calendar today?

You should get a real answer pulled from that Google account.

## Where to next

- [managing-your-hive.md](./managing-your-hive.md) — adding agents, plugins, and channels; updating; backups
- [troubleshooting.md](./troubleshooting.md) — what to check when something doesn't work
