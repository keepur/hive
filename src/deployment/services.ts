import { execFile as nodeExecFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";

const execFile = promisify(nodeExecFile);

export const servicePortKeys = [
  "BG_TASK_PORT",
  "MEETING_MONITOR_PORT",
  "CODE_TASK_PORT",
  "WS_PORT",
  "ADMIN_API_PORT",
  "VOICE_PORT",
  "SLACK_INTERNAL_PORT",
  "BEEKEEPER_PORT",
] as const;

export type ServicePortKey = (typeof servicePortKeys)[number];
export type ServiceOverrides = Partial<Record<ServicePortKey, string>>;
export type ServiceComponent = "engine" | "voice-worker";

export interface ServiceDefinition {
  label: string;
  nodePath: string;
  entrypoint: string;
  args: string[];
  hiveHome: string;
  configPath: string;
  home: string;
  pathEnv: string;
  overrides: ServiceOverrides;
  stdout: string;
  stderr: string;
}

export interface ServiceDefinitionInput {
  instanceId: string;
  nodePath: string;
  hiveHome: string;
  configPath: string;
  home: string;
  pathEnv: string;
  engineOverrides?: ServiceOverrides;
  workerOverrides?: ServiceOverrides;
}

const instanceIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const labelPattern = /^com\.hive\.([a-zA-Z0-9][a-zA-Z0-9_-]*)\.(agent|voice-worker)$/;

export function validateInstanceId(instanceId: string): string {
  if (!instanceIdPattern.test(instanceId)) throw new Error("invalid Hive instance ID");
  return instanceId;
}

export function getServiceLabel(instanceId: string, component: ServiceComponent): string {
  validateInstanceId(instanceId);
  return `com.hive.${instanceId}.${component === "engine" ? "agent" : "voice-worker"}`;
}

export function getServicePlistPath(hiveHome: string, instanceId: string, component: ServiceComponent): string {
  if (!isAbsolute(hiveHome)) throw new Error("HIVE_HOME path must be absolute");
  return resolve(hiveHome, "service", `${getServiceLabel(instanceId, component)}.plist`);
}

export function getServiceLaunchAgentLink(home: string, instanceId: string, component: ServiceComponent): string {
  if (!isAbsolute(home)) throw new Error("HOME path must be absolute");
  return resolve(home, "Library", "LaunchAgents", `${getServiceLabel(instanceId, component)}.plist`);
}

function assertServicePortOverride(key: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error(`invalid service port override: ${key}`);
  }
}

export function buildServiceEnvironment(
  service: Pick<ServiceDefinition, "hiveHome" | "configPath" | "home" | "pathEnv" | "overrides">,
): Record<string, string> {
  const env: Record<string, string> = {
    HIVE_HOME: service.hiveHome,
    HIVE_CONFIG: service.configPath,
    HOME: service.home,
    PATH: service.pathEnv,
  };
  for (const [key, value] of Object.entries(service.overrides)) {
    if (!servicePortKeys.some((allowed) => allowed === key)) throw new Error("unsupported service override");
    assertServicePortOverride(key, value);
    env[key] = value;
  }
  return env;
}

const xml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!,
  );

export function buildServicePlist(service: ServiceDefinition): string {
  const string = (value: string): string => `<string>${xml(value)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key>${string(service.label)}
<key>ProgramArguments</key><array>${[service.nodePath, service.entrypoint, ...service.args].map(string).join("")}</array>
<key>WorkingDirectory</key>${string(service.hiveHome)}
<key>EnvironmentVariables</key><dict>
${Object.entries(buildServiceEnvironment(service))
  .map(([key, value]) => `<key>${xml(key)}</key>${string(value)}`)
  .join("")}
</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key>${string(service.stdout)}
<key>StandardErrorPath</key>${string(service.stderr)}
</dict></plist>\n`;
}

export function buildServiceDefinitions(input: ServiceDefinitionInput): {
  engine: ServiceDefinition;
  worker: ServiceDefinition;
} {
  validateInstanceId(input.instanceId);
  for (const [name, path] of [
    ["node", input.nodePath],
    ["HIVE_HOME", input.hiveHome],
    ["HIVE_CONFIG", input.configPath],
    ["HOME", input.home],
  ] as const) {
    if (!isAbsolute(path)) throw new Error(`${name} path must be absolute`);
  }
  const common = {
    nodePath: input.nodePath,
    hiveHome: input.hiveHome,
    configPath: input.configPath,
    home: input.home,
    pathEnv: input.pathEnv,
  };
  const engine: ServiceDefinition = {
    ...common,
    label: getServiceLabel(input.instanceId, "engine"),
    entrypoint: resolve(input.hiveHome, ".hive", "pkg", "server.min.js"),
    args: [],
    overrides: input.engineOverrides ?? {},
    stdout: resolve(input.hiveHome, "logs", "hive.log"),
    stderr: resolve(input.hiveHome, "logs", "hive.err"),
  };
  const worker: ServiceDefinition = {
    ...common,
    label: getServiceLabel(input.instanceId, "voice-worker"),
    entrypoint: resolve(input.hiveHome, ".hive", "pkg", "voice-worker.min.js"),
    args: ["start"],
    overrides: input.workerOverrides ?? {},
    stdout: resolve(input.hiveHome, "logs", "voice-worker.log"),
    stderr: resolve(input.hiveHome, "logs", "voice-worker.err"),
  };
  reconcileServiceOverrides([engine, worker]);
  return { engine, worker };
}

/**
 * Documented launchd argv: absolute Node, an entrypoint that is absolute or
 * exists after resolve against WorkingDirectory, then optional non-path
 * tokens such as `start`. Empty argv is never accepted.
 */
export function captureProgramArguments(
  args: unknown,
  workingDirectory: string,
  exists: (path: string) => boolean = existsSync,
): string[] {
  if (!Array.isArray(args) || args.length === 0) {
    throw new Error("ProgramArguments are empty");
  }
  if (!args.every((item) => typeof item === "string" && item.length > 0)) {
    throw new Error("ProgramArguments are not documented executable argv");
  }
  if (args.length < 2) {
    throw new Error("ProgramArguments must include node and an entrypoint");
  }
  if (typeof workingDirectory !== "string" || !isAbsolute(workingDirectory)) {
    throw new Error("WorkingDirectory is invalid");
  }
  const argv = args as string[];
  if (!isAbsolute(argv[0]!)) {
    throw new Error("ProgramArguments node executable must be an absolute path");
  }
  const entrypoint = argv[1]!;
  if (!isAbsolute(entrypoint)) {
    const resolved = resolve(workingDirectory, entrypoint);
    if (!exists(resolved)) {
      throw new Error("ProgramArguments entrypoint does not exist under WorkingDirectory");
    }
  }
  return argv;
}

export function reconcileServiceOverrides(definitions: readonly ServiceDefinition[]): void {
  const values = new Map<ServicePortKey, string>();
  for (const definition of definitions) {
    buildServiceEnvironment(definition);
    for (const key of servicePortKeys) {
      const value = definition.overrides[key];
      if (value === undefined) continue;
      const previous = values.get(key);
      if (previous !== undefined && previous !== value) {
        throw new Error(`conflicting service override: ${key}`);
      }
      values.set(key, value);
    }
  }
  const owners = new Map<string, ServicePortKey>();
  for (const [key, value] of values) {
    const owner = owners.get(value);
    if (owner !== undefined && owner !== key) {
      throw new Error(`conflicting service listener overrides: ${owner} and ${key}`);
    }
    owners.set(value, key);
  }
}

export interface ExecFileOptions {
  env?: Record<string, string>;
}

export interface ExecFileResult {
  stdout: string;
  stderr: string;
}

export interface ServiceFileStat {
  mode: number;
  dev: number;
  ino: number;
  /** Owner UID; required by read-only capture discovery. */
  uid?: number;
  size?: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** Every operating-system and filesystem effect used by service lifecycle code. */
export interface ServiceIO {
  execFile(command: string, args: readonly string[], options?: ExecFileOptions): Promise<ExecFileResult>;
  access(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  lstat(path: string): Promise<ServiceFileStat>;
  mkdir(path: string, options: { recursive: boolean; mode: number }): Promise<void>;
  readFile(path: string): Promise<Buffer>;
  readlink(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  writeFile(path: string, data: string | Buffer, options: { mode: number; flag?: "wx" }): Promise<void>;
  getuid(): number;
  now(): number;
  sleep(milliseconds: number): Promise<void>;
  randomId(): string;
}

const commandEnv = { LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };

export const nodeServiceIO: ServiceIO = {
  async execFile(command, args, options) {
    const result = await execFile(command, [...args], {
      encoding: "utf8",
      env: options?.env,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  },
  access,
  chmod,
  lstat,
  async mkdir(path, options) {
    await mkdir(path, options);
  },
  async readFile(path) {
    return readFile(path);
  },
  readlink,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
  getuid() {
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("service management requires a POSIX user ID");
    return uid;
  },
  now: Date.now,
  sleep(milliseconds) {
    return new Promise((finish) => setTimeout(finish, milliseconds));
  },
  randomId: randomUUID,
};

export interface FileIdentity {
  path: string;
  canonicalPath: string;
  dev: number;
  ino: number;
  mode: number;
}

export interface ProcessIdentity {
  pid: number;
  ppid: number;
  startTime: string;
  command: string;
  executable: string;
  cwd: string;
}

export interface ServiceInspection {
  label: string;
  loaded: boolean;
  enabled: boolean;
  livePID: number | null;
  startTime: string | null;
  args: string[] | null;
  cwd: string | null;
  configSelection: string | null;
  serviceEnvironment: Record<string, string> | null;
  plist: FileIdentity | null;
  link: (FileIdentity & { target: string }) | null;
  process: ProcessIdentity | null;
}

export interface ListenerInspection {
  port: number;
  pid: number | null;
}

interface PreviousFile {
  path: string;
  existed: boolean;
  bytes?: Buffer;
  mode?: number;
}

interface PreviousLink {
  path: string;
  existed: boolean;
  target?: string;
}

export interface CapturedServiceDefinition {
  definition: ServiceDefinition;
  inspection: ServiceInspection;
  /** Effective plist role: the file the LaunchAgent link actually loads. */
  plist: PreviousFile;
  /**
   * Instance-owned generated plist role (`<home>/service/<label>.plist`). It is
   * recorded separately even when both roles name the same file; an external
   * effective original is verified and never rewritten.
   */
  instancePlist: PreviousFile;
  link: PreviousLink;
  loaded: boolean;
  enabled: boolean;
}

export interface ServiceSnapshot {
  services: CapturedServiceDefinition[];
}

export interface ProcessCensusRow {
  pid: number;
  ppid: number;
  startTime: string;
  command: string;
  depth: number;
}

/** What an operation-owned capture ticket asserts after live revalidation. */
export interface CaptureTicketLease {
  operationId: string;
  instanceId: string;
  hiveHome: string;
  configPath: string;
}

export interface CaptureFileSeal {
  path: string;
  realpath: string;
  uid: number;
  mode: number;
  dev: number;
  ino: number;
  size: number;
  sha256: string;
  bytes: Buffer;
}

export interface CaptureDiscovery {
  label: string;
  enabled: boolean;
  process: ProcessIdentity;
  args: string[];
  cwd: string;
  configSelection: string;
  serviceEnvironment: Record<string, string>;
  stdout: string;
  stderr: string;
  link: { path: string; target: string; resolvedTarget: string; dev: number; ino: number };
  effectivePlist: CaptureFileSeal;
  instancePlist: { path: string; existed: boolean; seal: CaptureFileSeal | null };
}

export interface ServiceControllerOptions {
  instanceId: string;
  hiveHome: string;
  home: string;
  operationDir: string;
  capturedPilotProfile?: readonly { label: string; plistPath: string }[];
  /**
   * Validates an opaque, in-memory capture ticket against the live acquired
   * capture operation (owned by the pilot evidence module). Never serialized.
   */
  captureTicketValidator?: (ticket: object) => Promise<CaptureTicketLease>;
  stopTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface BootoutOptions {
  markIrreversible(): Promise<void>;
  /**
   * The worker supervisor's recorded health listener. A worker stop is
   * complete only when the supervisor PID/start time has exited and this
   * listener has no owner; any other owner is reported, never killed.
   */
  healthListenerPort?: number;
  /**
   * Last-moment signal fence (chunk 5 Step 4c.2a): called synchronously after
   * `markIrreversible` and every awaited inspection, immediately before the
   * `launchctl bootout` dispatch, with no await in between. A throw aborts the
   * stop before any signal is issued.
   */
  beforeExec?(): void;
}

interface PlistFields {
  Label?: unknown;
  ProgramArguments?: unknown;
  WorkingDirectory?: unknown;
  EnvironmentVariables?: unknown;
  StandardOutPath?: unknown;
  StandardErrorPath?: unknown;
}

function errorText(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const candidate = error as { message?: unknown; stderr?: unknown };
  return `${typeof candidate.message === "string" ? candidate.message : ""}\n${
    typeof candidate.stderr === "string" || Buffer.isBuffer(candidate.stderr) ? String(candidate.stderr) : ""
  }`;
}

function errorCode(error: unknown): string | number | undefined {
  return error && typeof error === "object" ? (error as { code?: string | number }).code : undefined;
}

function errorStdout(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const stdout = (error as { stdout?: unknown }).stdout;
  return typeof stdout === "string" || Buffer.isBuffer(stdout) ? String(stdout) : "";
}

function missingFile(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function unloadedService(error: unknown): boolean {
  const message = errorText(error);
  return /Could not find service|Could not find specified service|service not found|No such process/i.test(message);
}

function assertPort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("invalid listener port");
}

function parseLaunchctl(output: string): { pid: number | null } {
  const state = output.match(/^\s*state\s*=\s*([^\n]+?)\s*$/m)?.[1];
  if (!state) throw new Error("could not parse launchctl state");
  const pidText = output.match(/^\s*pid\s*=\s*(\d+)\s*$/m)?.[1];
  if (state === "running" && !pidText) throw new Error("running launchd service has no PID");
  const pid = pidText ? Number(pidText) : null;
  if (pid !== null && (!Number.isSafeInteger(pid) || pid < 1)) throw new Error("invalid launchd PID");
  return { pid };
}

function parseDisabled(output: string, label: string): boolean {
  if (!/disabled services\s*=\s*\{[\s\S]*\}/.test(output)) {
    throw new Error("could not parse launchctl disabled services");
  }
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = output.match(new RegExp(`["']?${escaped}["']?\\s*=>\\s*(true|false)`));
  return match?.[1] !== "true";
}

interface ProcessRow {
  pid: number;
  ppid: number;
  startTime: string;
  command: string;
}

function parseProcessRows(output: string): ProcessRow[] {
  if (!output.trim()) return [];
  return output
    .trimEnd()
    .split("\n")
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.+?)\s*$/);
      if (!match) throw new Error("could not parse process census");
      return { pid: Number(match[1]), ppid: Number(match[2]), startTime: match[3], command: match[4] };
    });
}

function parseLsofPaths(output: string, kind: string): string[] {
  const lines = output.trim().split("\n");
  const names = lines.filter((line) => line.startsWith("n")).map((line) => line.slice(1));
  if (names.length === 0 || names.some((name) => !isAbsolute(name))) {
    throw new Error(`could not parse process ${kind}`);
  }
  return names;
}

async function fileIdentity(io: ServiceIO, path: string): Promise<FileIdentity> {
  const stat = await io.lstat(path);
  return {
    path,
    canonicalPath: await io.realpath(path),
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
  };
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function componentForLabel(label: string): ServiceComponent {
  const match = label.match(labelPattern);
  if (!match) throw new Error("invalid Hive service label");
  validateInstanceId(match[1]);
  return match[2] === "agent" ? "engine" : "voice-worker";
}

export class ServiceController {
  readonly #io: ServiceIO;
  readonly #pilotPlists = new Map<string, string>();
  readonly #options: Required<Pick<ServiceControllerOptions, "stopTimeoutMs" | "pollIntervalMs">> &
    Omit<ServiceControllerOptions, "stopTimeoutMs" | "pollIntervalMs">;

  constructor(options: ServiceControllerOptions, io: ServiceIO = nodeServiceIO) {
    validateInstanceId(options.instanceId);
    if (!isAbsolute(options.hiveHome) || !isAbsolute(options.home) || !isAbsolute(options.operationDir)) {
      throw new Error("service controller paths must be absolute");
    }
    if (!isWithin(resolve(options.hiveHome, ".hive-state", "deployment", "operations"), options.operationDir)) {
      throw new Error("operation directory must be under the selected Hive home");
    }
    this.#options = { stopTimeoutMs: 30_000, pollIntervalMs: 1_000, ...options };
    this.#io = io;
    for (const pilot of options.capturedPilotProfile ?? []) {
      const component = componentForLabel(pilot.label);
      if (pilot.label !== getServiceLabel(options.instanceId, component) || !isAbsolute(pilot.plistPath)) {
        throw new Error("invalid captured pilot service profile");
      }
      this.#pilotPlists.set(pilot.label, pilot.plistPath);
    }
  }

  #plistPath(label: string): string {
    const component = componentForLabel(label);
    if (label !== getServiceLabel(this.#options.instanceId, component)) throw new Error("foreign Hive service label");
    return resolve(this.#options.hiveHome, "service", `${label}.plist`);
  }

  #linkPath(label: string): string {
    const component = componentForLabel(label);
    if (label !== getServiceLabel(this.#options.instanceId, component)) throw new Error("foreign Hive service label");
    return resolve(this.#options.home, "Library", "LaunchAgents", `${label}.plist`);
  }

  async #readPlist(path: string): Promise<PlistFields | null> {
    try {
      await this.#io.access(path);
    } catch (error) {
      if (missingFile(error)) return null;
      throw error;
    }
    const result = await this.#io.execFile("plutil", ["-convert", "json", "-o", "-", path], {
      env: commandEnv,
    });
    try {
      const parsed: unknown = JSON.parse(result.stdout);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      return parsed as PlistFields;
    } catch {
      throw new Error("could not parse service plist");
    }
  }

  async #enrichProcess(row: ProcessRow): Promise<ProcessIdentity> {
    const [cwdResult, executableResult, commResult] = await Promise.all([
      this.#io.execFile("lsof", ["-a", "-p", String(row.pid), "-d", "cwd", "-Fn"], {
        env: commandEnv,
      }),
      this.#io.execFile("lsof", ["-a", "-p", String(row.pid), "-d", "txt", "-Fn"], {
        env: commandEnv,
      }),
      this.#io.execFile("ps", ["-ww", "-p", String(row.pid), "-o", "comm="], { env: commandEnv }),
    ]);
    const cwdPaths = parseLsofPaths(cwdResult.stdout, "cwd");
    if (cwdPaths.length !== 1) throw new Error("could not identify process cwd");
    const comm = commResult.stdout.trim();
    if (!comm || comm.includes("\n") || !isAbsolute(comm)) throw new Error("could not parse process executable");
    const cwd = await this.#io.realpath(cwdPaths[0]);
    const executable = await this.#io.realpath(comm);
    const textPaths = await Promise.all(
      parseLsofPaths(executableResult.stdout, "text mappings").map((path) => this.#io.realpath(path)),
    );
    if (!textPaths.includes(executable)) throw new Error("process executable is absent from text mappings");
    const confirmation = await this.#io.execFile(
      "ps",
      ["-ww", "-p", String(row.pid), "-o", "pid=,ppid=,lstart=,command="],
      { env: commandEnv },
    );
    const confirmedRows = parseProcessRows(confirmation.stdout);
    if (
      confirmedRows.length !== 1 ||
      confirmedRows[0].pid !== row.pid ||
      confirmedRows[0].ppid !== row.ppid ||
      confirmedRows[0].startTime !== row.startTime ||
      confirmedRows[0].command !== row.command
    ) {
      throw new Error("process identity changed during inspection");
    }
    return { ...row, cwd, executable };
  }

  async process(pid: number): Promise<ProcessIdentity | null> {
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("invalid PID");
    let result: ExecFileResult;
    try {
      result = await this.#io.execFile("ps", ["-ww", "-p", String(pid), "-o", "pid=,ppid=,lstart=,command="], {
        env: commandEnv,
      });
    } catch (error) {
      if (errorCode(error) === 1 && !errorStdout(error).trim()) return null;
      throw error;
    }
    const rows = parseProcessRows(result.stdout);
    if (rows.length === 0) return null;
    if (rows.length !== 1 || rows[0].pid !== pid) throw new Error("unexpected process query result");
    return this.#enrichProcess(rows[0]);
  }

  async inspect(label: string): Promise<ServiceInspection> {
    const targetPlistPath = this.#plistPath(label);
    const linkPath = this.#linkPath(label);
    const domain = `gui/${this.#io.getuid()}`;
    let loaded = true;
    let livePID: number | null = null;
    try {
      const result = await this.#io.execFile("launchctl", ["print", `${domain}/${label}`], { env: commandEnv });
      livePID = parseLaunchctl(result.stdout).pid;
    } catch (error) {
      if (!unloadedService(error)) {
        throw new Error(`launchctl inspection failed for ${label}: ${errorText(error)}`, { cause: error });
      }
      loaded = false;
    }
    const disabled = await this.#io.execFile("launchctl", ["print-disabled", domain], { env: commandEnv });
    const enabled = parseDisabled(disabled.stdout, label);
    let link: ServiceInspection["link"] = null;
    let plistPath = targetPlistPath;
    try {
      const stat = await this.#io.lstat(linkPath);
      if (!stat.isSymbolicLink()) throw new Error("LaunchAgent link is not a symlink");
      const target = await this.#io.readlink(linkPath);
      const resolvedTarget = resolve(resolve(linkPath, ".."), target);
      const pilotPlistPath = this.#pilotPlists.get(label);
      if (resolvedTarget !== targetPlistPath && resolvedTarget !== pilotPlistPath) {
        throw new Error("foreign LaunchAgent link target");
      }
      plistPath = resolvedTarget;
      link = { ...(await fileIdentity(this.#io, linkPath)), target };
    } catch (error) {
      if (!missingFile(error)) throw error;
    }
    const fields = await this.#readPlist(plistPath);
    if (loaded && !fields) throw new Error("loaded service has no readable plist");
    let plist: FileIdentity | null = null;
    if (fields) {
      plist = await fileIdentity(this.#io, plistPath);
      if (!plist || fields.Label !== label) throw new Error("service plist label mismatch");
      if (
        !Array.isArray(fields.ProgramArguments) ||
        !fields.ProgramArguments.every((item) => typeof item === "string")
      ) {
        throw new Error("invalid service ProgramArguments");
      }
      if (typeof fields.WorkingDirectory !== "string") throw new Error("invalid service WorkingDirectory");
    }
    const currentProcess = livePID === null ? null : await this.process(livePID);
    if (livePID !== null && !currentProcess) throw new Error("launchd PID disappeared during inspection");
    const environment = fields?.EnvironmentVariables;
    if (environment !== undefined && (!environment || typeof environment !== "object" || Array.isArray(environment))) {
      throw new Error("invalid service EnvironmentVariables");
    }
    const env = environment as Record<string, unknown> | undefined;
    let serviceEnvironment: Record<string, string> | null = null;
    if (env) {
      serviceEnvironment = {};
      const allowed = new Set<string>(["HIVE_HOME", "HIVE_CONFIG", "HOME", "PATH", ...servicePortKeys]);
      for (const [key, value] of Object.entries(env)) {
        if (!allowed.has(key)) throw new Error(`unsupported legacy service environment override: ${key}`);
        if (typeof value !== "string") throw new Error(`invalid service environment value: ${key}`);
        if (servicePortKeys.some((portKey) => portKey === key)) assertServicePortOverride(key, value);
        serviceEnvironment[key] = value;
      }
    }
    return {
      label,
      loaded,
      enabled,
      livePID,
      startTime: currentProcess?.startTime ?? null,
      args: (fields?.ProgramArguments as string[] | undefined) ?? null,
      cwd: (fields?.WorkingDirectory as string | undefined) ?? null,
      configSelection: typeof env?.HIVE_CONFIG === "string" ? env.HIVE_CONFIG : null,
      serviceEnvironment,
      plist,
      link,
      process: currentProcess,
    };
  }

  /** Every PID listening on a loopback/any TCP port; observation only, never signals. */
  async listenerOwners(port: number): Promise<number[]> {
    assertPort(port);
    let result: ExecFileResult;
    try {
      result = await this.#io.execFile("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpn"], {
        env: commandEnv,
      });
    } catch (error) {
      if (errorCode(error) === 1 && !errorStdout(error).trim()) return [];
      throw error;
    }
    if (!result.stdout.trim()) return [];
    const pids = new Set<number>();
    let currentPID: number | null = null;
    for (const line of result.stdout.trim().split("\n")) {
      if (line.startsWith("p") && /^p\d+$/.test(line)) {
        currentPID = Number(line.slice(1));
        pids.add(currentPID);
      } else if (line.startsWith("n") && currentPID !== null) {
        continue;
      } else if (/^[a-zA-Z]/.test(line) && !line.startsWith("n")) {
        // Darwin lsof -Fpn still emits fd records (`f5`) and other field letters.
        continue;
      } else {
        throw new Error("could not parse listener ownership");
      }
    }
    return [...pids];
  }

  async listener(port: number, expectedSupervisorPID: number): Promise<ListenerInspection> {
    assertPort(port);
    if (!Number.isSafeInteger(expectedSupervisorPID) || expectedSupervisorPID < 1)
      throw new Error("invalid expected PID");
    const pids = new Set(await this.listenerOwners(port));
    if (pids.size === 0) return { port, pid: null };
    if (pids.size !== 1 || !pids.has(expectedSupervisorPID)) {
      throw new Error("unexpected listener owner");
    }
    return { port, pid: expectedSupervisorPID };
  }

  /**
   * Inventory-only process census (chunk 4 Task 9 Step 4b.3 `process-census`):
   * the descendants of one root PID from a single `ps` snapshot. This is an
   * observation for evidence; it is never a stop, rotation or staging
   * settlement gate and never selects a kill target.
   */
  async processCensus(rootPid: number): Promise<ProcessCensusRow[]> {
    if (!Number.isSafeInteger(rootPid) || rootPid < 1) throw new Error("invalid PID");
    const result = await this.#io.execFile("ps", ["-ww", "-axo", "pid=,ppid=,lstart=,command="], {
      env: commandEnv,
    });
    const rows = parseProcessRows(result.stdout);
    const byParent = new Map<number, ProcessRow[]>();
    for (const row of rows) byParent.set(row.ppid, [...(byParent.get(row.ppid) ?? []), row]);
    const out: ProcessCensusRow[] = [];
    const depth = new Map<number, number>([[rootPid, 0]]);
    const queue = [rootPid];
    while (queue.length > 0) {
      const parent = queue.shift()!;
      for (const child of byParent.get(parent) ?? []) {
        if (depth.has(child.pid)) continue;
        depth.set(child.pid, depth.get(parent)! + 1);
        out.push({ ...child, depth: depth.get(child.pid)! });
        queue.push(child.pid);
      }
    }
    return out;
  }

  /**
   * TCP listening ports owned by one PID, loopback or wildcard only
   * (observation-only; chunk 4 Step 4b.1 SDK listener discovery). Never
   * signals and never selects a kill target.
   */
  async listenersOf(pid: number): Promise<number[]> {
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("invalid PID");
    let result: ExecFileResult;
    try {
      result = await this.#io.execFile("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], {
        env: commandEnv,
      });
    } catch (error) {
      if (errorCode(error) === 1 && !errorStdout(error).trim()) return [];
      throw error;
    }
    const ports = new Set<number>();
    for (const line of result.stdout.trim().split("\n").filter(Boolean)) {
      if (/^[pf]/.test(line)) continue;
      const match = /^n(127\.0\.0\.1|\*|\[::1\]|localhost):(\d{1,5})$/.exec(line);
      if (!match) {
        if (line.startsWith("n")) continue; // non-loopback listeners are not SDK candidates
        throw new Error("could not parse listener ports");
      }
      const port = Number(match[2]);
      assertPort(port);
      ports.add(port);
    }
    return [...ports].sort((left, right) => left - right);
  }

  /** PIDs holding a file open for writing (observation-only exclusive-writer corroboration). */
  async fileWriters(path: string): Promise<number[]> {
    if (!isAbsolute(path)) throw new Error("writer query path must be absolute");
    let result: ExecFileResult;
    try {
      result = await this.#io.execFile("lsof", ["-nP", "-Fpa", "--", path], { env: commandEnv });
    } catch (error) {
      if (errorCode(error) === 1 && !errorStdout(error).trim()) return [];
      throw error;
    }
    const writers = new Set<number>();
    let current: number | null = null;
    for (const line of result.stdout.trim().split("\n").filter(Boolean)) {
      if (/^p\d+$/.test(line)) current = Number(line.slice(1));
      else if (/^a[rwu ]?$/.test(line)) {
        if (current !== null && (line === "aw" || line === "au")) writers.add(current);
      } else if (!/^f/.test(line)) {
        throw new Error("could not parse open-file writers");
      }
    }
    return [...writers];
  }

  /** Numeric UID of a live process (`ps -o uid=`); null when the process is absent. */
  async processUid(pid: number): Promise<number | null> {
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("invalid PID");
    let result: ExecFileResult;
    try {
      result = await this.#io.execFile("ps", ["-p", String(pid), "-o", "uid="], { env: commandEnv });
    } catch (error) {
      if (errorCode(error) === 1 && !errorStdout(error).trim()) return null;
      throw error;
    }
    const text = result.stdout.trim();
    if (!/^\d+$/.test(text)) throw new Error("could not parse process UID");
    return Number(text);
  }

  /**
   * Operation-private, read-only discovery of the live effective service pair
   * for a first pilot capture (chunk 5 Task 9 Step 4b.1a Step 2). The ticket is
   * an opaque in-memory object revalidated through the injected validator
   * before each label read; no serialized flag grants this path. An external
   * LaunchAgent target is permitted for this read only. Nothing is written,
   * signaled, loaded or unloaded, and the ordinary `inspect` target check is
   * not loosened.
   */
  async discoverForCapture(ticket: object): Promise<CaptureDiscovery[]> {
    const validator = this.#options.captureTicketValidator;
    if (!validator) throw new Error("PILOT_CAPTURE_BLOCKED: no capture ticket validator");
    const uid = this.#io.getuid();
    const domain = `gui/${uid}`;
    const out: CaptureDiscovery[] = [];
    for (const component of ["engine", "voice-worker"] as const) {
      const label = getServiceLabel(this.#options.instanceId, component);
      const lease = await validator(ticket);
      if (lease.instanceId !== this.#options.instanceId || lease.hiveHome !== this.#options.hiveHome) {
        throw new Error("PILOT_CAPTURE_BLOCKED: capture ticket belongs to another instance");
      }
      const printed = await this.#io.execFile("launchctl", ["print", `${domain}/${label}`], { env: commandEnv });
      const livePID = parseLaunchctl(printed.stdout).pid;
      if (livePID === null) throw new Error(`PILOT_CAPTURE_BLOCKED: ${label} is not running`);
      const enabled = parseDisabled(
        (await this.#io.execFile("launchctl", ["print-disabled", domain], { env: commandEnv })).stdout,
        label,
      );
      const before = await this.process(livePID);
      if (!before) throw new Error(`PILOT_CAPTURE_BLOCKED: ${label} process disappeared`);

      const linkPath = this.#linkPath(label);
      const linkStat = await this.#io.lstat(linkPath).catch((error: unknown) => {
        if (missingFile(error)) throw new Error(`PILOT_CAPTURE_BLOCKED: ${label} has no owned LaunchAgent link`);
        throw error;
      });
      if (!linkStat.isSymbolicLink() || linkStat.uid !== uid) {
        throw new Error(`PILOT_CAPTURE_BLOCKED: ${label} LaunchAgent is not an owned symlink`);
      }
      await this.#assertNotForeignWritable(dirname(linkPath), uid, label);
      const linkTarget = await this.#io.readlink(linkPath);
      const resolvedTarget = resolve(dirname(linkPath), linkTarget);
      const effective = await this.#sealRegularFile(resolvedTarget, uid, label);
      const fields = await this.#readPlist(effective.realpath);
      const parsed = this.#capturePlistFields(fields, label, lease);

      const processRealCwd = before.cwd;
      if (
        before.command !== parsed.args.join(" ") ||
        processRealCwd !== (await this.#io.realpath(parsed.cwd)) ||
        before.executable !== (await this.#io.realpath(parsed.args[0]))
      ) {
        throw new Error(`PILOT_CAPTURE_BLOCKED: ${label} live process does not match its effective plist`);
      }

      const instancePath = this.#plistPath(label);
      let instance: CaptureDiscovery["instancePlist"];
      if (instancePath === resolvedTarget) {
        instance = { path: instancePath, existed: true, seal: effective };
      } else {
        try {
          await this.#io.lstat(instancePath);
          instance = { path: instancePath, existed: true, seal: await this.#sealRegularFile(instancePath, uid, label) };
        } catch (error) {
          if (!missingFile(error)) throw error;
          instance = { path: instancePath, existed: false, seal: null };
        }
      }

      // Re-read correspondence after hashing: any replacement invalidates capture.
      const after = await this.process(livePID);
      const linkAfter = await this.#io.lstat(linkPath);
      const effectiveAfter = await this.#sealRegularFile(resolvedTarget, uid, label);
      if (
        !after ||
        after.startTime !== before.startTime ||
        after.command !== before.command ||
        (await this.#io.readlink(linkPath)) !== linkTarget ||
        linkAfter.dev !== linkStat.dev ||
        linkAfter.ino !== linkStat.ino ||
        effectiveAfter.sha256 !== effective.sha256 ||
        effectiveAfter.dev !== effective.dev ||
        effectiveAfter.ino !== effective.ino
      ) {
        throw new Error(`PILOT_CAPTURE_BLOCKED: ${label} changed during capture discovery`);
      }
      out.push({
        label,
        enabled,
        process: before,
        args: parsed.args,
        cwd: parsed.cwd,
        configSelection: parsed.environment.HIVE_CONFIG,
        stdout: parsed.stdout,
        stderr: parsed.stderr,
        serviceEnvironment: parsed.environment,
        link: { path: linkPath, target: linkTarget, resolvedTarget, dev: linkStat.dev, ino: linkStat.ino },
        effectivePlist: effective,
        instancePlist: instance,
      });
    }
    return out;
  }

  async #assertNotForeignWritable(path: string, uid: number, label: string): Promise<void> {
    const info = await this.#io.lstat(path);
    if ((info.uid !== uid && info.uid !== 0) || (info.mode & 0o022) !== 0) {
      throw new Error(`PILOT_CAPTURE_BLOCKED: ${label} path has a foreign-writable ancestor`);
    }
  }

  async #sealRegularFile(path: string, uid: number, label: string): Promise<CaptureFileSeal> {
    const realpath = await this.#io.realpath(path);
    const leaf = await this.#io.lstat(realpath);
    if (!leaf.isFile() || leaf.isSymbolicLink()) {
      throw new Error(`PILOT_CAPTURE_BLOCKED: ${label} plist is not a regular file`);
    }
    if (leaf.uid === undefined || (leaf.uid !== uid && leaf.uid !== 0) || (leaf.mode & 0o022) !== 0) {
      throw new Error(`PILOT_CAPTURE_BLOCKED: ${label} plist ownership or mode is unsafe`);
    }
    let ancestor = dirname(realpath);
    while (true) {
      await this.#assertNotForeignWritable(ancestor, uid, label);
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    const bytes = await this.#io.readFile(realpath);
    const again = await this.#io.lstat(realpath);
    if (again.dev !== leaf.dev || again.ino !== leaf.ino || (leaf.size !== undefined && again.size !== bytes.length)) {
      throw new Error(`PILOT_CAPTURE_BLOCKED: ${label} plist changed while it was read`);
    }
    return {
      path,
      realpath,
      uid: leaf.uid,
      mode: leaf.mode & 0o777,
      dev: leaf.dev,
      ino: leaf.ino,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes,
    };
  }

  #capturePlistFields(
    fields: PlistFields | null,
    label: string,
    lease: CaptureTicketLease,
  ): { args: string[]; cwd: string; environment: Record<string, string>; stdout: string; stderr: string } {
    if (!fields || fields.Label !== label) throw new Error(`PILOT_CAPTURE_BLOCKED: ${label} plist label mismatch`);
    if (typeof fields.WorkingDirectory !== "string" || !isAbsolute(fields.WorkingDirectory)) {
      throw new Error(`PILOT_CAPTURE_BLOCKED: ${label} WorkingDirectory is invalid`);
    }
    let args: string[];
    try {
      args = captureProgramArguments(fields.ProgramArguments, fields.WorkingDirectory);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`PILOT_CAPTURE_BLOCKED: ${label} ${message}`, { cause: error });
    }
    const env = fields.EnvironmentVariables;
    if (!env || typeof env !== "object" || Array.isArray(env)) {
      throw new Error(`PILOT_CAPTURE_BLOCKED: ${label} has no explicit service environment`);
    }
    const allowed = new Set<string>(["HIVE_HOME", "HIVE_CONFIG", "HOME", "PATH", ...servicePortKeys]);
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      // Unsupported (possibly secret) keys are rejected, never copied to evidence.
      if (!allowed.has(key) || typeof value !== "string") {
        throw new Error(`PILOT_CAPTURE_BLOCKED: ${label} service environment is not allowlisted`);
      }
      if (servicePortKeys.some((portKey) => portKey === key)) assertServicePortOverride(key, value);
      environment[key] = value;
    }
    if (environment.HIVE_HOME !== lease.hiveHome || environment.HIVE_CONFIG !== lease.configPath) {
      throw new Error(`PILOT_CAPTURE_BLOCKED: ${label} selectors differ from the selected instance`);
    }
    if (!environment.HOME || !environment.PATH) {
      throw new Error(`PILOT_CAPTURE_BLOCKED: ${label} service environment lacks HOME or PATH`);
    }
    const logPath = (value: unknown) => {
      if (typeof value !== "string" || !isAbsolute(value)) {
        throw new Error(`PILOT_CAPTURE_BLOCKED: ${label} service log paths are not explicit absolute paths`);
      }
      return value;
    };
    return {
      args,
      cwd: fields.WorkingDirectory,
      environment,
      stdout: logPath(fields.StandardOutPath),
      stderr: logPath(fields.StandardErrorPath),
    };
  }

  async #validateDefinition(definition: ServiceDefinition): Promise<void> {
    const component = componentForLabel(definition.label);
    this.#plistPath(definition.label);
    const expectedEntrypoint = resolve(
      definition.hiveHome,
      ".hive",
      "pkg",
      component === "engine" ? "server.min.js" : "voice-worker.min.js",
    );
    const expectedArgs = component === "engine" ? [] : ["start"];
    const expectedStdout = resolve(
      definition.hiveHome,
      "logs",
      component === "engine" ? "hive.log" : "voice-worker.log",
    );
    const expectedStderr = resolve(
      definition.hiveHome,
      "logs",
      component === "engine" ? "hive.err" : "voice-worker.err",
    );
    if (
      definition.hiveHome !== this.#options.hiveHome ||
      definition.home !== this.#options.home ||
      !isAbsolute(definition.nodePath) ||
      !isAbsolute(definition.entrypoint) ||
      !isAbsolute(definition.configPath) ||
      !isAbsolute(definition.stdout) ||
      !isAbsolute(definition.stderr) ||
      !definition.pathEnv
    ) {
      throw new Error("invalid explicit service definition paths");
    }
    if (
      definition.entrypoint !== expectedEntrypoint ||
      JSON.stringify(definition.args) !== JSON.stringify(expectedArgs) ||
      definition.stdout !== expectedStdout ||
      definition.stderr !== expectedStderr
    ) {
      throw new Error("invalid packaged service definition");
    }
    buildServiceEnvironment(definition);
    const canonicalHome = await this.#io.realpath(definition.hiveHome);
    const canonicalEngine = await this.#io.realpath(resolve(canonicalHome, ".hive"));
    const canonicalEntrypoint = await this.#io.realpath(definition.entrypoint);
    if (!isWithin(canonicalEngine, canonicalEntrypoint)) throw new Error("service entrypoint escapes canonical .hive");
    const canonicalNode = await this.#io.realpath(definition.nodePath);
    if (isWithin(canonicalEngine, canonicalNode)) throw new Error("Node prerequisite must be external to .hive");
    const nodeStat = await this.#io.lstat(canonicalNode);
    const entryStat = await this.#io.lstat(canonicalEntrypoint);
    const configStat = await this.#io.lstat(await this.#io.realpath(definition.configPath));
    if (!nodeStat.isFile()) throw new Error("Node prerequisite is not a file");
    if (!entryStat.isFile()) throw new Error("service entrypoint is not a file");
    if (!configStat.isFile()) throw new Error("service config is not a file");
  }

  async validateDefinitions(definitions: readonly ServiceDefinition[]): Promise<void> {
    if (definitions.length === 0) throw new Error("no service definitions supplied");
    reconcileServiceOverrides(definitions);
    const labels = new Set<string>();
    const first = definitions[0];
    for (const definition of definitions) {
      if (labels.has(definition.label)) throw new Error("duplicate service definition");
      labels.add(definition.label);
      if (
        definition.nodePath !== first.nodePath ||
        definition.hiveHome !== first.hiveHome ||
        definition.configPath !== first.configPath ||
        definition.home !== first.home ||
        definition.pathEnv !== first.pathEnv
      ) {
        throw new Error("service pair selector mismatch");
      }
    }
    await Promise.all(definitions.map((definition) => this.#validateDefinition(definition)));
  }

  async #matchesDefinition(inspection: ServiceInspection, definition: ServiceDefinition): Promise<boolean> {
    if (!inspection.process || !inspection.args || inspection.cwd === null || !inspection.serviceEnvironment) {
      return false;
    }
    const expectedNode = await this.#io.realpath(definition.nodePath);
    const expectedCwd = await this.#io.realpath(definition.hiveHome);
    const expectedEnvironment = buildServiceEnvironment(definition);
    return (
      inspection.process.executable === expectedNode &&
      inspection.process.command === [definition.nodePath, definition.entrypoint, ...definition.args].join(" ") &&
      inspection.process.cwd === expectedCwd &&
      inspection.cwd === definition.hiveHome &&
      inspection.configSelection === definition.configPath &&
      Object.keys(inspection.serviceEnvironment).length === Object.keys(expectedEnvironment).length &&
      Object.entries(expectedEnvironment).every(([key, value]) => inspection.serviceEnvironment?.[key] === value) &&
      JSON.stringify(inspection.args) ===
        JSON.stringify([definition.nodePath, definition.entrypoint, ...definition.args])
    );
  }

  async bootstrap(definition: ServiceDefinition): Promise<ServiceInspection> {
    await this.validateDefinitions([definition]);
    const before = await this.inspect(definition.label);
    if (before.livePID !== null) {
      if (await this.#matchesDefinition(before, definition)) return before;
      throw new Error("loaded service does not match desired definition");
    }
    const domain = `gui/${this.#io.getuid()}`;
    if (!before.enabled) {
      await this.#io.execFile("launchctl", ["enable", `${domain}/${definition.label}`], { env: commandEnv });
    }
    await this.#io.execFile("launchctl", ["bootstrap", domain, this.#plistPath(definition.label)], {
      env: commandEnv,
    });
    const after = await this.inspect(definition.label);
    if (after.livePID === null || !(await this.#matchesDefinition(after, definition))) {
      throw new Error("service failed post-bootstrap identity verification");
    }
    return after;
  }

  async #sameProcess(identity: ProcessIdentity): Promise<boolean> {
    const current = await this.process(identity.pid);
    return (
      current !== null &&
      current.startTime === identity.startTime &&
      current.executable === identity.executable &&
      current.cwd === identity.cwd &&
      current.command === identity.command
    );
  }

  /**
   * Stop one service after quiescence. The stop condition is the captured
   * supervisor PID/start time exiting (and, for the worker, its recorded health
   * listener having no owner) plus the label unloading. No descendant census
   * is taken: a straggling SDK helper owns no instance listener and cannot
   * touch the verified clone (spec §5.1 step 3). Nothing is ever killed.
   */
  async bootout(definition: ServiceDefinition, options: BootoutOptions): Promise<void> {
    const component = componentForLabel(definition.label);
    const port = options.healthListenerPort;
    if (port !== undefined) assertPort(port);
    if (component === "engine" && port !== undefined) throw new Error("engine bootout has no worker health listener");
    const inspection = await this.inspect(definition.label);
    if (!inspection.loaded) return;
    const supervisor = inspection.process;
    if (component === "voice-worker" && port === undefined) {
      throw new Error("worker bootout requires its recorded health listener port");
    }
    await options.markIrreversible();
    const target = `gui/${this.#io.getuid()}/${definition.label}`;
    // No await may separate the fence from the dispatch below.
    options.beforeExec?.();
    await this.#io.execFile("launchctl", ["bootout", target], {
      env: commandEnv,
    });
    const deadline = this.#io.now() + this.#options.stopTimeoutMs;
    while (true) {
      const supervisorAlive = supervisor ? await this.#sameProcess(supervisor) : false;
      const owners = port === undefined ? [] : await this.listenerOwners(port);
      const foreign = owners.filter((pid) => !(supervisorAlive && supervisor && pid === supervisor.pid));
      if (foreign.length > 0) {
        // Recorded and reported only; an arbitrary port owner is never signaled.
        throw new Error(
          `unexpected health listener owner for ${definition.label} on port ${String(port)}: pid ${foreign.join(",")}`,
        );
      }
      const registration = await this.inspect(definition.label);
      if (!registration.loaded && !supervisorAlive && owners.length === 0) return;
      if (this.#io.now() >= deadline) {
        throw new Error(
          component === "voice-worker"
            ? `voice worker supervisor did not exit and release its health listener: ${definition.label}`
            : `service supervisor did not exit: ${definition.label}`,
        );
      }
      await this.#io.sleep(this.#options.pollIntervalMs);
    }
  }

  async #previousFile(path: string): Promise<PreviousFile> {
    try {
      const stat = await this.#io.lstat(path);
      if (!stat.isFile()) throw new Error("existing service plist is not a file");
      return { path, existed: true, bytes: await this.#io.readFile(path), mode: stat.mode & 0o777 };
    } catch (error) {
      if (!missingFile(error)) throw error;
      return { path, existed: false };
    }
  }

  async #capture(definition: ServiceDefinition): Promise<CapturedServiceDefinition> {
    const inspection = await this.inspect(definition.label);
    const instancePath = this.#plistPath(definition.label);
    const plistPath = inspection.plist?.path ?? instancePath;
    const linkPath = this.#linkPath(definition.label);
    const plist = await this.#previousFile(plistPath);
    const instancePlist = plistPath === instancePath ? plist : await this.#previousFile(instancePath);
    let link: PreviousLink = { path: linkPath, existed: false };
    try {
      const stat = await this.#io.lstat(linkPath);
      if (!stat.isSymbolicLink()) throw new Error("existing LaunchAgent owner is not a symlink");
      const target = await this.#io.readlink(linkPath);
      if (resolve(resolve(linkPath, ".."), target) !== plistPath) throw new Error("foreign LaunchAgent link target");
      link = { path: linkPath, existed: true, target };
    } catch (error) {
      if (!missingFile(error)) throw error;
    }
    return {
      definition,
      inspection,
      plist,
      instancePlist,
      link,
      loaded: inspection.loaded,
      enabled: inspection.enabled,
    };
  }

  /** Capture exact bytes/link/load state before any service or plist mutation. */
  async capture(definition: ServiceDefinition | readonly ServiceDefinition[]): Promise<ServiceSnapshot> {
    const definitions = Array.isArray(definition) ? definition : [definition];
    await this.validateDefinitions(definitions);
    const captured = await Promise.all(definitions.map((item) => this.#capture(item)));
    await this.#io.mkdir(this.#options.operationDir, { recursive: true, mode: 0o700 });
    await this.#io.chmod(this.#options.operationDir, 0o700);
    for (const prior of captured) {
      const privatePath = resolve(this.#options.operationDir, `${prior.definition.label}.plist.original`);
      if (prior.plist.existed) await this.#atomicWrite(privatePath, prior.plist.bytes!);
      if (prior.instancePlist.path !== prior.plist.path && prior.instancePlist.existed) {
        await this.#atomicWrite(
          resolve(this.#options.operationDir, `${prior.definition.label}.instance.plist.original`),
          prior.instancePlist.bytes!,
        );
      }
    }
    return { services: captured };
  }

  async #atomicWrite(path: string, bytes: string | Buffer): Promise<void> {
    const temporary = `${path}.tmp-${this.#io.randomId()}`;
    await this.#io.writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    await this.#io.chmod(temporary, 0o600);
    await this.#io.rename(temporary, path);
  }

  async #atomicLink(path: string, target: string): Promise<void> {
    const temporary = `${path}.tmp-${this.#io.randomId()}`;
    await this.#io.symlink(target, temporary);
    await this.#io.rename(temporary, path);
  }

  async write(definition: ServiceDefinition | readonly ServiceDefinition[]): Promise<ServiceSnapshot> {
    const definitions = Array.isArray(definition) ? definition : [definition];
    const snapshot = await this.capture(definitions);
    await this.#io.mkdir(resolve(this.#options.hiveHome, "service"), { recursive: true, mode: 0o700 });
    await this.#io.mkdir(resolve(this.#options.home, "Library", "LaunchAgents"), { recursive: true, mode: 0o700 });
    for (const item of definitions) {
      const plistPath = this.#plistPath(item.label);
      const temporary = `${plistPath}.tmp-${this.#io.randomId()}`;
      await this.#io.writeFile(temporary, buildServicePlist(item), { mode: 0o600, flag: "wx" });
      await this.#io.chmod(temporary, 0o600);
      await this.#io.execFile("plutil", ["-lint", temporary], { env: commandEnv });
      await this.#io.rename(temporary, plistPath);
      await this.#atomicLink(this.#linkPath(item.label), plistPath);
    }
    return snapshot;
  }

  async removeServiceLink(definition: ServiceDefinition): Promise<void> {
    componentForLabel(definition.label);
    const inspection = await this.inspect(definition.label);
    if (inspection.livePID !== null) throw new Error("cannot remove a live worker registration");
    const domain = `gui/${this.#io.getuid()}`;
    if (inspection.loaded) {
      await this.#io.execFile("launchctl", ["bootout", `${domain}/${definition.label}`], { env: commandEnv });
      const after = await this.inspect(definition.label);
      if (after.loaded) throw new Error("worker registration remained loaded");
    }
    if (inspection.enabled) {
      await this.#io.execFile("launchctl", ["disable", `${domain}/${definition.label}`], { env: commandEnv });
    }
    const linkPath = this.#linkPath(definition.label);
    try {
      const stat = await this.#io.lstat(linkPath);
      if (!stat.isSymbolicLink()) throw new Error("worker LaunchAgent owner is not a symlink");
      const target = await this.#io.readlink(linkPath);
      const resolvedTarget = resolve(resolve(linkPath, ".."), target);
      if (
        resolvedTarget !== this.#plistPath(definition.label) &&
        resolvedTarget !== this.#pilotPlists.get(definition.label)
      ) {
        throw new Error("foreign LaunchAgent link target");
      }
      await this.#io.unlink(linkPath);
    } catch (error) {
      if (!missingFile(error)) throw error;
    }
  }

  async removeWorkerLink(definition: ServiceDefinition): Promise<void> {
    if (componentForLabel(definition.label) !== "voice-worker") throw new Error("expected voice-worker definition");
    await this.removeServiceLink(definition);
  }

  async #restoreFile(prior: PreviousFile): Promise<void> {
    if (prior.existed) {
      await this.#atomicWrite(prior.path, prior.bytes!);
      await this.#io.chmod(prior.path, prior.mode ?? 0o600);
    } else {
      try {
        await this.#io.unlink(prior.path);
      } catch (error) {
        if (!missingFile(error)) throw error;
      }
    }
  }

  /**
   * Restore phase 1 (chunk 4 Task 8 Step 5a.3): with every captured label
   * unloaded, restore instance-owned plist bytes/modes (or captured absence),
   * verify any external effective original byte-for-byte without writing it,
   * restore the LaunchAgent link target and enablement. Nothing is bootstrapped.
   */
  async restoreFilesAndState(snapshot: ServiceSnapshot): Promise<void> {
    for (const prior of snapshot.services) {
      if ((await this.inspect(prior.definition.label)).loaded) {
        throw new Error(`service restore requires ${prior.definition.label} to be unloaded first`);
      }
    }
    for (const prior of snapshot.services) {
      if (prior.plist.path !== prior.instancePlist.path) {
        // External effective original: verify, never rewrite from backup.
        if (prior.plist.existed) {
          let current: Buffer;
          try {
            current = await this.#io.readFile(prior.plist.path);
          } catch (error) {
            throw new Error(`external service plist is missing: ${prior.definition.label}`, { cause: error });
          }
          if (!current.equals(prior.plist.bytes!)) {
            throw new Error(`external service plist changed since capture: ${prior.definition.label}`);
          }
        }
      }
      await this.#restoreFile(prior.instancePlist);
      if (prior.link.existed) await this.#atomicLink(prior.link.path, prior.link.target!);
      else {
        try {
          await this.#io.unlink(prior.link.path);
        } catch (error) {
          if (!missingFile(error)) throw error;
        }
      }
    }
    const domain = `gui/${this.#io.getuid()}`;
    for (const prior of snapshot.services) {
      const current = await this.inspect(prior.definition.label);
      if (current.enabled !== prior.enabled) {
        await this.#io.execFile(
          "launchctl",
          [prior.enabled ? "enable" : "disable", `${domain}/${prior.definition.label}`],
          { env: commandEnv },
        );
      }
    }
  }

  /**
   * Restore phase 2/3: bootstrap one captured service from its effective plist
   * (if it was loaded) and compare the live definition to the capture. The new
   * process must be a different generation from the captured one when the
   * caller requires it.
   */
  async restoreService(
    snapshot: ServiceSnapshot,
    label: string,
    options: { requireNewGeneration?: boolean } = {},
  ): Promise<ServiceInspection | null> {
    const prior = snapshot.services.find((candidate) => candidate.definition.label === label);
    if (!prior) throw new Error(`service ${label} is absent from the restore snapshot`);
    const current = await this.inspect(label);
    if (!prior.loaded) {
      if (current.loaded) throw new Error("service registration appeared during restore of an unloaded capture");
      return null;
    }
    if (current.loaded) throw new Error("unexpected service remains loaded during snapshot restore");
    const domain = `gui/${this.#io.getuid()}`;
    await this.#io.execFile("launchctl", ["bootstrap", domain, prior.plist.path], { env: commandEnv });
    const restored = await this.inspect(label);
    if (!this.#matchesCapturedService(restored, prior.inspection)) {
      throw new Error("restored service does not match captured definition");
    }
    if (
      options.requireNewGeneration &&
      prior.inspection.process !== null &&
      restored.process !== null &&
      restored.process.pid === prior.inspection.process.pid &&
      restored.process.startTime === prior.inspection.process.startTime
    ) {
      throw new Error("restored service did not start a new process generation");
    }
    return restored;
  }

  /**
   * Ordered restoration: files/links/enablement with services unloaded, then
   * engine, then the caller's engine check (fresh boot), then worker.
   */
  async restore(
    snapshot: ServiceSnapshot,
    hooks: { afterEngine?: (engine: ServiceInspection | null) => Promise<void> } = {},
  ): Promise<void> {
    await this.restoreFilesAndState(snapshot);
    const engine = snapshot.services.find((prior) => componentForLabel(prior.definition.label) === "engine");
    const worker = snapshot.services.find((prior) => componentForLabel(prior.definition.label) === "voice-worker");
    const started = engine ? await this.restoreService(snapshot, engine.definition.label) : null;
    await hooks.afterEngine?.(started);
    if (worker) await this.restoreService(snapshot, worker.definition.label);
  }

  #matchesCapturedService(current: ServiceInspection, captured: ServiceInspection): boolean {
    if (!current.loaded || !captured.loaded) return false;
    if (captured.process === null) return current.process === null;
    return (
      current.process !== null &&
      current.process.executable === captured.process.executable &&
      current.process.command === captured.process.command &&
      current.process.cwd === captured.process.cwd &&
      JSON.stringify(current.args) === JSON.stringify(captured.args) &&
      current.cwd === captured.cwd &&
      current.configSelection === captured.configSelection &&
      JSON.stringify(current.serviceEnvironment) === JSON.stringify(captured.serviceEnvironment)
    );
  }
}
