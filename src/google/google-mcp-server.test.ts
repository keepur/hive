import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

// Mock child_process
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

// Mock fs — mkdirSync and existsSync/readFileSync
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));

// Mock MCP SDK — capture registered tools
type ToolHandler = (...args: any[]) => any;
const registeredTools = new Map<string, { handler: ToolHandler }>();
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    registerTool: vi.fn((name: string, _opts: any, handler: ToolHandler) => {
      registeredTools.set(name, { handler });
    }),
    connect: vi.fn(),
  })),
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

async function loadServer(env: Record<string, string> = {}) {
  registeredTools.clear();
  const original = { ...process.env };
  Object.assign(process.env, env);
  // Reset module to re-evaluate with new env
  vi.resetModules();
  await import("./google-mcp-server.js");
  // Restore env
  for (const key of Object.keys(env)) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
}

function callTool(name: string, args: Record<string, any>) {
  const tool = registeredTools.get(name);
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool.handler(args);
}

describe("google-mcp-server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: gog binary found
    mockExecFileSync.mockImplementation((cmd: any, args: any) => {
      if (cmd === "which" && args?.[0] === "gog") return "/usr/local/bin/gog\n";
      return "";
    });
  });

  describe("drive_upload", () => {
    it("returns error when DRIVE_SHARED_FOLDER is not set", async () => {
      await loadServer({ GOG_PATH: "/usr/local/bin/gog", DRIVE_SHARED_FOLDER: "" });
      const result = await callTool("drive_upload", { file_path: "/tmp/test.csv" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not configured");
    });

    it("returns error when file does not exist", async () => {
      await loadServer({ GOG_PATH: "/usr/local/bin/gog", DRIVE_SHARED_FOLDER: "folder-123" });
      mockExistsSync.mockReturnValue(false);
      const result = await callTool("drive_upload", { file_path: "/tmp/missing.csv" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("File not found");
    });

    it("uploads file and returns summary", async () => {
      await loadServer({ GOG_PATH: "/usr/local/bin/gog", DRIVE_SHARED_FOLDER: "folder-123" });
      mockExistsSync.mockReturnValue(true);
      mockExecFileSync.mockImplementation((cmd: any, args: any) => {
        if (cmd === "which") return "/usr/local/bin/gog\n";
        // gog drive upload call
        if (args?.includes("drive") && args?.includes("upload")) {
          return JSON.stringify({ name: "report.csv", webViewLink: "https://drive.google.com/file/abc", id: "abc123" });
        }
        return "";
      });

      const result = await callTool("drive_upload", { file_path: "/tmp/report.csv" });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("Uploaded to Google Drive");
      expect(result.content[0].text).toContain("report.csv");
      expect(result.content[0].text).toContain("abc123");
    });

    it("uses custom name when provided", async () => {
      await loadServer({ GOG_PATH: "/usr/local/bin/gog", DRIVE_SHARED_FOLDER: "folder-123" });
      mockExistsSync.mockReturnValue(true);
      mockExecFileSync.mockImplementation((cmd: any, args: any) => {
        if (cmd === "which") return "/usr/local/bin/gog\n";
        if (args?.includes("upload")) {
          // Verify --name flag has custom name
          const nameIdx = args.indexOf("--name");
          const usedName = nameIdx >= 0 ? args[nameIdx + 1] : "unknown";
          return JSON.stringify({ name: usedName, id: "xyz" });
        }
        return "";
      });

      const result = await callTool("drive_upload", { file_path: "/tmp/data.csv", name: "Q1-Report.csv" });
      expect(result.content[0].text).toContain("Q1-Report.csv");
    });
  });

  describe("drive_download", () => {
    it("returns error when neither file_id nor url provided", async () => {
      await loadServer({ GOG_PATH: "/usr/local/bin/gog", DRIVE_SHARED_FOLDER: "folder-123" });
      const result = await callTool("drive_download", {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Provide either file_id or a Google Drive URL");
    });

    it("extracts file ID from Drive URL and uses deterministic --out path", async () => {
      await loadServer({ GOG_PATH: "/usr/local/bin/gog", DRIVE_SHARED_FOLDER: "folder-123" });
      let capturedArgs: string[] = [];
      mockExecFileSync.mockImplementation((cmd: any, args: any) => {
        if (cmd === "which") return "/usr/local/bin/gog\n";
        if (args?.includes("download")) {
          capturedArgs = args;
          return "";
        }
        return "";
      });

      await callTool("drive_download", { url: "https://drive.google.com/file/d/abc123/view" });
      expect(capturedArgs).toContain("abc123");
      // Should use --out with a deterministic file path (not a directory)
      const outIdx = capturedArgs.indexOf("--out");
      expect(outIdx).toBeGreaterThan(-1);
      expect(capturedArgs[outIdx + 1]).toMatch(/abc123$/);
    });

    it("extracts file ID from id= URL format", async () => {
      await loadServer({ GOG_PATH: "/usr/local/bin/gog", DRIVE_SHARED_FOLDER: "folder-123" });
      let capturedArgs: string[] = [];
      mockExecFileSync.mockImplementation((cmd: any, args: any) => {
        if (cmd === "which") return "/usr/local/bin/gog\n";
        if (args?.includes("download")) {
          capturedArgs = args;
          return "";
        }
        return "";
      });

      await callTool("drive_download", { url: "https://drive.google.com/open?id=xyz789" });
      expect(capturedArgs).toContain("xyz789");
    });

    it("returns inline content for text format exports", async () => {
      await loadServer({ GOG_PATH: "/usr/local/bin/gog", DRIVE_SHARED_FOLDER: "folder-123", INSTANCE_ID: "hive" });
      mockExecFileSync.mockImplementation((cmd: any, args: any) => {
        if (cmd === "which") return "/usr/local/bin/gog\n";
        if (args?.includes("download")) return "";
        return "";
      });
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("col1,col2\nval1,val2" as any);

      const result = await callTool("drive_download", { file_id: "abc123", format: "csv" });
      expect(result.content[0].text).toContain("--- Content ---");
      expect(result.content[0].text).toContain("col1,col2");
      expect(result.content[0].text).toContain("exported as csv");
    });

    it("returns deterministic path for non-text downloads", async () => {
      await loadServer({ GOG_PATH: "/usr/local/bin/gog", DRIVE_SHARED_FOLDER: "folder-123", INSTANCE_ID: "hive" });
      mockExecFileSync.mockImplementation((cmd: any, args: any) => {
        if (cmd === "which") return "/usr/local/bin/gog\n";
        if (args?.includes("download")) return "";
        return "";
      });
      mockExistsSync.mockReturnValue(false);

      const result = await callTool("drive_download", { file_id: "doc456", format: "pdf" });
      expect(result.content[0].text).toContain("doc456.pdf");
    });
  });

  describe("drive_list", () => {
    it("returns error when DRIVE_SHARED_FOLDER is not set", async () => {
      await loadServer({ GOG_PATH: "/usr/local/bin/gog", DRIVE_SHARED_FOLDER: "" });
      const result = await callTool("drive_list", {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not configured");
    });

    it("lists files with formatted output", async () => {
      await loadServer({ GOG_PATH: "/usr/local/bin/gog", DRIVE_SHARED_FOLDER: "folder-123" });
      let capturedArgs: string[] = [];
      mockExecFileSync.mockImplementation((cmd: any, args: any) => {
        if (cmd === "which") return "/usr/local/bin/gog\n";
        if (args?.includes("ls")) {
          capturedArgs = args;
          return JSON.stringify([
            { name: "permits.csv", size: "1024", modifiedTime: "2026-03-20T10:00:00Z", webViewLink: "https://drive.google.com/file/abc" },
          ]);
        }
        return "";
      });

      const result = await callTool("drive_list", { query: "permits", limit: 10 });
      expect(capturedArgs).toContain("--query");
      expect(capturedArgs).toContain("permits");
      expect(capturedArgs).toContain("--max=10");
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("📄 permits.csv");
      expect(result.content[0].text).toContain("https://drive.google.com/file/abc");
    });

    it("returns 'No files found' for empty array", async () => {
      await loadServer({ GOG_PATH: "/usr/local/bin/gog", DRIVE_SHARED_FOLDER: "folder-123" });
      mockExecFileSync.mockImplementation((cmd: any, args: any) => {
        if (cmd === "which") return "/usr/local/bin/gog\n";
        if (args?.includes("ls")) return "[]";
        return "";
      });

      const result = await callTool("drive_list", {});
      expect(result.content[0].text).toBe("No files found.");
    });

    it("falls back to raw output on parse error", async () => {
      await loadServer({ GOG_PATH: "/usr/local/bin/gog", DRIVE_SHARED_FOLDER: "folder-123" });
      mockExecFileSync.mockImplementation((cmd: any, args: any) => {
        if (cmd === "which") return "/usr/local/bin/gog\n";
        if (args?.includes("ls")) return "not valid json";
        return "";
      });

      const result = await callTool("drive_list", {});
      expect(result.content[0].text).toBe("not valid json");
    });

    it("uses default limit of 20", async () => {
      await loadServer({ GOG_PATH: "/usr/local/bin/gog", DRIVE_SHARED_FOLDER: "folder-123" });
      let capturedArgs: string[] = [];
      mockExecFileSync.mockImplementation((cmd: any, args: any) => {
        if (cmd === "which") return "/usr/local/bin/gog\n";
        if (args?.includes("ls")) {
          capturedArgs = args;
          return "[]";
        }
        return "";
      });

      await callTool("drive_list", {});
      expect(capturedArgs).toContain("--max=20");
    });
  });

  describe("tool registration", () => {
    it("registers all expected tools", async () => {
      await loadServer({ GOG_PATH: "/usr/local/bin/gog" });
      const expected = [
        "gmail_search",
        "gmail_get",
        "gmail_thread",
        "gmail_send",
        "calendar_list",
        "calendar_events",
        "calendar_search",
        "calendar_create",
        "calendar_freebusy",
        "drive_upload",
        "drive_download",
        "drive_list",
      ];
      for (const name of expected) {
        expect(registeredTools.has(name), `expected tool "${name}" to be registered`).toBe(true);
      }
    });
  });
});
