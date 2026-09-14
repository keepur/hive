import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { initialBootstrapWork, type BootstrapWork } from "./bootstrap.js";
import { canonical } from "./canonical.js";
import {
  adoptHostPreparation,
  disposeHostPreparation,
  HOST_PREPARATION_ADOPTED_FILE,
  HOST_PREPARATION_FILE,
  preparationForHelper,
  type HostPreparation,
} from "./host-preparation.js";
import { acquireOperation, finishOperationLock, persistOperation, type AcquiredOperation } from "./operation.js";
import type { FileSeal } from "./pilot-records.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const UID = process.getuid!();
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

function seal(path: string): FileSeal {
  const info = lstatSync(path);
  const bytes = readFileSync(path);
  return {
    path,
    realpath: realpathSync(path),
    uid: info.uid,
    mode: info.mode & 0o7777,
    dev: info.dev,
    ino: info.ino,
    size: bytes.length,
    sha256: sha(bytes),
  };
}

interface Prepared {
  home: string;
  config: string;
  helper: string;
  receiptPath: string;
  directory: string;
  receipt: HostPreparation;
  operation: AcquiredOperation;
  work: BootstrapWork;
  write(receipt: HostPreparation): void;
}

async function prepared(options: { phase?: HostPreparation["phase"] } = {}): Promise<Prepared> {
  const base = realpathSync(mkdtempSync(resolve(tmpdir(), "hive-host-prep-")));
  roots.push(base);
  chmodSync(base, 0o755);
  const home = resolve(base, "instance");
  mkdirSync(resolve(home, ".hive-state", "bootstrap"), { recursive: true, mode: 0o700 });
  chmodSync(home, 0o755);
  const config = resolve(home, "hive.yaml");
  writeFileSync(config, "instance:\n  id: dodi\n", { mode: 0o644 });
  const archive = resolve(base, "candidate.tgz");
  writeFileSync(archive, "reviewed archive\n", { mode: 0o644 });
  const id = randomUUID();
  const bootstrapRoot = resolve(home, ".hive-state", "bootstrap");
  const directory = resolve(bootstrapRoot, `.prepare-${id}`);
  const helper = resolve(directory, "package", "pkg", "deploy.min.js");
  mkdirSync(resolve(helper, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(helper, "helper bytes\n", { mode: 0o600 });
  const identity = (path: string) => {
    const info = lstatSync(path);
    return { dev: info.dev, ino: info.ino, uid: info.uid };
  };
  const receipt: HostPreparation = {
    schemaVersion: 1,
    id,
    instance: { canonicalHome: home, configPath: config, instanceId: "dodi", uid: UID },
    owner: { pid: 99_999, startTime: "Mon Sep 14 10:00:00 2026" },
    archive: seal(archive),
    reviewedRevision: "c".repeat(40),
    preparedPath: helper,
    parent: { path: bootstrapRoot, identity: identity(bootstrapRoot) },
    phase: options.phase ?? "validated",
    directory: { path: directory, identity: identity(directory) },
    helper: seal(helper),
    adoptedOperationId: null,
  };
  const receiptPath = `${directory}.json`;
  const write = (value: HostPreparation) => writeFileSync(receiptPath, `${canonical(value)}\n`, { mode: 0o600 });
  write(receipt);
  const work = initialBootstrapWork({
    artifact: archive,
    sha256: receipt.archive.sha256,
    revision: "c".repeat(40),
    sourceHelper: helper,
  });
  const operation = await acquireOperation({
    instanceHome: home,
    instanceId: "dodi",
    mode: "bootstrap",
    workKind: "bootstrap",
    bootstrap: work,
    toolSha256: sha("helper bytes\n"),
    ownerStartTime: "start",
  });
  return { home, config, helper, receiptPath, directory, receipt, operation, work: operation.record.bootstrap!, write };
}

const exited = { isProcessLive: async () => false };

describe("host preparation receipt adoption", () => {
  it("derives the receipt only from the prepared helper path shape", () => {
    const home = "/Users/example/hive";
    const id = randomUUID();
    const helper = `${home}/.hive-state/bootstrap/.prepare-${id}/package/pkg/deploy.min.js`;
    expect(preparationForHelper(home, helper)).toEqual({
      id,
      directory: `${home}/.hive-state/bootstrap/.prepare-${id}`,
      receipt: `${home}/.hive-state/bootstrap/.prepare-${id}.json`,
    });
    expect(preparationForHelper(home, `${home}/.hive-state/tooling/abc/pkg/deploy.min.js`)).toBeNull();
    expect(preparationForHelper(home, `/elsewhere/.prepare-${id}/package/pkg/deploy.min.js`)).toBeNull();
    expect(preparationForHelper(home, `${home}/.hive-state/bootstrap/.prepare-x/package/pkg/deploy.min.js`)).toBeNull();
  });

  it("retains the exact validated receipt, journals adoption and rewrites the sidecar before any install", async () => {
    const p = await prepared();
    const original = readFileSync(p.receiptPath);
    const adoption = await adoptHostPreparation(p.operation, p.work, { configPath: p.config, ...exited });
    expect(adoption).toMatchObject({ state: "observed", receipt: { validatedSha256: sha(original) } });
    const retained = resolve(p.operation.paths.operationDirectory, HOST_PREPARATION_FILE);
    expect(readFileSync(retained).equals(original)).toBe(true);
    expect(p.work.hostPreparation?.path).toBe(retained);
    const rewritten = JSON.parse(readFileSync(p.receiptPath, "utf8")) as HostPreparation;
    expect(rewritten).toMatchObject({ phase: "adopted", adoptedOperationId: p.operation.record.id });
    expect(sha(readFileSync(p.receiptPath))).toBe(adoption!.adoptedSha256);
    expect(
      readFileSync(resolve(p.operation.paths.operationDirectory, HOST_PREPARATION_ADOPTED_FILE)).equals(
        readFileSync(p.receiptPath),
      ),
    ).toBe(true);
    // Idempotent once observed.
    await expect(adoptHostPreparation(p.operation, p.work, { configPath: p.config, ...exited })).resolves.toBe(
      adoption,
    );
    await finishOperationLock(p.operation).catch(() => {});
  });

  it("a live preparer is busy and an unvalidated or mismatched receipt is retained untouched", async () => {
    const busy = await prepared();
    await expect(
      adoptHostPreparation(busy.operation, busy.work, { configPath: busy.config, isProcessLive: async () => true }),
    ).rejects.toMatchObject({ code: "PREPARATION_BUSY" });
    expect(busy.work.adoption).toBeNull();

    const orphan = await prepared({ phase: "extracted" });
    const bytes = readFileSync(orphan.receiptPath);
    await expect(
      adoptHostPreparation(orphan.operation, orphan.work, { configPath: orphan.config, ...exited }),
    ).rejects.toMatchObject({ code: "PREPARATION_ORPHAN_RETAINED" });
    expect(readFileSync(orphan.receiptPath).equals(bytes)).toBe(true);

    const changed = await prepared();
    writeFileSync(changed.helper, "swapped helper\n", { mode: 0o600 });
    await expect(
      adoptHostPreparation(changed.operation, changed.work, { configPath: changed.config, ...exited }),
    ).rejects.toMatchObject({ code: "PREPARATION_HELPER_CHANGED" });

    const revision = await prepared();
    revision.write({ ...revision.receipt, reviewedRevision: "d".repeat(40) });
    await expect(
      adoptHostPreparation(revision.operation, revision.work, { configPath: revision.config, ...exited }),
    ).rejects.toMatchObject({ code: "PREPARATION_RECEIPT_MISMATCH" });
  });

  it("an interrupted journal completes only against the validated or predicted adopted bytes", async () => {
    const p = await prepared();
    await adoptHostPreparation(p.operation, p.work, { configPath: p.config, ...exited });
    // Simulate a crash after the journal but before observation, with the sidecar still validated.
    const adoption = p.work.adoption!;
    adoption.state = "intended";
    adoption.retainedAdopted = null;
    p.write(p.receipt);
    rmSync(resolve(p.operation.paths.operationDirectory, HOST_PREPARATION_ADOPTED_FILE));
    await persistOperation(p.operation);
    await adoptHostPreparation(p.operation, p.work, { configPath: p.config, ...exited });
    expect(p.work.adoption?.state).toBe("observed");

    adoption.state = "intended";
    p.write({ ...p.receipt, reviewedRevision: "e".repeat(40) });
    await expect(adoptHostPreparation(p.operation, p.work, { configPath: p.config, ...exited })).rejects.toThrow(
      "PREPARATION_RECEIPT_CHANGED",
    );
  });

  it("the janitor disposes only the adopted directory by identity, then the receipt, after the terminal record", async () => {
    const p = await prepared();
    await adoptHostPreparation(p.operation, p.work, { configPath: p.config, ...exited });
    expect(await disposeHostPreparation(p.operation, p.work)).toEqual([]);
    expect(existsSync(p.directory)).toBe(true); // no terminal outcome yet
    p.work.outcome = "validated";
    expect(await disposeHostPreparation(p.operation, p.work)).toEqual([]);
    expect(existsSync(p.directory)).toBe(false);
    expect(existsSync(p.receiptPath)).toBe(false);
    expect(p.work.adoption?.disposal).toEqual({ directory: "removed", receipt: "removed" });
    // The retained operation copies survive.
    expect(existsSync(resolve(p.operation.paths.operationDirectory, HOST_PREPARATION_FILE))).toBe(true);

    const replaced = await prepared();
    await adoptHostPreparation(replaced.operation, replaced.work, { configPath: replaced.config, ...exited });
    replaced.work.outcome = "aborted";
    rmSync(replaced.directory, { recursive: true });
    mkdirSync(replaced.directory, { mode: 0o700 });
    writeFileSync(resolve(replaced.directory, "sentinel"), "foreign\n");
    expect(await disposeHostPreparation(replaced.operation, replaced.work)).toEqual([
      "PREPARATION_DIRECTORY_IDENTITY_CHANGED",
    ]);
    expect(existsSync(resolve(replaced.directory, "sentinel"))).toBe(true);
    expect(existsSync(replaced.receiptPath)).toBe(true);
  });
});
