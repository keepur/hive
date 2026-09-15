import { execFile as nodeExecFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { promisify } from "node:util";

const execFile = promisify(nodeExecFile);

/**
 * Resolve host npm from an explicit PATH to a real `…/bin/npm-cli.js`.
 * Shared by bootstrap and lifecycle staging so the two paths cannot drift.
 */
export async function resolveHostNpmCli(pathEnv: string): Promise<string> {
  if (!pathEnv) throw new Error("explicit PATH is required to resolve npm");
  const found = (
    await execFile("/usr/bin/which", ["npm"], {
      encoding: "utf8",
      env: { PATH: pathEnv },
      maxBuffer: 64 * 1024,
    })
  ).stdout.trim();
  const npmCli = await realpath(found);
  const info = await lstat(npmCli);
  if (!info.isFile() || info.isSymbolicLink() || !npmCli.endsWith("/bin/npm-cli.js")) {
    throw new Error("host npm prerequisite must resolve to its real npm-cli.js");
  }
  return npmCli;
}
