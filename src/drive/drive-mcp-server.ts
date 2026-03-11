#!/usr/bin/env node
/**
 * Google Drive MCP Server — upload/download files via the shared company Drive.
 *
 * Uses the `gws` CLI (Google Workspace CLI) authenticated as bot@dodihome.com.
 * All uploads go to a configured shared Drive folder.
 *
 * Env vars:
 *   GWS_PATH             — path to gws binary (auto-detected if unset)
 *   DRIVE_SHARED_FOLDER   — Google Drive folder ID for uploads
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";

const SHARED_FOLDER = process.env.DRIVE_SHARED_FOLDER ?? "";
const GWS =
  process.env.GWS_PATH ||
  (() => {
    try {
      return execFileSync("which", ["gws"], { encoding: "utf-8" }).trim();
    } catch {
      return "gws";
    }
  })();
const DOWNLOAD_DIR = join(tmpdir(), "hive-drive-downloads");
mkdirSync(DOWNLOAD_DIR, { recursive: true });

function gws(args: string[]): string {
  return execFileSync(GWS, args, { encoding: "utf-8", timeout: 60_000 }).trim();
}

const server = new McpServer({
  name: "hive-drive",
  version: "0.1.0",
});

// ── Upload File ─────────────────────────────────────────────────────────

server.registerTool(
  "drive_upload",
  {
    title: "Upload File to Google Drive",
    description:
      "Upload a local file to the company shared Google Drive folder. " +
      "Returns a shareable link. Use this to share CSVs, reports, documents with the team. " +
      "The file must exist on the local filesystem (e.g. from permit_export_csv or other export tools).",
    inputSchema: {
      file_path: z.string().describe("Absolute path to the local file to upload"),
      name: z.string().optional().describe("Override the filename in Drive (defaults to local filename)"),
    },
  },
  async ({ file_path, name }) => {
    if (!SHARED_FOLDER) {
      return {
        content: [{ type: "text", text: "Drive shared folder not configured (DRIVE_SHARED_FOLDER)." }],
        isError: true,
      };
    }

    if (!existsSync(file_path)) {
      return { content: [{ type: "text", text: `File not found: ${file_path}` }], isError: true };
    }

    const fileName = name || basename(file_path);

    try {
      // Upload with metadata
      const params = JSON.stringify({ uploadType: "multipart", supportsAllDrives: true });
      const meta = JSON.stringify({ name: fileName, parents: [SHARED_FOLDER] });
      const result = gws(["drive", "files", "create", "--params", params, "--json", meta, "--upload", file_path]);
      const data = JSON.parse(result);

      if (!data.id) {
        return { content: [{ type: "text", text: `Upload failed: ${result}` }], isError: true };
      }

      // Get shareable link
      const fields = JSON.stringify({
        fileId: data.id,
        fields: "id,name,webViewLink,webContentLink",
        supportsAllDrives: true,
      });
      const info = gws(["drive", "files", "get", "--params", fields]);
      const fileInfo = JSON.parse(info);

      const summary = [
        `Uploaded to Google Drive`,
        `  Name: ${fileInfo.name}`,
        `  View: ${fileInfo.webViewLink}`,
        ...(fileInfo.webContentLink ? [`  Download: ${fileInfo.webContentLink}`] : []),
        `  File ID: ${data.id}`,
      ].join("\n");

      return { content: [{ type: "text", text: summary }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Upload failed: ${e.message}` }], isError: true };
    }
  },
);

// ── Download File ───────────────────────────────────────────────────────

server.registerTool(
  "drive_download",
  {
    title: "Download File from Google Drive",
    description:
      "Download a file from Google Drive to the local filesystem for processing. " +
      "Provide either a file ID or a Drive URL. Returns the local file path.",
    inputSchema: {
      file_id: z.string().optional().describe("Google Drive file ID"),
      url: z.string().optional().describe("Google Drive URL (file ID will be extracted)"),
    },
  },
  async ({ file_id, url }) => {
    let id = file_id;

    if (!id && url) {
      // Extract file ID from various Drive URL formats
      const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/) ?? url.match(/id=([a-zA-Z0-9_-]+)/);
      if (match) id = match[1];
    }

    if (!id) {
      return { content: [{ type: "text", text: "Provide either file_id or a Google Drive URL." }], isError: true };
    }

    // Google-native MIME types that need export instead of direct download
    const EXPORT_MIME: Record<string, { ext: string; mime: string }> = {
      "application/vnd.google-apps.document": { ext: ".txt", mime: "text/plain" },
      "application/vnd.google-apps.spreadsheet": { ext: ".csv", mime: "text/csv" },
      "application/vnd.google-apps.presentation": { ext: ".txt", mime: "text/plain" },
    };

    try {
      // Get file metadata first
      const fields = JSON.stringify({ fileId: id, fields: "id,name,mimeType,size", supportsAllDrives: true });
      const info = gws(["drive", "files", "get", "--params", fields]);
      const meta = JSON.parse(info);
      const isGoogleNative = meta.mimeType in EXPORT_MIME;
      const exportInfo = isGoogleNative ? EXPORT_MIME[meta.mimeType] : null;
      const fileName = (meta.name || `drive-${id}`) + (exportInfo?.ext ?? "");
      const localPath = join(DOWNLOAD_DIR, fileName);

      if (isGoogleNative) {
        // Google Docs/Sheets/Slides must be exported, not downloaded with alt:media
        const exportParams = JSON.stringify({ fileId: id, mimeType: exportInfo!.mime });
        gws(["drive", "files", "export", "--params", exportParams, "--output", localPath]);
      } else {
        // Regular files: download with alt:media
        const dlParams = JSON.stringify({ fileId: id, alt: "media", supportsAllDrives: true });
        gws(["drive", "files", "get", "--params", dlParams, "--output", localPath]);
      }

      if (!existsSync(localPath)) {
        return { content: [{ type: "text", text: `Download failed — file not saved.` }], isError: true };
      }

      // For text-based exports, return the content directly so the agent can read it
      if (isGoogleNative) {
        const { readFileSync } = await import("node:fs");
        const content = readFileSync(localPath, "utf-8");
        const summary = [
          `Google ${meta.mimeType.split(".").pop()} exported as ${exportInfo!.ext.slice(1)}`,
          `  Name: ${meta.name}`,
          `  Local path: ${localPath}`,
          ``,
          `--- Content ---`,
          content,
        ].join("\n");
        return { content: [{ type: "text", text: summary }] };
      }

      const summary = [
        `Downloaded from Google Drive`,
        `  Name: ${meta.name || fileName}`,
        `  Type: ${meta.mimeType || "unknown"}`,
        `  Local path: ${localPath}`,
      ].join("\n");

      return { content: [{ type: "text", text: summary }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Download failed: ${e.message}` }], isError: true };
    }
  },
);

// ── List Files ──────────────────────────────────────────────────────────

server.registerTool(
  "drive_list",
  {
    title: "List Files in Shared Drive Folder",
    description:
      "List files in the company shared Drive folder. Useful to see what reports and documents have been shared.",
    inputSchema: {
      query: z.string().optional().describe("Search query to filter files (e.g. 'permits' or 'name contains report')"),
      limit: z.number().optional().default(20).describe("Max results (default 20)"),
    },
  },
  async ({ query, limit }) => {
    if (!SHARED_FOLDER) {
      return { content: [{ type: "text", text: "Drive shared folder not configured." }], isError: true };
    }

    try {
      let q = `'${SHARED_FOLDER}' in parents and trashed = false`;
      if (query) q += ` and (name contains '${query.replace(/'/g, "\\'")}')`;

      const params = JSON.stringify({
        q,
        pageSize: Math.min(limit ?? 20, 100),
        fields: "files(id,name,mimeType,createdTime,webViewLink,size)",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        corpora: "allDrives",
      });
      const result = gws(["drive", "files", "list", "--params", params]);
      const data = JSON.parse(result);

      if (!data.files?.length) {
        return { content: [{ type: "text", text: "No files found." }] };
      }

      const lines = data.files.map((f: any) => {
        const size = f.size ? `${(Number(f.size) / 1024).toFixed(1)} KB` : "";
        const date = f.createdTime ? new Date(f.createdTime).toLocaleDateString() : "";
        return `${f.name}  ${size}  ${date}\n  ${f.webViewLink}`;
      });

      return { content: [{ type: "text", text: `${data.files.length} files:\n\n${lines.join("\n\n")}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `List failed: ${e.message}` }], isError: true };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
