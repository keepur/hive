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
 * Naming convention: the `honeypot` CLI stores each secret under a full service name
 * `<prefix>/<KEY>` with the account set to `<KEY>` (e.g. service="hive/dodi/GITHUB_TOKEN",
 * account="GITHUB_TOKEN"). `secret_get` requires that exact full service name — the
 * default (bare prefix) only matches a secret literally stored at the prefix itself.
 * The reliable pattern is: call `secret_list` first, then pass a row's service+account
 * verbatim into `secret_get`.
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
    description: `Retrieve a secret from macOS Keychain. Lookup is an EXACT match on service+account — not a prefix search. Secrets stored by the \`honeypot\` CLI use service="${SERVICE_PREFIX}/<KEY>" and account="<KEY>" (e.g. service="${SERVICE_PREFIX}/GITHUB_TOKEN", account="GITHUB_TOKEN"). If you don't know the exact service name, call \`secret_list\` first and pass a row's service+account verbatim. The \`service\` default ("${SERVICE_PREFIX}") only matches a secret literally stored at the bare prefix, which is uncommon.`,
    inputSchema: {
      account: z
        .string()
        .describe(
          'The account/label the secret was stored under. For honeypot-stored secrets, this equals the key name (e.g. "GITHUB_TOKEN", "SLACK_BOT_TOKEN").',
        ),
      service: z
        .string()
        .optional()
        .describe(
          `Exact service name the secret is stored under — typically "${SERVICE_PREFIX}/<KEY>". Must start with "${SERVICE_PREFIX}". Defaults to "${SERVICE_PREFIX}" (bare prefix) only as a fallback; usually you should pass the full service shown by secret_list.`,
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
        content: [
          {
            type: "text",
            text:
              `Secret not found: service="${resolved.service}" account="${account}". ` +
              `Lookup is an exact match on both fields. If you passed only the account (defaulting service to "${SERVICE_PREFIX}"), try the full service — honeypot stores under "${SERVICE_PREFIX}/<KEY>". Run secret_list to see exact service+account pairs.`,
          },
        ],
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
              text: `No secrets found under "${resolved.service}". The CEO can add them with:\n  honeypot set <KEY>\n…or directly:\n  security add-generic-password -s "${resolved.service}/<KEY>" -a "<KEY>" -w "<value>" -U`,
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
