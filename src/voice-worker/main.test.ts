import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isEntrypoint } from "./main.js";

// Node resolves a module's `import.meta.url` through the real filesystem
// path (symlinks included) at load time — so the accurate way to simulate
// "the module was loaded from path P" is to build the URL from P's realpath,
// not from P verbatim. This also sidesteps macOS's own `/var` → `/private/var`
// symlink on tmpdir() paths, which would otherwise make direct string
// comparisons flaky independent of the behavior under test.
function moduleUrlFor(path: string): string {
  return pathToFileURL(realpathSync(path)).href;
}

// KPR-428 — the launchd-entrypoint "am I the main module" guard must resolve
// through symlinks (Node resolves `import.meta.url` through the real
// filesystem path, but `process.argv[1]` stays as typed). A regression here
// makes the voice worker silently no-op boot: exit 0, no error, and launchd's
// `KeepAlive.SuccessfulExit: false` never restarts it.
describe("isEntrypoint (KPR-428)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "voice-worker-entrypoint-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns false when argv[1] is undefined (imported, not executed)", () => {
    expect(isEntrypoint(undefined, import.meta.url)).toBe(false);
  });

  it("returns false when argv[1] names a different module (imported from a test/caller)", () => {
    const real = join(tmp, "real.ts");
    writeFileSync(real, "");
    const other = join(tmp, "other.ts");
    writeFileSync(other, "");
    expect(isEntrypoint(other, moduleUrlFor(real))).toBe(false);
  });

  it("returns true on direct invocation (argv[1] === the real module path)", () => {
    const real = join(tmp, "real.ts");
    writeFileSync(real, "");
    expect(isEntrypoint(real, moduleUrlFor(real))).toBe(true);
  });

  it("returns true when argv[1] is a symlink to the real module path (the KPR-428 regression case)", () => {
    const real = join(tmp, "real.ts");
    writeFileSync(real, "");
    const link = join(tmp, "linked.ts");
    symlinkSync(real, link);

    // import.meta.url for a module loaded via a symlinked argv[1] resolves
    // through to the real path — this is what Node actually does, and is
    // reproduced here directly rather than mocked. argv[1] itself stays as
    // the symlinked path, exactly as launchd/tsx would invoke it.
    expect(isEntrypoint(link, moduleUrlFor(real))).toBe(true);
  });

  it("returns false when a symlinked argv[1] does not resolve to the module path", () => {
    const real = join(tmp, "real.ts");
    writeFileSync(real, "");
    const unrelated = join(tmp, "unrelated.ts");
    writeFileSync(unrelated, "");
    const link = join(tmp, "linked.ts");
    symlinkSync(unrelated, link);

    expect(isEntrypoint(link, moduleUrlFor(real))).toBe(false);
  });

  it("returns false when argv[1] points at a nonexistent path (realpath fallback fails closed)", () => {
    const real = join(tmp, "real.ts");
    writeFileSync(real, "");
    const missing = join(tmp, "does-not-exist.ts");
    expect(isEntrypoint(missing, moduleUrlFor(real))).toBe(false);
  });
});
