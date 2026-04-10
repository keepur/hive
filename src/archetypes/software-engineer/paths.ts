import { normalize, resolve } from "node:path";
import { claudeProjectSlug } from "../slug.js";
import type { SoftwareEngineerConfig, Workspace } from "./config.js";

/**
 * All helpers are pure functions — no module-level state, no caches.
 * Concurrent sessions share the archetype but each call is self-contained.
 */

/** True if `filePath` resolves to a location at or under the workshop root. */
export function isInsideWorkshop(filePath: string, cfg: SoftwareEngineerConfig): boolean {
  const norm = normalize(resolve(filePath));
  const ws = normalize(resolve(cfg.workshop));
  return norm === ws || norm.startsWith(ws + "/");
}

/** Find the workspace that contains `filePath`, or undefined if none. */
export function findWorkspace(filePath: string, cfg: SoftwareEngineerConfig): Workspace | undefined {
  const norm = normalize(resolve(filePath));
  return cfg.workspaces.find((w) => {
    const wp = normalize(resolve(w.path));
    return norm === wp || norm.startsWith(wp + "/");
  });
}

/** Claude Code project slug for the workshop directory. */
export function workshopSlug(cfg: SoftwareEngineerConfig): string {
  return claudeProjectSlug(cfg.workshop);
}

/** Claude Code project slug for a workspace directory. */
export function workspaceSlug(ws: Workspace): string {
  return claudeProjectSlug(ws.path);
}
