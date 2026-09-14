import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ConfinementSelfTestError, ConfinementUnavailableError, SANDBOX_EXEC } from "../deployment/confined-job.js";
import { PromotionPreflightError } from "../deployment/clone-promotion.js";
import {
  artifactStagingPrereq,
  checkArtifactStagingPrerequisites,
  type ArtifactStagingPrerequisiteDeps,
} from "./prereqs.js";

function deps(overrides: Partial<ArtifactStagingPrerequisiteDeps> = {}) {
  let scratch = "";
  const value: ArtifactStagingPrerequisiteDeps = {
    nodePath: "/opt/node",
    scratchParent: async () => (scratch = realpathSync(mkdtempSync(resolve(tmpdir(), "hive-prereq-test-")))),
    destinationParent: async () => realpathSync(tmpdir()),
    selfTest: vi.fn(async () => ({
      outcome: "passed" as const,
      macosVersion: "26.6.2",
      sandboxExec: SANDBOX_EXEC,
      profileSha256: "a".repeat(64),
      checkedAt: "now",
    })),
    promotionMethod: vi.fn(async () => ({
      method: "clone" as const,
      reason: "apfs-clone" as const,
      filesystemType: "apfs",
    })),
    ...overrides,
  };
  return { value, scratch: () => scratch };
}

describe("init/resume artifact staging prerequisites", () => {
  it("runs the fail-closed self-test before selecting the promotion method, then removes its scratch area", async () => {
    const { value, scratch } = deps();
    const result = await checkArtifactStagingPrerequisites(value);
    expect(result.promotion.method).toBe("clone");
    expect(value.selfTest).toHaveBeenCalledWith(expect.objectContaining({ nodePath: "/opt/node" }));
    expect(existsSync(scratch())).toBe(false);
  });

  it.each([
    ["a missing sandbox-exec", new ConfinementUnavailableError("/usr/bin/sandbox-exec is missing")],
    ["a self-test that does not deny", new ConfinementSelfTestError("did not deny")],
  ])("reports %s by name and never auto-installs", async (_name, failure) => {
    const { value } = deps({
      selfTest: vi.fn(async () => {
        throw failure;
      }),
    });
    const prereq = artifactStagingPrereq(value);
    expect(await prereq.check()).toBe(false);
    expect(value.promotionMethod).not.toHaveBeenCalled();
    expect(() => prereq.install()).toThrow(/cannot be installed automatically.*(missing|did not deny)/);
  });

  it("fails when no promotion method is usable", async () => {
    const { value } = deps({
      promotionMethod: vi.fn(async () => {
        throw new PromotionPreflightError("APFS clone probe failed");
      }),
    });
    await expect(checkArtifactStagingPrerequisites(value)).rejects.toThrow(PromotionPreflightError);
  });
});
