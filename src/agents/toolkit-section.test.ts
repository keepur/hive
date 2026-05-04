import { describe, it, expect } from "vitest";
import { buildToolkitSection } from "./toolkit-section.js";
import type { LoadedPlugin } from "../plugins/types.js";

// MUST mirror AgentRunner.autoInjectedServerNames() — keep in sync.
// (KPR-174 audit caught the test fixture out-of-sync with runtime: team-roster
// is auto-injected at runtime but the fixture omitted it, so a regression
// classifying team-roster as a capability MCP would silently pass tests.)
const AUTO_INJECTED = new Set(["schedule", "team", "team-roster", "slack"]);

function bareBonesInput(overrides: Partial<Parameters<typeof buildToolkitSection>[0]> = {}) {
  // Bare-bones = engine auto-injects only. structured-memory is conditionally
  // paired with `memory` in filterCoreServers, NOT unconditionally injected,
  // so a true bare-bones agent (no memory in coreServers) doesn't have it.
  return {
    coreServerNames: ["schedule", "team", "team-roster", "slack"],
    delegateServerNames: [],
    plugins: [],
    autoInjectedServers: AUTO_INJECTED,
    ...overrides,
  };
}

describe("buildToolkitSection", () => {
  it("emits a 'Your toolkit' header and the built-in subsection", () => {
    const out = buildToolkitSection(bareBonesInput());
    expect(out).toContain("## Your toolkit");
    expect(out).toContain("### Built-in (always available)");
    expect(out).toContain("Bash");
    expect(out).toContain("Read / Write / Edit");
    expect(out).toContain("Glob / Grep");
    expect(out).toContain("WebFetch / WebSearch");
  });

  it("classifies auto-injected servers under 'Engine-provided'", () => {
    const out = buildToolkitSection(bareBonesInput());
    expect(out).toContain("### Engine-provided");
    // schedule, team, team-roster, slack are auto-injected
    expect(out).toMatch(/- schedule —/);
    expect(out).toMatch(/- team —/);
    expect(out).toMatch(/- team-roster —/);
    expect(out).toMatch(/- slack —/);
  });

  it("renders a real catalog blurb for team-roster, not the name fallback (KPR-174)", () => {
    // team-roster is auto-injected; without a SERVER_CATALOG entry the line
    // would render "- team-roster — team-roster" (resolveCatalogEntry's
    // last-resort fallback). Audit caught this gap; assert the catalog
    // entry stays in place.
    const out = buildToolkitSection(bareBonesInput());
    const teamRosterLine = out.split("\n").find((l) => l.startsWith("- team-roster —"));
    expect(teamRosterLine).toBeDefined();
    // Negative: not the fallback
    expect(teamRosterLine).not.toBe("- team-roster — team-roster");
    // Positive: blurb mentions teammates / lookup-shape language
    expect(teamRosterLine!.toLowerCase()).toMatch(/team|roster|lookup|directory|humans|agents/);
  });

  it("classifies non-auto-injected coreServers under 'Capability MCPs'", () => {
    const input = bareBonesInput({
      coreServerNames: ["memory", "schedule", "google", "resend", "callback"],
    });
    const out = buildToolkitSection(input);
    expect(out).toContain("### Capability MCPs");
    // memory, google, resend, callback are not in autoInjected — they're capabilities
    expect(out).toMatch(/- memory —/);
    expect(out).toMatch(/- google —/);
    expect(out).toMatch(/- resend —/);
    expect(out).toMatch(/- callback —/);
    // schedule stays under Engine-provided
    const engineIdx = out.indexOf("### Engine-provided");
    const capIdx = out.indexOf("### Capability MCPs");
    const scheduleIdx = out.indexOf("- schedule —");
    expect(scheduleIdx).toBeGreaterThan(engineIdx);
    expect(scheduleIdx).toBeLessThan(capIdx);
  });

  it("classifies structured-memory under 'Capability MCPs' when paired with memory (KPR-87 review fix)", () => {
    // structured-memory is conditionally paired with `memory` in
    // filterCoreServers, NOT unconditionally injected. An agent with `memory`
    // in coreServers gets structured-memory too — and the toolkit must show
    // it under Capability MCPs (where memory lives), not Engine-provided.
    const input = bareBonesInput({
      coreServerNames: ["memory", "structured-memory", "schedule", "team", "slack"],
    });
    const out = buildToolkitSection(input);
    const engineIdx = out.indexOf("### Engine-provided");
    const capIdx = out.indexOf("### Capability MCPs");
    const structuredMemIdx = out.indexOf("- structured-memory —");
    expect(engineIdx).toBeGreaterThanOrEqual(0);
    expect(capIdx).toBeGreaterThan(engineIdx);
    expect(structuredMemIdx).toBeGreaterThan(capIdx);
  });

  it("emits 'Delegated' subsection when delegates present", () => {
    const out = buildToolkitSection(
      bareBonesInput({ delegateServerNames: ["linear", "brave-search"] }),
    );
    expect(out).toContain("### Delegated capability MCPs");
    expect(out).toMatch(/- linear —/);
    expect(out).toMatch(/- brave-search —/);
  });

  it("omits empty subsections (no capability core, no delegates)", () => {
    const out = buildToolkitSection(bareBonesInput());
    expect(out).not.toContain("### Capability MCPs");
    expect(out).not.toContain("### Delegated capability MCPs");
  });

  it("subsections appear in stable order: Built-in, Engine-provided, Capability, Delegated", () => {
    const out = buildToolkitSection(
      bareBonesInput({
        coreServerNames: ["memory", "schedule", "google"],
        delegateServerNames: ["linear"],
      }),
    );
    const builtIdx = out.indexOf("### Built-in");
    const engineIdx = out.indexOf("### Engine-provided");
    const capIdx = out.indexOf("### Capability MCPs");
    const delIdx = out.indexOf("### Delegated capability MCPs");
    expect(builtIdx).toBeGreaterThan(-1);
    expect(engineIdx).toBeGreaterThan(builtIdx);
    expect(capIdx).toBeGreaterThan(engineIdx);
    expect(delIdx).toBeGreaterThan(capIdx);
  });

  it("falls back to plugin manifest description for plugin servers", () => {
    const plugin: LoadedPlugin = {
      name: "custom-plugin",
      dir: "/plugins/custom-plugin",
      manifest: {
        name: "custom-plugin",
        description: "Custom",
        mcpServers: {
          "custom-tool": {
            entry: "mcp-servers/custom/index.ts",
            description: "A custom tool for testing",
            usage: "Testing things",
            env: [],
            envMap: {},
            agentEnv: {},
          },
        },
        agentSeeds: [],
      },
      brokenServers: {},
    };
    const out = buildToolkitSection({
      coreServerNames: ["custom-tool"],
      delegateServerNames: [],
      plugins: [plugin],
      autoInjectedServers: AUTO_INJECTED,
    });
    expect(out).toContain("- custom-tool — A custom tool for testing");
  });

  it("falls back to server name when no catalog entry and no plugin entry", () => {
    const out = buildToolkitSection({
      coreServerNames: ["mystery"],
      delegateServerNames: [],
      plugins: [],
      autoInjectedServers: AUTO_INJECTED,
    });
    // resolveCatalogEntry returns { description: name } as last resort
    expect(out).toContain("- mystery — mystery");
  });

  it("disambiguates team vs contacts in their blurbs", () => {
    const out = buildToolkitSection({
      coreServerNames: ["team", "contacts", "schedule"],
      delegateServerNames: [],
      plugins: [],
      autoInjectedServers: AUTO_INJECTED,
    });
    // team line — must reference agent-to-agent, not Slack DMs
    const teamLine = out.split("\n").find((l) => l.startsWith("- team —"));
    expect(teamLine).toBeDefined();
    // team blurb must call out "peer hive agents" so it isn't confused with contacts
    expect(teamLine!.toLowerCase()).toContain("hive agent");
    // and explicitly distance itself from Slack DMs
    expect(teamLine!.toLowerCase()).toContain("slack");

    // contacts line — must reference directory lookups and not claim peer-agent messaging
    const contactsLine = out.split("\n").find((l) => l.startsWith("- contacts —"));
    expect(contactsLine).toBeDefined();
    expect(contactsLine!.toLowerCase()).toContain("contact");
    expect(contactsLine!.toLowerCase()).not.toContain("peer hive");
  });

  it("uses toolkitBlurb when set on a catalog entry", () => {
    // team has a toolkitBlurb — it should render that, not the longer description
    const out = buildToolkitSection({
      coreServerNames: ["team", "schedule"],
      delegateServerNames: [],
      plugins: [],
      autoInjectedServers: AUTO_INJECTED,
    });
    const teamLine = out.split("\n").find((l) => l.startsWith("- team —"));
    expect(teamLine).toBe(
      "- team — Direct messaging to peer hive agents (not Slack DMs)",
    );
  });

  it("bare-bones output stays under 1 KB", () => {
    const out = buildToolkitSection(bareBonesInput());
    const bytes = Buffer.byteLength(out, "utf8");
    expect(bytes).toBeLessThanOrEqual(1024);
  });

  it("typical 8-core / 4-delegate agent stays under 2 KB", () => {
    const out = buildToolkitSection({
      coreServerNames: [
        "memory",
        "schedule",
        "team",
        "slack",
        "structured-memory",
        "google",
        "resend",
        "callback",
      ],
      delegateServerNames: ["linear", "brave-search", "conversation-search", "contacts"],
      plugins: [],
      autoInjectedServers: AUTO_INJECTED,
    });
    const bytes = Buffer.byteLength(out, "utf8");
    expect(bytes).toBeLessThanOrEqual(2048);
  });

  it("conditional browser appears only when in coreServerNames", () => {
    const without = buildToolkitSection(bareBonesInput());
    expect(without).not.toMatch(/- browser —/);

    const withBrowser = buildToolkitSection(
      bareBonesInput({
        coreServerNames: [...bareBonesInput().coreServerNames, "browser"],
      }),
    );
    expect(withBrowser).toMatch(/- browser —/);
  });

  it("agent that explicitly authored team or slack still classifies them as engine-provided", () => {
    // Even if agent-author put "team" in coreServers explicitly, the auto-inject
    // set drives the classification — team must show under Engine-provided, not
    // capability MCPs.
    const out = buildToolkitSection({
      coreServerNames: ["team", "slack", "memory"],
      delegateServerNames: [],
      plugins: [],
      autoInjectedServers: AUTO_INJECTED,
    });
    const engineIdx = out.indexOf("### Engine-provided");
    const capIdx = out.indexOf("### Capability MCPs");
    const teamIdx = out.indexOf("- team —");
    const slackIdx = out.indexOf("- slack —");
    const memoryIdx = out.indexOf("- memory —");
    expect(teamIdx).toBeGreaterThan(engineIdx);
    expect(teamIdx).toBeLessThan(capIdx);
    expect(slackIdx).toBeGreaterThan(engineIdx);
    expect(slackIdx).toBeLessThan(capIdx);
    // memory is not auto-injected — appears under Capability MCPs
    expect(memoryIdx).toBeGreaterThan(capIdx);
  });
});
