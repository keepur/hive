# Cases MCP Tools Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose dodi_v2 cases API (CRUD, transitions, assign, resolve, issues sub-resource) as MCP tools in the dodi-ops server, matching existing patterns for projects/jobs.

**Architecture:** Add cases and case-issues tool registrations to `dodi-ops-mcp-server.ts`, following the read/write mode split already used for projects, jobs, cutlists, etc. The API shape maps 1:1 to dodi_v2's `/api/v1/cases` endpoints.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, Zod schemas, dodi_v2 REST API

---

## File Structure

- **Modify:** `plugins/dodi/mcp-servers/dodi-ops/dodi-ops-mcp-server.ts` — add Cases and Case Issues sections
- **Modify:** `plugins/dodi/mcp-servers/dodi-ops/dodi-ops-mcp-server.ts` header comment (line 1-13) — add Cases + Case Issues to the list

No new files needed. This follows the established pattern of adding entity tools to the existing dodi-ops MCP server.

---

## Chunk 1: Cases CRUD Tools

### Task 1: Update file header comment

**Files:**
- Modify: `plugins/dodi/mcp-servers/dodi-ops/dodi-ops-mcp-server.ts:1-13`

- [ ] **Step 1: Update the doc comment to include Cases and Case Issues**

Replace lines 6-12 of the header comment:

```typescript
 * - Persons: search, detail, CRUD
 * - Projects: list, detail, CRUD, person management
 * - Designs: list, detail, BOM, create
 * - Jobs: CRUD + lifecycle (state transitions, link design/order, refresh)
 * - Cases: CRUD + lifecycle (state transitions, assign, resolve) + issues sub-resource
 * - Comments: CRUD on any entity
 * - Attachments: list, detail, download URL
 * - Cutlists: list, detail, parts
```

- [ ] **Step 2: Commit**

```bash
git add plugins/dodi/mcp-servers/dodi-ops/dodi-ops-mcp-server.ts
git commit -m "docs: add cases to dodi-ops MCP server header"
```

### Task 2: Cases — Read tools (list + get)

**Files:**
- Modify: `plugins/dodi/mcp-servers/dodi-ops/dodi-ops-mcp-server.ts` — insert after Cutlists Write section (after line 958), before the Connect section

- [ ] **Step 1: Add `dodi_cases_list` tool**

Insert after line 958 (end of cutlists delete tool), before the Connect comment block:

```typescript
// ---------------------------------------------------------------------------
// Cases — Read
// ---------------------------------------------------------------------------

server.registerTool(
  "dodi_cases_list",
  {
    title: "List Cases",
    description:
      "List cases with optional filters. Cases track customer service issues, warranty claims, complaints, and sales support requests.",
    inputSchema: {
      state: z.string().optional().describe("Filter by state (comma-separated, e.g. 'OPEN,IN_PROGRESS')"),
      type: z
        .enum(["customer_service", "sales_support", "warranty", "complaint"])
        .optional()
        .describe("Filter by case type"),
      priority: z.number().optional().describe("Filter by priority (1=low, 2=normal, 3=high, 4=urgent)"),
      assignedTo: z.string().optional().describe("Filter by assignee user ID"),
      projectId: z.string().optional().describe("Filter by referenced project ID"),
      search: z.string().optional().describe("Search by name, number, or customer"),
      limit: z.number().optional().default(20).describe("Max results (default 20, max 250)"),
      offset: z.number().optional().default(0).describe("Offset for pagination"), // cases API uses 'offset', not 'skip'
    },
  },
  async (input) => {
    try {
      const params = new URLSearchParams();
      if (input.state) params.set("state", input.state);
      if (input.type) params.set("type", input.type);
      if (input.priority) params.set("priority", String(input.priority));
      if (input.assignedTo) params.set("assignedTo", input.assignedTo);
      if (input.projectId) params.set("projectId", input.projectId);
      if (input.search) params.set("search", input.search);
      if (input.limit) params.set("limit", String(input.limit));
      if (input.offset) params.set("offset", String(input.offset));
      const qs = params.toString();
      return ok(await api("GET", `/cases${qs ? `?${qs}` : ""}`));
    } catch (e) {
      return err(e);
    }
  },
);
```

- [ ] **Step 2: Add `dodi_cases_get` tool**

```typescript
server.registerTool(
  "dodi_cases_get",
  {
    title: "Get Case Detail",
    description: "Get full details for a case by ID, including issues, references, and resolution info.",
    inputSchema: {
      caseId: z.string().describe("Case ID"),
    },
  },
  async ({ caseId }) => {
    try {
      return ok(await api("GET", `/cases/${caseId}`));
    } catch (e) {
      return err(e);
    }
  },
);
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add plugins/dodi/mcp-servers/dodi-ops/dodi-ops-mcp-server.ts
git commit -m "feat: add cases list/get read tools to dodi-ops MCP"
```

### Task 3: Cases — Write tools (create, update, delete)

**Files:**
- Modify: `plugins/dodi/mcp-servers/dodi-ops/dodi-ops-mcp-server.ts` — insert Cases Write section after Cases Read

- [ ] **Step 1: Add Cases Write block with create, update, delete**

```typescript
// ---------------------------------------------------------------------------
// Cases — Write (full mode only)
// ---------------------------------------------------------------------------

if (MODE === "full") {
  server.registerTool(
    "dodi_cases_create",
    {
      title: "Create Case",
      description:
        "Create a new case. Cases track customer issues, warranty claims, complaints, and sales support requests.",
      inputSchema: {
        name: z.string().describe("Case name/title"),
        type: z
          .enum(["customer_service", "sales_support", "warranty", "complaint"])
          .optional()
          .describe("Case type"),
        priority: z.number().optional().describe("Priority (1=low, 2=normal, 3=high, 4=urgent)"),
        source: z.enum(["phone", "email", "in_person", "website", "other"]).optional().describe("How the case originated"),
        description: z.string().optional().describe("Detailed description (supports HTML)"),
        customer: z.string().optional().describe("Customer name (free-form, when no Person record)"),
        projectId: z.string().optional().describe("Link to a project"),
        dealId: z.string().optional().describe("Link to a deal"),
        jobId: z.string().optional().describe("Link to a job"),
        contactId: z.string().optional().describe("Link to a contact person"),
        dueDate: z.string().optional().describe("ISO-8601 due date"),
        assignedTo: z
          .object({
            personId: z.string().describe("Assignee person ID"),
            name: z.string().describe("Assignee display name"),
          })
          .optional()
          .describe("Assign to a person"),
      },
    },
    async (input) => {
      try {
        return ok(await api("POST", "/cases", input));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "dodi_cases_update",
    {
      title: "Update Case",
      description: "Update case fields (name, type, priority, source, description, customer, dueDate).",
      inputSchema: {
        caseId: z.string().describe("Case ID to update"),
        name: z.string().optional().describe("New name"),
        type: z
          .enum(["customer_service", "sales_support", "warranty", "complaint"])
          .optional()
          .describe("New type"),
        priority: z.number().optional().describe("New priority (1=low, 2=normal, 3=high, 4=urgent)"),
        source: z.enum(["phone", "email", "in_person", "website", "other"]).optional().describe("New source"),
        description: z.string().optional().describe("New description"),
        customer: z.string().nullable().optional().describe("New customer name (null to clear)"),
        dueDate: z.string().nullable().optional().describe("New ISO-8601 due date (null to clear)"),
      },
    },
    async ({ caseId, ...body }) => {
      try {
        return ok(await api("PUT", `/cases/${caseId}`, body));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "dodi_cases_delete",
    {
      title: "Delete Case",
      description: "Delete a case.",
      inputSchema: {
        caseId: z.string().describe("Case ID to delete"),
      },
    },
    async ({ caseId }) => {
      try {
        return ok(await api("DELETE", `/cases/${caseId}`));
      } catch (e) {
        return err(e);
      }
    },
  );
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add plugins/dodi/mcp-servers/dodi-ops/dodi-ops-mcp-server.ts
git commit -m "feat: add cases create/update/delete write tools to dodi-ops MCP"
```

### Task 4: Cases — Lifecycle tools (transition, assign, resolve)

**Files:**
- Modify: `plugins/dodi/mcp-servers/dodi-ops/dodi-ops-mcp-server.ts` — append inside the Cases Write `if (MODE === "full")` block

- [ ] **Step 1: Add transition, assign, resolve tools**

Append before the closing `}` of the Cases Write block:

```typescript
  server.registerTool(
    "dodi_cases_transition",
    {
      title: "Transition Case State",
      description: "Advance a case to a new state (OPEN → IN_PROGRESS → RESOLVED).",
      inputSchema: {
        caseId: z.string().describe("Case ID"),
        toState: z.string().describe("Target state (OPEN, IN_PROGRESS, RESOLVED)"),
      },
    },
    async ({ caseId, toState }) => {
      try {
        return ok(await api("POST", `/cases/${caseId}/transition`, { toState }));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "dodi_cases_assign",
    {
      title: "Assign Case",
      description: "Assign a case to a person, or pass null to unassign.",
      inputSchema: {
        caseId: z.string().describe("Case ID"),
        assignee: z
          .object({
            personId: z.string().describe("Person ID"),
            name: z.string().describe("Display name"),
          })
          .nullable()
          .describe("Assignee (null to unassign)"),
      },
    },
    async ({ caseId, assignee }) => {
      try {
        return ok(await api("POST", `/cases/${caseId}/assign`, { assignee }));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "dodi_cases_resolve",
    {
      title: "Resolve Case",
      description:
        "Resolve a case with a resolution summary. Transitions to RESOLVED and records who resolved it and when.",
      inputSchema: {
        caseId: z.string().describe("Case ID"),
        resolution: z.string().describe("Resolution summary explaining how the case was resolved"),
      },
    },
    async ({ caseId, resolution }) => {
      try {
        return ok(await api("POST", `/cases/${caseId}/resolve`, { resolution }));
      } catch (e) {
        return err(e);
      }
    },
  );
} // end Cases Write block
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add plugins/dodi/mcp-servers/dodi-ops/dodi-ops-mcp-server.ts
git commit -m "feat: add cases transition/assign/resolve lifecycle tools"
```

## Chunk 2: Case Issues Sub-Resource Tools

### Task 5: Case Issues — Read tools

**Files:**
- Modify: `plugins/dodi/mcp-servers/dodi-ops/dodi-ops-mcp-server.ts` — insert after Cases Write block

- [ ] **Step 1: Add case issues list and get tools**

```typescript
// ---------------------------------------------------------------------------
// Case Issues — Read
// ---------------------------------------------------------------------------

server.registerTool(
  "dodi_case_issues_list",
  {
    title: "List Case Issues",
    description: "List issues for a specific case. Issues are individual problems or action items within a case.",
    inputSchema: {
      caseId: z.string().describe("Case ID"),
    },
  },
  async ({ caseId }) => {
    try {
      return ok(await api("GET", `/cases/${caseId}/issues`));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "dodi_case_issues_get",
  {
    title: "Get Case Issue Detail",
    description: "Get full details for a specific issue within a case.",
    inputSchema: {
      caseId: z.string().describe("Case ID"),
      issueId: z.string().describe("Issue ID"),
    },
  },
  async ({ caseId, issueId }) => {
    try {
      return ok(await api("GET", `/cases/${caseId}/issues/${issueId}`));
    } catch (e) {
      return err(e);
    }
  },
);
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add plugins/dodi/mcp-servers/dodi-ops/dodi-ops-mcp-server.ts
git commit -m "feat: add case issues list/get read tools"
```

### Task 6: Case Issues — Write tools

**Files:**
- Modify: `plugins/dodi/mcp-servers/dodi-ops/dodi-ops-mcp-server.ts` — insert Case Issues Write block

- [ ] **Step 1: Add case issues create, update, delete, transition tools**

```typescript
// ---------------------------------------------------------------------------
// Case Issues — Write (full mode only)
// ---------------------------------------------------------------------------

if (MODE === "full") {
  server.registerTool(
    "dodi_case_issues_create",
    {
      title: "Create Case Issue",
      description: "Create a new issue within a case. Issues represent individual problems or action items.",
      inputSchema: {
        caseId: z.string().describe("Case ID"),
        name: z.string().describe("Issue name/title"),
        description: z.string().optional().describe("Issue details"),
        priority: z.number().optional().describe("Priority (1=low, 2=normal, 3=high, 4=urgent)"),
        dueDate: z.string().optional().describe("ISO-8601 due date"),
        eta: z.string().optional().describe("ISO-8601 customer-facing ETA"),
      },
    },
    async ({ caseId, ...body }) => {
      try {
        return ok(await api("POST", `/cases/${caseId}/issues`, body));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "dodi_case_issues_update",
    {
      title: "Update Case Issue",
      description: "Update a case issue's fields.",
      inputSchema: {
        caseId: z.string().describe("Case ID"),
        issueId: z.string().describe("Issue ID to update"),
        name: z.string().optional().describe("New name"),
        description: z.string().optional().describe("New description"),
        priority: z.number().optional().describe("New priority (1-4)"),
        dueDate: z.string().nullable().optional().describe("New due date (null to clear)"),
        eta: z.string().nullable().optional().describe("New ETA (null to clear)"),
        assignedTo: z
          .object({
            userId: z.string().describe("User ID"),
            displayName: z.string().describe("Display name"),
          })
          .nullable()
          .optional()
          .describe("Assignee (null to unassign)"),
        resolution: z.string().optional().describe("Resolution summary"),
      },
    },
    async ({ caseId, issueId, ...body }) => {
      try {
        return ok(await api("PUT", `/cases/${caseId}/issues/${issueId}`, body));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "dodi_case_issues_delete",
    {
      title: "Delete Case Issue",
      description: "Delete an issue from a case.",
      inputSchema: {
        caseId: z.string().describe("Case ID"),
        issueId: z.string().describe("Issue ID to delete"),
      },
    },
    async ({ caseId, issueId }) => {
      try {
        return ok(await api("DELETE", `/cases/${caseId}/issues/${issueId}`));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "dodi_case_issues_transition",
    {
      title: "Transition Case Issue State",
      description: "Transition an issue to a new state (OPEN → RESOLVED).",
      inputSchema: {
        caseId: z.string().describe("Case ID"),
        issueId: z.string().describe("Issue ID"),
        toState: z.string().describe("Target state (OPEN, RESOLVED)"),
      },
    },
    async ({ caseId, issueId, toState }) => {
      try {
        return ok(await api("POST", `/cases/${caseId}/issues/${issueId}/transition`, { toState }));
      } catch (e) {
        return err(e);
      }
    },
  );
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add plugins/dodi/mcp-servers/dodi-ops/dodi-ops-mcp-server.ts
git commit -m "feat: add case issues CRUD + transition write tools"
```

### Task 7: Final verification

- [ ] **Step 1: Run full check suite**

Run: `npm run check`
Expected: all pass (typecheck, lint, format, test)

- [ ] **Step 2: Fix any lint/format issues**

Run: `npm run format` if needed, then re-run `npm run check`

- [ ] **Step 3: Final commit if format changed anything**

```bash
git add plugins/dodi/mcp-servers/dodi-ops/dodi-ops-mcp-server.ts
git commit -m "style: format cases MCP tools"
```

---

## Tools Summary

| Tool Name | Mode | Endpoint |
|---|---|---|
| `dodi_cases_list` | read | `GET /cases` |
| `dodi_cases_get` | read | `GET /cases/:id` |
| `dodi_cases_create` | write | `POST /cases` |
| `dodi_cases_update` | write | `PUT /cases/:id` |
| `dodi_cases_delete` | write | `DELETE /cases/:id` |
| `dodi_cases_transition` | write | `POST /cases/:id/transition` |
| `dodi_cases_assign` | write | `POST /cases/:id/assign` |
| `dodi_cases_resolve` | write | `POST /cases/:id/resolve` |
| `dodi_case_issues_list` | read | `GET /cases/:id/issues` |
| `dodi_case_issues_get` | read | `GET /cases/:id/issues/:issueId` |
| `dodi_case_issues_create` | write | `POST /cases/:id/issues` |
| `dodi_case_issues_update` | write | `PUT /cases/:id/issues/:issueId` |
| `dodi_case_issues_delete` | write | `DELETE /cases/:id/issues/:issueId` |
| `dodi_case_issues_transition` | write | `POST /cases/:id/issues/:issueId/transition` |

**Note:** The `POST /cases/:id/analyze` endpoint (AI-powered issue extraction) is intentionally excluded — it's an internal server-side operation, not an agent-facing tool.
