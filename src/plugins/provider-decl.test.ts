import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_ROUTABLE_PREFIXES,
  PROVIDER_ID_REGEX,
  RESERVED_PROVIDER_IDS,
  auditInstalledProviderDecls,
  normalizeProviderDecl,
  readInstalledProviderDecls,
  validateProviderDecl,
} from "./provider-decl.js";

const FULL_RAW = {
  id: "sol",
  entry: "provider.ts",
  abi: 1,
  "session-semantics": "stateless-replay",
  "default-model": "sol-large-2",
  "api-key-env": "SOL_API_KEY",
  "base-url-env": "SOL_BASE_URL",
  description: "Sol frontier models",
};

function decl(overrides: Record<string, unknown> = {}) {
  return normalizeProviderDecl({ ...FULL_RAW, ...overrides });
}

describe("normalizeProviderDecl", () => {
  it("full kebab-key block round-trips", () => {
    expect(normalizeProviderDecl(FULL_RAW)).toEqual({
      id: "sol",
      entry: "provider.ts",
      abi: 1,
      sessionSemantics: "stateless-replay",
      defaultModel: "sol-large-2",
      apiKeyEnv: "SOL_API_KEY",
      baseUrlEnv: "SOL_BASE_URL",
      description: "Sol frontier models",
    });
  });

  it("minimal block leaves optionals undefined", () => {
    const d = normalizeProviderDecl({
      id: "sol",
      entry: "provider.ts",
      abi: 1,
      "session-semantics": "server-resumable",
    });
    expect(d.defaultModel).toBeUndefined();
    expect(d.apiKeyEnv).toBeUndefined();
    expect(d.baseUrlEnv).toBeUndefined();
    expect(d.sessionSemantics).toBe("server-resumable");
  });

  it("missing id throws", () => {
    expect(() => normalizeProviderDecl({ ...FULL_RAW, id: undefined })).toThrow(/provider\.id/);
  });

  it("missing entry throws", () => {
    expect(() => normalizeProviderDecl({ ...FULL_RAW, entry: undefined })).toThrow(/provider\.entry/);
  });

  it("non-integer abi throws", () => {
    expect(() => normalizeProviderDecl({ ...FULL_RAW, abi: "1" })).toThrow(/provider\.abi/);
    expect(() => normalizeProviderDecl({ ...FULL_RAW, abi: 1.5 })).toThrow(/provider\.abi/);
  });

  it("unknown session-semantics throws (the only two coherent Lane B values)", () => {
    expect(() => normalizeProviderDecl({ ...FULL_RAW, "session-semantics": "client-transcript" })).toThrow(
      /session-semantics/,
    );
  });

  it("empty optional string throws rather than silently coercing", () => {
    expect(() => normalizeProviderDecl({ ...FULL_RAW, "api-key-env": "" })).toThrow(/api-key-env/);
  });
});

describe("validateProviderDecl", () => {
  it("a well-formed decl at the engine ABI passes", () => {
    expect(validateProviderDecl(decl(), 1)).toEqual({ ok: true });
  });

  it.each(["Sol", "s", "seventeen-chars-x", "so_l"])("id shape %j is rejected by the regex", (id) => {
    expect(PROVIDER_ID_REGEX.test(id)).toBe(false);
    const v = validateProviderDecl(decl({ id }), 1);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/invalid/);
  });

  it.each(["claude", "codex", "openai-codex", "google-gemini", "kimi", "laneb"])("reserved id %j is rejected", (id) => {
    expect(RESERVED_PROVIDER_IDS.has(id)).toBe(true);
    const v = validateProviderDecl(decl({ id }), 1);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/reserved/);
  });

  it("abi above the engine names both numbers and says upgrade hive", () => {
    const v = validateProviderDecl(decl({ abi: 2 }), 1);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toContain("ABI 2");
      expect(v.reason).toContain("provides 1");
      expect(v.reason).toMatch(/upgrade hive/);
    }
  });

  it("abi below the engine names both numbers and says newer plugin", () => {
    const v = validateProviderDecl(decl({ abi: 0 }), 1);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toContain("ABI 0");
      expect(v.reason).toMatch(/newer plugin/);
    }
  });

  it("malformed api-key-env name is rejected", () => {
    const v = validateProviderDecl(decl({ "api-key-env": "sol_key" }), 1);
    expect(v.ok).toBe(false);
  });

  it("malformed base-url-env name is rejected", () => {
    const v = validateProviderDecl(decl({ "base-url-env": "1BAD" }), 1);
    expect(v.ok).toBe(false);
  });
});

describe("readInstalledProviderDecls / auditInstalledProviderDecls", () => {
  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "kpr394-decl-"));
    const mk = (name: string, yaml: string) => {
      const dir = join(root, "plugins", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "plugin.yaml"), yaml);
    };
    mk(
      "hive-plugin-sol",
      "name: hive-plugin-sol\nprovider:\n  id: sol\n  entry: provider.ts\n  abi: 1\n  session-semantics: stateless-replay\n  api-key-env: SOL_API_KEY\n",
    );
    mk("hive-plugin-plain", "name: hive-plugin-plain\nmcp-servers: {}\n");
    return root;
  }

  it("reads provider decls; plugins without a block are skipped", () => {
    const root = makeRoot();
    const decls = readInstalledProviderDecls(["hive-plugin-sol", "hive-plugin-plain"], root);
    expect(decls).toHaveLength(1);
    expect(decls[0]!.plugin).toBe("hive-plugin-sol");
    expect(decls[0]!.decl.id).toBe("sol");
  });

  it("missing manifests are skipped without throwing", () => {
    const root = makeRoot();
    expect(readInstalledProviderDecls(["no-such-plugin"], root)).toEqual([]);
  });

  it("a structurally-invalid provider block is skipped quietly", () => {
    const root = makeRoot();
    const dir = join(root, "plugins", "hive-plugin-bad");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.yaml"), "name: hive-plugin-bad\nprovider:\n  id: bad\n");
    expect(readInstalledProviderDecls(["hive-plugin-bad"], root)).toEqual([]);
  });

  it("audit: valid decl is an ok row", () => {
    const root = makeRoot();
    const rows = auditInstalledProviderDecls(["hive-plugin-sol"], root, 1);
    expect(rows).toEqual([
      { plugin: "hive-plugin-sol", id: "sol", abi: 1, semantics: "stateless-replay", status: "ok" },
    ]);
  });

  it("audit: abi mismatch is a broken row naming both numbers", () => {
    const root = makeRoot();
    const rows = auditInstalledProviderDecls(["hive-plugin-sol"], root, 2);
    expect(rows[0]!.status).toBe("broken");
    expect(rows[0]!.reason).toContain("ABI 1");
    expect(rows[0]!.reason).toContain("provides 2");
  });

  it("audit: id collision — first ok, second broken with the first's name", () => {
    const root = makeRoot();
    const dir = join(root, "plugins", "hive-plugin-sol2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "plugin.yaml"),
      "name: hive-plugin-sol2\nprovider:\n  id: sol\n  entry: provider.ts\n  abi: 1\n  session-semantics: stateless-replay\n",
    );
    const rows = auditInstalledProviderDecls(["hive-plugin-sol", "hive-plugin-sol2"], root, 1);
    expect(rows[0]!.status).toBe("ok");
    expect(rows[1]!.status).toBe("broken");
    expect(rows[1]!.reason).toContain("hive-plugin-sol");
  });

  it("audit: unresolvable entry is a broken row when a resolver is supplied", () => {
    const root = makeRoot();
    const rows = auditInstalledProviderDecls(["hive-plugin-sol"], root, 1, () => false);
    expect(rows[0]!.status).toBe("broken");
    expect(rows[0]!.reason).toMatch(/entry not resolvable/);
  });

  it("BUILTIN_ROUTABLE_PREFIXES covers every resolveProviderModel arm incl. aliases and claude", () => {
    for (const p of [
      "claude",
      "openai",
      "openai-codex",
      "codex",
      "gemini",
      "google-gemini",
      "grok",
      "kimi",
      "deepseek",
    ]) {
      expect(BUILTIN_ROUTABLE_PREFIXES.has(p)).toBe(true);
    }
    expect(BUILTIN_ROUTABLE_PREFIXES.has("laneb")).toBe(false);
  });
});
