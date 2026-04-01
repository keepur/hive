# Hive Admin UI — Agent Management

**Date:** 2026-04-01
**Status:** Draft
**Scope:** Web-based admin interface for managing agent identity and capabilities

## Problem

All agent configuration — soul, system prompt, tools, avatar — is managed through CLI, natural language via beekeeper, or raw MongoDB. There is no visual interface. This makes tuning agent behavior painful and inaccessible to anyone who isn't comfortable with a terminal.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Framework | Meteor.js 3.x + React + Tailwind v4 | Reactive MongoDB subscriptions, built-in accounts, local-first |
| Location | `admin/` at repo root | Meteor has its own build system and dependency tree — peer service, not subsystem |
| Data access | Direct MongoDB connection | Meteor subscribes to `agent_definitions` reactively. No REST proxy layer. |
| Auth | `accounts-passwordless` | Magic code via email. Foundation for all future Hive web access. |
| Avatar storage | `ostrio:files` + local filesystem | Same package as dodi_v2, but configured for local disk instead of S3 |
| Component reuse | Copy from `dodi_v2` | shadcn/ui primitives, Tiptap editor, login flow, file dropzone — adapted for Hive |
| Cloud dependency | None | Everything runs on the Mac Mini. Resend for email when internet is available. |

---

## 1. Project Structure

```
admin/                            # Meteor app root
├── client/
│   ├── main.jsx                  # React entry point
│   ├── main.css                  # Tailwind import
│   └── App.jsx                   # Router + layout
├── server/
│   ├── main.js                   # Startup: accounts config, publications, file serving
│   ├── publications.js           # Meteor publications for agent data
│   ├── methods.js                # Meteor methods (agent CRUD)
│   ├── files.js                  # ostrio:files collection + local storage config
│   └── email.js                  # Custom email hook (Resend integration)
├── imports/
│   ├── api/
│   │   ├── agents.js             # Agents collection (connects to agent_definitions)
│   │   └── files.js              # UserFiles collection (ostrio:files)
│   ├── ui/
│   │   ├── pages/
│   │   │   ├── AgentList.jsx     # Agent grid/list view
│   │   │   ├── AgentEditor.jsx   # Soul, prompt, tools editor
│   │   │   └── Login.jsx         # Passwordless login (adapted from dodi_v2)
│   │   ├── components/
│   │   │   ├── ui/               # shadcn/ui primitives (copied from dodi_v2)
│   │   │   │   ├── button.tsx
│   │   │   │   ├── card.tsx
│   │   │   │   ├── dialog.tsx
│   │   │   │   ├── input.tsx
│   │   │   │   ├── label.tsx
│   │   │   │   ├── select.tsx
│   │   │   │   ├── tabs.tsx
│   │   │   │   ├── badge.tsx
│   │   │   │   ├── switch.tsx
│   │   │   │   ├── checkbox.tsx
│   │   │   │   ├── separator.tsx
│   │   │   │   ├── progress.tsx
│   │   │   │   ├── popover.tsx
│   │   │   │   ├── tooltip.tsx
│   │   │   │   ├── sonner.tsx
│   │   │   │   ├── skeleton.tsx
│   │   │   │   ├── textarea.tsx
│   │   │   │   └── index.ts
│   │   │   ├── file-dropzone.jsx # Drag-and-drop upload (adapted from dodi_v2)
│   │   │   ├── AvatarUpload.jsx  # Photo upload + preview (uses file-dropzone)
│   │   │   ├── ToolConfig.jsx    # MCP server picker
│   │   │   ├── AgentCard.jsx     # Card component for agent list
│   │   │   └── Layout.jsx        # Shell with nav
│   │   └── hooks/
│   │       └── useAgent.js       # Reactive agent subscription hook
│   └── lib/
│       ├── constants.js          # MCP server registry, model list
│       └── utils.js              # cn() helper (copied from dodi_v2)
├── public/                       # Static assets (served as-is)
├── postcss.config.mjs            # Tailwind v4 PostCSS config
├── package.json
└── .gitignore
```

### Run configuration

- **Port:** `portBase + 5` (e.g. 3105 for the dodi instance)
- **MongoDB:** `MONGO_URL` pointing to the same instance Hive uses (e.g. `mongodb://localhost:27017/hive`)
- **Email:** `MAIL_URL` via Resend SMTP, or custom `Email.customTransport` using Resend API directly
- **Process:** Own LaunchAgent (`com.hive.<id>.admin`), or started via `npm run admin` during development

---

## 2. Components from dodi_v2

The `dodi_v2` ops app (`~/dev/dodi_v2/src/apps/ops/`) uses the identical tech stack: Meteor 3.x + React 18 + Tailwind v4. We **copy** the components we need into the admin app rather than importing from the monorepo — keeps the Hive self-contained with no cross-repo build dependency. Future refactoring can extract a shared lib when warranted.

### What we copy and how we adapt it

| Component | Source in dodi_v2 | Adaptation |
|-----------|------------------|------------|
| **shadcn/ui primitives** | `src/modules/ui/lib/react/components/ui/` | Copy the ~17 components we need (button, card, dialog, input, label, select, tabs, badge, switch, checkbox, separator, progress, popover, tooltip, sonner, skeleton, textarea). Rewire imports from `@dodihome/ui` → local `../ui/` relative paths. Keep Radix UI + `cn()` utility. |
| **`cn()` utility** | `src/modules/ui/lib/utils/cn.ts` | Copy to `imports/lib/utils.js`. Uses `clsx` + `tailwind-merge`. |
| **Tiptap rich text editor** | `src/apps/ops/imports/ui/components/rich-text-editor/` | **Not used for soul/systemPrompt** (those fields are plain text injected into Claude's prompt — HTML tags would corrupt the LLM context). Copied for future use in rich content fields (e.g. agent notes, documentation). For now, soul and systemPrompt use plain `Textarea` components. |
| **Login page** | `src/apps/ops/imports/ui/pages/LoginPage.tsx` | Copy the passwordless flow structure (`requestLoginTokenForUser` → `passwordlessLoginWithToken`). Strip: Google login, zip code, HubSpot signup, GTM analytics, returning-user toggle, DodiLogo. Replace branding with Hive identity. Simplify to just email → code → logged in. |
| **File dropzone** | `src/modules/attachments/lib/react/components/file-dropzone.tsx` | Copy and simplify for single-image avatar upload. Replace `@dodi/attachments` import with local `UserFiles`. Restrict to image types only, max 2MB. |
| **`ostrio:files` setup** | `src/modules/attachments/` (server.ts, models/index.ts, types.ts) | Copy the `FilesCollection` configuration pattern. Replace S3 storage config with local filesystem (`storagePath` pointing to `AVATARS_DIR`). Simplify — no access-control callbacks (admin-only app), no context tagging. |

### What we don't copy (v1)

- **Tiptap rich text editor** — `soul` and `systemPrompt` are plain text injected directly into Claude's prompt. HTML tags would corrupt the LLM context. Plain `Textarea` is correct. Tiptap may be added later for rich content fields.
- **AppShell / AppSidebar / TopBar** — the ops app layout is complex (customer portal, mobile, role-based nav). The admin app needs a simple sidebar with a handful of links. Build fresh.
- **`@tanstack/react-table`** — the agent list is a small grid of cards, not a data table. No need.
- **Comments / chat components** — not relevant.
- **S3 storage configuration** — replaced with local disk. No `aws-sdk` dependency.
- **Google login** — admin uses passwordless only.
- **HubSpot / GTM integrations** — not relevant.

### NPM dependencies added

These are the dependencies from dodi_v2 that the copied components need:

```json
{
  "dependencies": {
    "@radix-ui/react-dialog": "^1.x",
    "@radix-ui/react-label": "^2.x",
    "@radix-ui/react-popover": "^1.x",
    "@radix-ui/react-select": "^2.x",
    "@radix-ui/react-separator": "^1.x",
    "@radix-ui/react-switch": "^1.x",
    "@radix-ui/react-tabs": "^1.x",
    "@radix-ui/react-checkbox": "^1.x",
    "@radix-ui/react-tooltip": "^1.x",
    "@radix-ui/react-slot": "^1.x",
    "class-variance-authority": "^0.7.x",
    "clsx": "^2.x",
    "tailwind-merge": "^2.x",
    "lucide-react": "^0.4x",
    "react-dropzone": "^14.x",
    "sonner": "^1.x"
  }
}
```

**Tiptap not included in v1.** The `soul` and `systemPrompt` fields are plain text injected into Claude's prompt — HTML would corrupt the LLM context. Plain `Textarea` is the correct editor. Tiptap may be added later for rich content fields (e.g. agent notes, team documentation).

### Import path rewiring

In dodi_v2, components import from package aliases:
```typescript
import { Button } from '@dodihome/ui/lib/react/components/ui';
import { cn } from '@dodihome/ui/lib/utils';
import { UserFiles } from '@dodi/attachments/models';
```

In the admin app, these become local imports:
```typescript
import { Button } from '../components/ui';
import { cn } from '../../lib/utils';
import { UserFiles } from '../../api/files';
```

A one-time find-and-replace during the copy.

---

## 3. Data Layer

### Collections

Meteor connects directly to the existing MongoDB. No new collections — we use what's already there:

| Meteor Collection | MongoDB Collection | Access |
|---|---|---|
| `Agents` | `agent_definitions` | Read/write — the primary data source |
| `AgentVersions` | `agent_definition_versions` | Write from Meteor Methods (version snapshots on every save); Read for history display (v2) |
| `AvatarFiles` | `avatars` | Read/write — managed by `ostrio:files` (file metadata + GridFS-style records) |

### Publications

```javascript
// server/publications.js

// All agents — summary fields for list view
Meteor.publish("agents.list", function () {
  if (!this.userId) return this.ready();
  return Agents.find({}, {
    fields: { _id: 1, name: 1, icon: 1, avatar: 1, model: 1, channels: 1, disabled: 1, updatedAt: 1 }
  });
});

// Single agent — full document for editor
Meteor.publish("agents.one", function (agentId) {
  if (!this.userId) return this.ready();
  check(agentId, String);
  return Agents.find({ _id: agentId });
});
```

Meteor's reactivity means the agent list and editor update in real time when any client (or the beekeeper, or the admin REST API) modifies an agent definition.

### Write Path

Agent updates go through Meteor Methods (not direct client-side writes).

**Optimistic locking:** Both the Meteor UI and the admin REST API write to the same collections. To prevent lost updates when both modify the same agent concurrently, we use a `version` counter on `AgentDefinition`. Every write increments it and uses the current value as a filter condition — if someone else wrote first, the filter misses and the caller gets a conflict error.

New field on `AgentDefinition`:
```typescript
version: number;  // Incremented on every write. Default: 0.
```

**Migration required:** All existing documents must be backfilled before deploying the locking logic. Without this, `current.version` is `undefined` and the filter `{ _id, version: undefined }` won't match documents where the field is absent — every first save would throw a false conflict.

```javascript
// Run once before deploying admin UI or updated admin-api.ts
db.agent_definitions.updateMany(
  { version: { $exists: false } },
  { $set: { version: 0 } }
);
```

```javascript
// server/methods.js

Meteor.methods({
  "agents.update"(agentId, fields) {
    if (!this.userId) throw new Meteor.Error("not-authorized");
    check(agentId, String);

    // Block immutable fields
    delete fields._id;
    delete fields.createdAt;
    delete fields.version; // Managed internally

    const current = Agents.findOne(agentId);
    if (!current) throw new Meteor.Error("not-found");

    // Save version snapshot before write
    AgentVersions.insert({
      agentId,
      snapshot: current,
      changedFields: Object.keys(fields),
      source: "admin-ui",
      createdAt: new Date(),
    });

    // Optimistic lock — fails if another writer incremented version first
    const result = Agents.update(
      { _id: agentId, version: current.version },
      { $set: {
        ...fields,
        version: current.version + 1,
        updatedAt: new Date(),
        updatedBy: `admin:${Meteor.user()?.emails?.[0]?.address}`
      }}
    );

    if (result === 0) {
      throw new Meteor.Error("conflict",
        "Agent was modified by another writer. Your editor will refresh automatically — re-apply your changes.");
    }
  },

  "agents.toggle"(agentId, disabled) {
    if (!this.userId) throw new Meteor.Error("not-authorized");
    // Same version-save + optimistic-lock pattern
  }
});
```

The admin REST API (`admin-api.ts`) needs the same optimistic lock added — change `updateOne` to include `version` in the filter and `$set`. This is the one required change to the REST API.

### Version Snapshot Source Tracking

Both writers save version snapshots to `agent_definition_versions`. To keep the audit trail legible, add a `source` field to `AgentDefinitionVersion`:

```typescript
// In agent-definition.ts
interface AgentDefinitionVersion {
  agentId: string;
  snapshot: AgentDefinition;
  changedFields: string[];
  source: string;  // "admin-ui", "admin-api", "beekeeper", "setup"
  createdAt: Date;
}
```

The `source` field makes it clear which writer created each version. The `updatedBy` on the snapshot itself reflects the *previous* writer, not the current one.

This mirrors the admin REST API's behavior: version snapshot before every mutation, `updatedBy` tracking. The `updatedBy` field now includes the admin user's email for audit trail.

### Agent Registry Reload

When the admin UI writes to `agent_definitions`, the Hive main process needs to pick up the changes. This already works — the agent registry polls MongoDB or uses change streams (within 30 seconds). No new wiring needed.

---

## 4. Avatar System (ostrio:files + Local Disk)

### New field: `avatar`

Add an `avatar` field to `AgentDefinition`:

```typescript
// In agent-definition.ts
avatar?: string;  // ostrio:files download URL, e.g. "/cdn/storage/avatars/{fileId}/original/{name}"
```

This is separate from `icon` (which is an emoji or URL used for Slack identity). The `avatar` is a photo/image used in the admin UI and potentially in the iOS app.

### Why ostrio:files instead of raw filesystem

The dodi_v2 ops app already uses `ostrio:files` for all file uploads. Reusing the same package means:
- Proven chunked upload with progress tracking (the `FileDropzone` component already handles this)
- Built-in download routes (`/cdn/storage/...`) — no custom `WebApp.connectHandlers` needed
- File metadata in MongoDB (searchable, linkable)
- The only change: configure `storagePath` to use local disk instead of S3

### FilesCollection configuration

```javascript
// server/files.js
import { FilesCollection } from "meteor/ostrio:files";
import { join } from "path";

const AVATARS_DIR = process.env.AVATARS_DIR || join(process.cwd(), "data", "avatars");

export const AvatarFiles = new FilesCollection({
  collectionName: "avatars",
  storagePath: AVATARS_DIR,
  allowClientCode: false,       // Server-side validation only
  onBeforeUpload(file) {
    // Restrict to images, max 2MB
    if (file.size > 2 * 1024 * 1024) return "Max file size is 2MB";
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) return "Only PNG, JPG, WebP allowed";
    return true;
  },
  downloadRoute: "/cdn/storage/avatars",
});
```

**Key difference from dodi_v2:** No S3 transport. `storagePath` writes directly to disk. The `downloadRoute` is served by `ostrio:files`'s built-in HTTP handler, which reads from `storagePath` and streams files. No additional `WebApp.connectHandlers` setup is needed.

### Upload flow

1. User clicks the avatar area in `AvatarUpload` component → `FileDropzone` opens (copied from dodi_v2, restricted to images)
2. `react-dropzone` handles drag-and-drop or file picker
3. `AvatarFiles.insert({ file, meta: { agentId }, transport: "http" })` uploads via chunked HTTP
4. `FileDropzone` shows progress bar (same UX as dodi_v2)
5. On upload complete, a Meteor Method updates the agent's `avatar` field with the download URL:
   ```javascript
   Meteor.methods({
     "agents.setAvatar"(agentId, fileUrl) {
       if (!this.userId) throw new Meteor.Error("not-authorized");
       const current = Agents.findOne(agentId);
       if (!current) throw new Meteor.Error("not-found");
       // Remove previous avatar file if one exists
       if (current.avatar) {
         // Find and remove old file from AvatarFiles
       }
       // Optimistic lock — same pattern as agents.update
       const result = Agents.update(
         { _id: agentId, version: current.version },
         { $set: { avatar: fileUrl, version: current.version + 1, updatedAt: new Date() } }
       );
       if (result === 0) {
         throw new Meteor.Error("conflict", "Agent was modified concurrently. Try again.");
       }
     }
   });
   ```
6. The avatar renders via the standard ostrio:files download route — e.g. `<img src="/cdn/storage/avatars/{fileId}/original/{name}" />`

### Storage

- **Location:** `AVATARS_DIR` env var, defaults to `{cwd}/data/avatars/` (gitignored)
- **Production:** deploy script sets `AVATARS_DIR=~/services/<id>/data/avatars/` in the LaunchAgent plist — persistent across deploys
- **Naming:** `ostrio:files` manages file naming internally (uses `{fileId}` directories)
- **Max size:** 2MB
- **Accepted types:** PNG, JPG, WebP
- **Previous avatar cleanup:** when a new avatar is uploaded, the Meteor Method removes the old file via `AvatarFiles.remove()`
- **Backup:** avatars are included in any filesystem backup of the Hive data directory

### No cloud dependencies

No S3, no CDN. `ostrio:files` is the same package dodi_v2 uses, but configured with `storagePath` instead of an S3 transport. Files stay on the Mac Mini's local disk.

---

## 5. Authentication

### Passwordless accounts via `accounts-passwordless`

1. User enters their email on the login screen
2. Meteor sends a 6-digit code to that email (via Resend)
3. User enters the code → logged in
4. Session persists via Meteor's built-in token system (localStorage + DDP)

### Email delivery

Meteor's `Email` package needs an SMTP endpoint. Two options:

**Option A — Resend SMTP (simplest):**
```bash
MAIL_URL="smtps://resend:${RESEND_API_KEY}@smtp.resend.com:465"
```
Resend provides SMTP access with the same API key already in `.env`.

**Option B — Custom transport (for offline fallback):**
Override `Email.customTransport` to use the Resend HTTP API when available, and fall back to logging the code to the server console when offline.

**Recommendation:** Start with Option A. Add Option B if offline auth becomes a real need.

### Access control

v1 is simple:
- Any user who can receive the login email can access the admin UI
- No roles or permission levels yet
- The Meteor `users` collection stores accounts (separate from agent data)

Future: add roles (admin, viewer, operator) when more features are built.

### Allowed emails

Restrict access at two levels — account creation AND every login attempt:

```javascript
// server/main.js

function isAllowedEmail(email) {
  return email && email.endsWith("@dodihome.com");
}

// Block account creation for unauthorized domains
Accounts.validateNewUser((user) => {
  const email = user.emails?.[0]?.address;
  if (!isAllowedEmail(email)) {
    throw new Meteor.Error(403, "Not authorized");
  }
  return true;
});

// Block login for any account that shouldn't have access
// (catches accounts created before the domain check was added)
Accounts.validateLoginAttempt(({ user }) => {
  const email = user?.emails?.[0]?.address;
  return isAllowedEmail(email);
});
```

---

## 6. UI Pages

### Agent List (`AgentList.jsx`)

Grid of agent cards using shadcn/ui `Card` components. Each card shows:
- Avatar (via ostrio:files URL, or fallback: `icon` emoji, or first letter of name)
- Name
- Model tier `Badge` (Opus / Sonnet / Haiku)
- Status indicator (enabled/disabled `Switch`)
- Channel assignments

Click a card → navigate to `AgentEditor` for that agent.

Quick actions on each card:
- Enable/disable toggle
- (Future: drag to reorder, bulk actions)

### Agent Editor (`AgentEditor.jsx`)

Tabbed layout using shadcn/ui `Tabs`:

**Identity tab:**
- Avatar upload with circular preview — uses the `AvatarUpload` component wrapping the copied `FileDropzone` (ostrio:files upload with progress)
- Name (display only in v1 — `_id` and `name` are set at creation)
- Model `Select` dropdown
- Channel assignments (multi-select chips)

**Soul tab:**
- Full-height `Textarea` for the `soul` field — **plain text, not rich text**. The soul is injected directly into Claude's prompt by the agent-runner (`toAgentConfig` passes it through verbatim). HTML tags would corrupt the LLM context. A large, well-styled `Textarea` with monospace font is the right tool here.
- Character count indicator
- (Future: syntax highlighting for markdown if soul format evolves)

**System Prompt tab:**
- Same full-height `Textarea` for `systemPrompt` field — same plain-text rationale as soul

**Tools tab:**
- **Core servers** — `Checkbox` list of all available MCP servers (from the registry in `constants.js`). Checked items = `coreServers`.
- **Delegate servers** — same list, separate section. Checked items = `delegateServers`.
- **Delegate prompts** — for each delegate server, an expandable `Textarea` for the custom prompt (`delegatePrompts[serverName]`)
- **Plugins** — `Checkbox` list of available Claude Code plugins. Checked items = `plugins`.

**Save behavior:**
- **Explicit save** via a `Button` — not autosave. Version snapshots are created per save, and autosave with a 2-second debounce on text fields would create hundreds of near-identical snapshots during a normal editing session. Explicit save keeps the version history meaningful.
- Visual indicator: "Saved" / "Unsaved changes" `Badge`
- Unsaved changes warning on navigation away (browser `beforeunload` + React Router prompt)
- Every save creates a version snapshot (via the Meteor Method)
- On conflict (optimistic lock failure), the editor refreshes with the latest data and shows a `sonner` toast notification

### Fields Not Exposed in v1 Editor

The following `AgentDefinition` fields exist but are intentionally omitted from the editor. They are preserved on save (Meteor method only `$set`s the fields the user changed — untouched fields are not clobbered).

| Field | Reason for omission |
|-------|-------------------|
| `triageModel` | Advanced routing config — rarely changed, CLI/API only |
| `passiveChannels` | Advanced routing — listen-only channels |
| `keywords` | Routing keywords — dead code per MEMORY.md, kept for compat |
| `isDefault` | Catch-all flag — dangerous to toggle casually (breaks routing) |
| `subscribe` | Event bus subscriptions — not yet stable |
| `schedule` | Cron entries — separate schedule management UI planned |
| `budgetUsd`, `maxTurns`, `maxConcurrent`, `timeoutMs` | Operational limits — CLI/API only for now |
| `slackBot` | Slack bot token association — set at setup time |
| `dodiOpsMode` | Plugin-specific — managed by beekeeper |

### Login (`Login.jsx`)

Adapted from `dodi_v2/src/apps/ops/imports/ui/pages/LoginPage.tsx`. Stripped down to the essentials:
- Email `Input` + "Send code" `Button`
- Token `Input` (6-digit code) + "Log in" `Button`
- "Use different email" back link
- Branded with Hive identity (not DodiHome)

**Removed from the dodi_v2 version:** Google login, zip code field, HubSpot signup, GTM analytics, new-user/returning-user toggle, DodiLogo.

**Kept:** The two-step flow (`requestLoginTokenForUser` → `passwordlessLoginWithToken`), error handling, loading states, redirect on authenticated.

---

## 7. MCP Server Registry

The Tools section needs a list of all available MCP servers to offer as checkboxes. This list is currently implicit in the codebase (server configs are built in `agent-runner.ts`).

### Approach

Maintain a static registry in the admin app:

```javascript
// imports/lib/constants.js
export const MCP_SERVERS = [
  { id: "memory", label: "Memory", description: "Agent memory (MongoDB-backed)" },
  { id: "slack", label: "Slack", description: "Slack messaging" },
  { id: "schedule", label: "Schedule", description: "Self-service schedule management" },
  { id: "crm-search", label: "CRM Search", description: "Semantic search over HubSpot data" },
  { id: "hubspot-crm", label: "HubSpot CRM", description: "Read/write CRM operations" },
  { id: "resend", label: "Email (Resend)", description: "Per-agent email sending" },
  // ... etc
];

export const MODELS = [
  { id: "claude-haiku-4-5", label: "Haiku", tier: "haiku" },
  { id: "claude-sonnet-4-5", label: "Sonnet", tier: "sonnet" },
  { id: "claude-opus-4-6", label: "Opus", tier: "opus" },
];
```

This is simple and works. Future: the admin REST API's `GET /admin/servers` endpoint could return this list dynamically.

---

## 8. Deployment

### Development

```bash
cd admin/
MONGO_URL="mongodb://localhost:27017/hive" \
MAIL_URL="smtps://resend:${RESEND_API_KEY}@smtp.resend.com:465" \
meteor --port 3105
```

### Production

All configuration via environment variables in the LaunchAgent plist — no `hive.yaml` parsing needed:

- **LaunchAgent:** `com.hive.<id>.admin`
- **Working directory:** `~/services/<id>/admin-bundle/`
- **Environment variables (in plist):**
  - `PORT` — `portBase + 5` (e.g. `3105`)
  - `MONGO_URL` — same MongoDB connection string as the main Hive service
  - `MAIL_URL` — Resend SMTP URL
  - `ROOT_URL` — `http://localhost:3105` (or the actual hostname)
  - `AVATARS_DIR` — `~/services/<id>/data/avatars/` (persistent across deploys)

The deploy script reads `portBase` from `hive.yaml` once and writes the computed port into the LaunchAgent plist's `EnvironmentVariables`. The Meteor app itself never reads `hive.yaml`.

### Build

Meteor builds to a standalone Node.js bundle:
```bash
cd admin/
meteor build ../build --directory
# Output: ../build/bundle/ — a plain Node app
# Run with: cd bundle && node main.js
```

The deploy script (`deploy.sh`) would:
1. Build the Meteor bundle
2. Copy to `~/services/<id>/admin-bundle/`
3. Run `npm install --production` inside the bundle
4. Ensure `AVATARS_DIR` exists
5. Restart the LaunchAgent

---

## Files Changed (Hive Core)

| File | Change |
|------|--------|
| `src/types/agent-definition.ts` | Add `avatar?: string` and `version: number` fields to `AgentDefinition`; add `source: string` to `AgentDefinitionVersion` |
| `src/admin/admin-api.ts` | Add optimistic locking (`version` filter + increment) to `updateAgent`, `toggleAgent`, `rollbackAgent`; add `source: "admin-api"` to version snapshots |
| `admin/` | New Meteor app (entire directory) |

The Meteor app and REST API are parallel write paths to the same MongoDB collections, coordinated by the `version` counter.

### Meteor packages (in `admin/.meteor/packages`)

- `accounts-passwordless` — magic code auth
- `ostrio:files` — file upload with local disk storage

### Key NPM dependencies (in `admin/package.json`)

- `@radix-ui/react-*` — Radix primitives for shadcn/ui components
- `react-dropzone` — Drag-and-drop file upload
- `clsx` + `tailwind-merge` — Class name utilities for `cn()`
- `lucide-react` — Icon library
- `sonner` — Toast notifications
- `class-variance-authority` — Variant styling for shadcn components

## Files NOT Changed

- **`src/agents/agent-runner.ts`** — no change needed; `avatar` field is UI-only for now
- **`src/beekeeper/`** — unaffected

### Known gap: `admin-mcp-server.ts` as a third write path

The admin MCP server writes to `agent_definitions` and `agent_definition_versions` but is **not updated in v1** to participate in the optimistic locking or `source` tracking. This means:

1. MCP writes won't increment `version`, so a concurrent MCP write during a UI edit session will cause a spurious conflict error in the UI on the next save.
2. Version snapshots created by the MCP server will have no `source` field.

**Why we defer this:** MCP writes are rare (beekeeper CLI only, not interactive editing) and the failure mode is benign — the UI refreshes with the latest data and the user re-applies their changes. Adding the lock to the MCP server is a future improvement.

**Future fix:** Add `version` filter + increment to `admin-mcp-server.ts` `updateOne` calls and add `source: "admin-mcp"` to version snapshots.

---

## Non-Goals (v1)

- Version history / diff / rollback UI (backend exists, UI later)
- System monitoring / live activity dashboard
- Schedule management UI
- Beekeeper frontend (Claude Code sessions from browser)
- Agent creation/deletion (use CLI or admin API for now — editor only)
- Roles and permissions beyond email whitelist
- Offline authentication (requires internet for email delivery)
