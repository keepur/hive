#!/usr/bin/env node

/**
 * Keychain MCP Server — read-only access to macOS Keychain secrets.
 * Agents can retrieve secrets but only the CEO can store them (via `security add-generic-password`).
 *
 * Secrets are scoped by a service-name prefix set via KEYCHAIN_SERVICE (e.g. "hive/dodi").
 * Tools accept an optional `service` argument; if omitted it defaults to the prefix. When
 * provided, it must start with the prefix — this keeps instances isolated and prevents
 * agents from reading arbitrary keychain entries.
 *
 * Example (instance id "dodi" → prefix "hive/dodi"):
 *   security add-generic-password -s "hive/dodi/db/readonly" -a "hive-readonly" -w "..." -U
 *   security add-generic-password -s "hive/dodi/api/stripe" -a "live-key"       -w "..." -U
 *
 * Env vars:
 *   KEYCHAIN_SERVICE — service-name prefix (default: "hive")
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFileSync } from "node:child_process";

const SERVICE_PREFIX = process.env.KEYCHAIN_SERVICE ?? "hive";

const server = new McpServer({
  name: "hive-keychain",
  version: "0.2.0",
});

function resolveService(service: string | undefined): { ok: true; service: string } | { ok: false; error: string } {
  const svc = service ?? SERVICE_PREFIX;
  if (svc !== SERVICE_PREFIX && !svc.startsWith(SERVICE_PREFIX + "/")) {
    return {
      ok: false,
      error: `service "${svc}" is outside this instance's allowed prefix "${SERVICE_PREFIX}"`,
    };
  }
  return { ok: true, service: svc };
}

server.registerTool(
  "secret_get",
  {
    title: "Get Secret",
    description: `Retrieve a secret from macOS Keychain. Secrets for this instance live under service-prefix "${SERVICE_PREFIX}" — pass the full service name (e.g. "${SERVICE_PREFIX}/db/readonly") plus the account. If service is omitted it defaults to "${SERVICE_PREFIX}".`,
    inputSchema: {
      account: z.string().describe('The account/label for the secret, e.g. "hive-readonly", "google-oauth-token"'),
      service: z
        .string()
        .optional()
        .describe(
          `Full service name for the secret. Must start with "${SERVICE_PREFIX}". Defaults to "${SERVICE_PREFIX}".`,
        ),
    },
  },
  async ({ account, service }) => {
    const resolved = resolveService(service);
    if (!resolved.ok) {
      return { content: [{ type: "text", text: resolved.error }], isError: true };
    }
    try {
      const password = execFileSync(
        "security",
        ["find-generic-password", "-s", resolved.service, "-a", account, "-w"],
        { encoding: "utf-8", timeout: 5000 },
      ).trim();
      return { content: [{ type: "text", text: password }] };
    } catch {
      return {
        content: [{ type: "text", text: `Secret not found: service="${resolved.service}" account="${account}"` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "secret_list",
  {
    title: "List Secrets",
    description: `List secrets in macOS Keychain whose service starts with "${SERVICE_PREFIX}" (or a narrower prefix you provide via "service"). Returns "service\taccount" lines — values are never returned.`,
    inputSchema: {
      service: z
        .string()
        .optional()
        .describe(
          `Narrow the listing to services starting with this prefix. Must start with "${SERVICE_PREFIX}". Defaults to "${SERVICE_PREFIX}".`,
        ),
    },
  },
  async ({ service }) => {
    const resolved = resolveService(service);
    if (!resolved.ok) {
      return { content: [{ type: "text", text: resolved.error }], isError: true };
    }
    try {
      const raw = execFileSync("security", ["dump-keychain"], { encoding: "utf-8", timeout: 5000 });
      const entries: string[] = [];
      const blocks = raw.split("keychain:");
      for (const block of blocks) {
        const svceMatch = block.match(/"svce"<blob>="([^"]+)"/);
        if (!svceMatch) continue;
        const svce = svceMatch[1];
        if (svce !== resolved.service && !svce.startsWith(resolved.service + "/")) continue;
        const acctMatch = block.match(/"acct"<blob>="([^"]+)"/);
        if (acctMatch) entries.push(`${svce}\t${acctMatch[1]}`);
      }
      if (entries.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No secrets found under "${resolved.service}". The CEO can add them with:\nsecurity add-generic-password -s "${resolved.service}/<name>" -a "<account>" -w "<value>" -U`,
            },
          ],
        };
      }
      return { content: [{ type: "text", text: entries.join("\n") }] };
    } catch {
      return { content: [{ type: "text", text: "Failed to read keychain." }], isError: true };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
