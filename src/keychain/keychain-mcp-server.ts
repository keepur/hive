#!/usr/bin/env node

/**
 * Keychain MCP Server — read-only access to macOS Keychain secrets.
 * Agents can retrieve secrets but only the CEO can store them (via `security add-generic-password`).
 *
 * All Hive secrets use service name "hive". Store them like:
 *   security add-generic-password -s "hive" -a "rae-virtual-card" -w "4111111111111111" -U
 *   security add-generic-password -s "hive" -a "google-oauth-token" -w "ya29.xxx" -U
 *
 * Env vars:
 *   KEYCHAIN_SERVICE — service name filter (default: "hive")
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync } from "node:child_process";

const SERVICE = process.env.KEYCHAIN_SERVICE ?? "hive";

function run(command: string): string {
  return execSync(command, { encoding: "utf-8", timeout: 5000 }).trim();
}

const server = new McpServer({
  name: "hive-keychain",
  version: "0.1.0",
});

server.registerTool("secret_get", {
  title: "Get Secret",
  description: `Retrieve a secret from macOS Keychain. All Hive secrets are stored under service "${SERVICE}".`,
  inputSchema: {
    account: z.string().describe('The account/label for the secret, e.g. "rae-virtual-card", "google-oauth-token"'),
  },
}, async ({ account }) => {
  try {
    const password = run(`security find-generic-password -s "${SERVICE}" -a "${account}" -w`);
    return { content: [{ type: "text", text: password }] };
  } catch {
    return { content: [{ type: "text", text: `Secret not found: ${account}` }], isError: true };
  }
});

server.registerTool("secret_list", {
  title: "List Secrets",
  description: `List available secret names in macOS Keychain under service "${SERVICE}". Returns account names only, not the values.`,
  inputSchema: {},
}, async () => {
  try {
    // Dump all generic passwords, grep for our service, extract account names
    const raw = run(`security dump-keychain | grep -A4 'svce.*"${SERVICE}"' | grep '"acct"' | sed 's/.*="//;s/"$//'`);
    const accounts = raw.split("\n").filter(Boolean);
    if (accounts.length === 0) {
      return { content: [{ type: "text", text: "No secrets stored yet. The CEO can add them with:\nsecurity add-generic-password -s \"hive\" -a \"name\" -w \"value\" -U" }] };
    }
    return { content: [{ type: "text", text: accounts.join("\n") }] };
  } catch {
    return { content: [{ type: "text", text: "No secrets found for this service." }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
