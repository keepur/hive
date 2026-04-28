import { describe, it, expect, vi } from "vitest";
import { runCredentialsCommand, type CredentialsCliIO } from "./credentials.js";

interface TestIO extends CredentialsCliIO {
  stored: Record<string, string>;
  logs: string[];
}

function makeIO(answers: string[] = []): TestIO {
  const stored: Record<string, string> = {};
  const logs: string[] = [];
  let i = 0;
  const ask = vi.fn(async () => answers[i++] ?? "");
  return {
    ask,
    log: (m: string) => logs.push(m),
    setSecret: (k: string, v: string) => {
      stored[k] = v;
    },
    removeSecret: (k: string) => {
      delete stored[k];
    },
    hasSecret: (k: string) => k in stored,
    stored,
    logs,
  };
}

describe("runCredentialsCommand list", () => {
  it("shows registry entries with present/absent marks", async () => {
    const io = makeIO();
    io.stored.LINEAR_API_KEY = "abc";
    const code = await runCredentialsCommand("list", [], io);
    expect(code).toBe(0);
    const joined = io.logs.join("\n");
    expect(joined).toContain("LINEAR_API_KEY");
    expect(joined).toMatch(/ok\s+LINEAR_API_KEY/);
    expect(joined).toMatch(/--\s+BRAVE_API_KEY/);
  });

  it("defaults to list when subcommand is omitted", async () => {
    const io = makeIO();
    const code = await runCredentialsCommand(undefined, [], io);
    expect(code).toBe(0);
    expect(io.logs.join("\n")).toContain("BRAVE_API_KEY");
  });

  it("treats `ls` as an alias for list", async () => {
    const io = makeIO();
    const code = await runCredentialsCommand("ls", [], io);
    expect(code).toBe(0);
    expect(io.logs.join("\n")).toContain("BRAVE_API_KEY");
  });

  it("renders OAuth entries without prompting for a key", async () => {
    const io = makeIO();
    const code = await runCredentialsCommand("list", [], io);
    expect(code).toBe(0);
    expect(io.logs.join("\n")).toMatch(/google\s+oauth/);
  });
});

describe("runCredentialsCommand add", () => {
  it("stores a known key", async () => {
    const io = makeIO(["super-secret"]);
    const code = await runCredentialsCommand("add", ["BRAVE_API_KEY"], io);
    expect(code).toBe(0);
    expect(io.stored.BRAVE_API_KEY).toBe("super-secret");
  });

  it("rejects unknown keys", async () => {
    const io = makeIO();
    const code = await runCredentialsCommand("add", ["NOT_A_REAL_KEY"], io);
    expect(code).toBe(1);
    expect(io.stored).toEqual({});
  });

  it("rejects empty input", async () => {
    const io = makeIO([""]);
    const code = await runCredentialsCommand("add", ["BRAVE_API_KEY"], io);
    expect(code).toBe(1);
    expect(io.stored).toEqual({});
  });

  it("requires a KEY argument", async () => {
    const io = makeIO();
    const code = await runCredentialsCommand("add", [], io);
    expect(code).toBe(1);
    expect(io.logs.join("\n")).toContain("Usage:");
  });

  it("declines OAuth entries (no static key)", async () => {
    // google has no fields — no key resolves to it via findCredentialEntryByKey
    const io = makeIO(["whatever"]);
    const code = await runCredentialsCommand("add", ["GOOGLE_API_KEY"], io);
    expect(code).toBe(1);
    expect(io.stored).toEqual({});
  });

  it("surfaces setSecret failure as nonzero exit", async () => {
    const io = makeIO(["whatever"]);
    io.setSecret = () => {
      throw new Error("simulated honeypot failure");
    };
    const code = await runCredentialsCommand("add", ["BRAVE_API_KEY"], io);
    expect(code).toBe(1);
  });
});

describe("runCredentialsCommand remove", () => {
  it("removes a stored key", async () => {
    const io = makeIO();
    io.stored.LINEAR_API_KEY = "abc";
    const code = await runCredentialsCommand("remove", ["LINEAR_API_KEY"], io);
    expect(code).toBe(0);
    expect(io.stored.LINEAR_API_KEY).toBeUndefined();
  });

  it("treats `rm` as an alias", async () => {
    const io = makeIO();
    io.stored.LINEAR_API_KEY = "abc";
    const code = await runCredentialsCommand("rm", ["LINEAR_API_KEY"], io);
    expect(code).toBe(0);
    expect(io.stored.LINEAR_API_KEY).toBeUndefined();
  });

  it("returns nonzero when key absent", async () => {
    const io = makeIO();
    const code = await runCredentialsCommand("remove", ["LINEAR_API_KEY"], io);
    expect(code).toBe(1);
  });

  it("requires a KEY argument", async () => {
    const io = makeIO();
    const code = await runCredentialsCommand("remove", [], io);
    expect(code).toBe(1);
  });
});

describe("runCredentialsCommand misc", () => {
  it("prints help on `help`", async () => {
    const io = makeIO();
    const code = await runCredentialsCommand("help", [], io);
    expect(code).toBe(0);
    expect(io.logs.join("\n")).toContain("Usage:");
  });

  it("prints help and returns 0 on unknown subcommand", async () => {
    const io = makeIO();
    const code = await runCredentialsCommand("nonsense", [], io);
    // The unknown-subcommand branch falls through to printHelp() which returns 0.
    expect(code).toBe(0);
    expect(io.logs.join("\n")).toContain("Unknown subcommand");
  });

  it("calls close() on the io once finished", async () => {
    const close = vi.fn();
    const io = makeIO();
    io.close = close;
    await runCredentialsCommand("list", [], io);
    expect(close).toHaveBeenCalledOnce();
  });
});
