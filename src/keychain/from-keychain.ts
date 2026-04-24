import { execFileSync } from "node:child_process";

/**
 * Read a credential from macOS Keychain under the Honeypot namespace
 * (`hive/<instanceId>/<key>`). Returns "" on non-darwin, on missing entry,
 * or on any other `security` failure — matches the lenient semantics of
 * `config.ts`'s `optional()`.
 */
export function fromKeychain(instanceId: string, key: string): string {
  if (process.platform !== "darwin") return "";
  try {
    return execFileSync(
      "security",
      ["find-generic-password", "-s", `hive/${instanceId}/${key}`, "-w"],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
  } catch {
    return "";
  }
}
