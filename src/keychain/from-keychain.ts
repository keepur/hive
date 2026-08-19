import { execFileSync } from "node:child_process";
import { createLogger } from "../logging/logger.js";

const log = createLogger("from-keychain");

/** macOS `security` exit code for "the specified item could not be found in the keychain". */
const SECURITY_ITEM_NOT_FOUND = 44;

/**
 * Process-lifetime last-known-good cache, keyed by full service name.
 * Serves values across transient `security` failures (locked keychain,
 * UI-session unavailability under launchd) so per-spawn secret resolution
 * doesn't silently hand servers an empty env var mid-outage (KPR-373).
 * A definitive item-not-found clears the entry — operator removal via
 * `hive credentials remove` must not be papered over by the cache.
 */
const lastKnownGood = new Map<string, string>();

/** Test seam — reset cached values between test cases. */
export function clearKeychainCacheForTests(): void {
  lastKnownGood.clear();
}

/**
 * Read a credential from macOS Keychain under the Honeypot namespace
 * (`hive/<instanceId>/<key>`). Returns "" on non-darwin or when the entry
 * genuinely does not exist — matches the lenient semantics of `config.ts`'s
 * `optional()`. Unexpected `security` failures (locked keychain, missing
 * binary, permission denied) are logged at warn level and fall back to the
 * last value this process successfully read, if any.
 */
export function fromKeychain(instanceId: string, key: string): string {
  if (process.platform !== "darwin") return "";
  const service = `hive/${instanceId}/${key}`;
  try {
    const value = execFileSync("security", ["find-generic-password", "-s", service, "-w"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (value) lastKnownGood.set(service, value);
    return value;
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    if (status === SECURITY_ITEM_NOT_FOUND) {
      lastKnownGood.delete(service);
      return "";
    }
    const cached = lastKnownGood.get(service);
    log.warn(
      cached
        ? "Keychain read failed — serving last-known-good value"
        : "Keychain read failed — no cached value to fall back to",
      {
        service,
        status: status ?? null,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return cached ?? "";
  }
}
