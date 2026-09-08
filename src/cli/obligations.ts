import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import dotenv from "dotenv";
import { MongoClient, type Db } from "mongodb";
import { fromKeychain } from "../keychain/from-keychain.js";
import { verifySentinel } from "../db/identity-sentinel.js";
import { guardDb, WriteGuard } from "../db/write-guard.js";
import { ObligationStore } from "../obligations/store.js";
import { ReceiptStore } from "../obligations/receipts.js";
import { ObligationReader } from "../obligations/reader.js";
import { registrationSchema, idSchema, fail, ObligationError } from "../obligations/types.js";
import { adjacent, localDeadline } from "../obligations/deadlines.js";
import { ZodError } from "zod";

export interface CliSelection {
  configPath: string;
  instanceId: string;
  uri: string;
  dbName: string;
}
export function selectInstance(options: { config?: string; instance?: string }, env = process.env): CliSelection {
  if (options.config && options.instance) return fail("choose_config_or_instance");
  let path: string;
  if (options.config) {
    path = resolve(options.config);
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "hive.yaml");
  } else if (options.instance) {
    idSchema.parse(options.instance);
    path = resolve(env.HOME ?? "/tmp", "services", "hive", options.instance, "hive.yaml");
  } else if (env.HIVE_HOME) {
    path = resolve(env.HIVE_HOME, env.HIVE_CONFIG ?? "hive.yaml");
  } else {
    return fail("explicit_instance_required");
  }
  if (!existsSync(path)) return fail("config_missing");
  const yaml: unknown = parseYaml(readFileSync(path, "utf8"));
  if (
    !yaml ||
    typeof yaml !== "object" ||
    !("instance" in yaml) ||
    !yaml.instance ||
    typeof yaml.instance !== "object" ||
    !("id" in yaml.instance) ||
    typeof yaml.instance.id !== "string"
  )
    return fail("instance_id_missing");
  const instanceId = idSchema.parse(yaml.instance.id);
  if (options.instance && instanceId !== options.instance) return fail("instance_id_mismatch");
  const suffix = basename(path).match(/^hive-(.+)\.yaml$/)?.[1];
  const envPath = resolve(dirname(path), suffix ? ".env-" + suffix : ".env");
  const fileEnv = existsSync(envPath) ? dotenv.parse(readFileSync(envPath)) : {};
  // Matches config.ts precedence; a sentinel verifies the resulting target.
  const setting = (key: string, fallback: string) =>
    env[key] || fileEnv[key] || fromKeychain(instanceId, key) || fallback;
  return {
    configPath: path,
    instanceId,
    uri: setting("MONGODB_URI", "mongodb://localhost:27017"),
    dbName: setting("MONGODB_DB", "hive_" + instanceId),
  };
}
export interface CliConnection {
  db: Db;
  close(): Promise<void>;
}
export interface CliDependencies {
  connect(selection: CliSelection): Promise<CliConnection>;
  clock(): Date;
  emit(text: string): void;
}
const defaults: CliDependencies = {
  async connect(selection) {
    const client = new MongoClient(selection.uri, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 10_000,
    });
    try {
      await client.connect();
      return { db: client.db(selection.dbName), close: () => client.close() };
    } catch (err) {
      await client.close();
      throw err;
    }
  },
  clock: () => new Date(),
  emit: (text) => console.log(text),
};
export async function runObligations(argv: string[], deps: CliDependencies = defaults): Promise<void> {
  try {
    await executeObligations(argv, deps);
  } catch (err) {
    if (err instanceof ObligationError) throw err;
    if (err instanceof ZodError) throw new ObligationError("invalid_input");
    if (err instanceof SyntaxError) throw new ObligationError("invalid_json");
    throw new ObligationError("command_failed");
  }
}
async function executeObligations(argv: string[], deps: CliDependencies): Promise<void> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: "string" },
      instance: { type: "string" },
      file: { type: "string" },
      reason: { type: "string" },
      json: { type: "boolean", default: false },
      limit: { type: "string", default: "20" },
      cursor: { type: "string" },
    },
  });
  const [command, subcommand, id, extra] = parsed.positionals;
  if (command !== "obligations" || extra) return fail("invalid_command");
  if (!["register", "list", "show", "deactivate"].includes(subcommand ?? "")) return fail("invalid_command");
  if ((subcommand === "register" || subcommand === "list") && id) return fail("unexpected_id");
  if ((subcommand === "show" || subcommand === "deactivate") && !id) return fail("id_required");
  if (id) idSchema.parse(id);
  const limit = Number(parsed.values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail("invalid_limit");
  const input =
    subcommand === "register"
      ? registrationSchema.parse(JSON.parse(readFileSync(parsed.values.file ?? fail("file_required"), "utf8")))
      : undefined;
  if (subcommand === "deactivate" && !parsed.values.reason?.trim()) return fail("reason_required");
  const selection = selectInstance(parsed.values);
  const connection = await deps.connect(selection);
  try {
    const identity = await verifySentinel(connection.db, {
      instanceId: selection.instanceId,
      dbName: selection.dbName,
    });
    if (identity.state !== "verified") return fail("identity_unverified");
    const guard = new WriteGuard({ instanceId: selection.instanceId, dbName: selection.dbName });
    const db = guardDb(connection.db, guard);
    const store = new ObligationStore(db);
    // No init() on read paths. Reader discovers the actual existing TTL.
    const receipts = new ReceiptStore(db);
    const reader = new ObligationReader(store, receipts, deps.clock);
    let result: unknown;
    if (subcommand === "register") {
      await store.init();
      const registered = await store.register(input, deps.clock());
      const next = [];
      let after = new Date(Math.max(registered.activeFrom.getTime(), deps.clock().getTime()));
      for (let i = 0; i < 3; i++) {
        after = adjacent(registered.deadline, after, 1);
        if (registered.deactivatedAt && after > registered.deactivatedAt) break;
        next.push({ dueAt: after, local: localDeadline(registered, after) });
      }
      result = { definition: registered, upcoming: next, enrollmentRequired: true };
    } else if (subcommand === "deactivate") {
      const before = await store.get(id!);
      if (!before) return fail("unknown_obligation");
      const outstandingFilter = {
        obligationId: id!,
        $or: [
          { "delivery.state": { $in: ["sending", "unknown"] } },
          { "notice.state": { $in: ["sending", "unknown"] } },
        ],
      };
      const outstanding = await store.occurrencesPage(outstandingFilter, undefined, 100);
      const outstandingCount = await store.occurrences.countDocuments(outstandingFilter);
      const definition = await store.deactivate(id!, parsed.values.reason!, deps.clock());
      result = {
        definition,
        admission: definition.deliveryAdmission ?? null,
        outstanding: await Promise.all(outstanding.map((o) => reader.occurrenceView(o))),
        outstandingCount,
        truncated: outstandingCount > outstanding.length,
        policy:
          "Deadlines at or before the cutoff remain due. Later expectations are cancelled. An attempt admitted before this update may finish; acknowledged evidence is retained. Schedules are unchanged.",
      };
    } else if (subcommand === "list") {
      result = await reader.definitions(undefined, {
        section: "definitions",
        cursor: parsed.values.cursor,
        limit,
      });
    } else {
      result = await reader.show(id!, { cursor: parsed.values.cursor, limit });
    }
    deps.emit(JSON.stringify(result, null, parsed.values.json ? undefined : 2));
  } finally {
    await connection.close();
  }
}
