import { FsMemoryStore } from "./fs-memory-store.js";

export interface ScopeDecl {
  id: string; // "self" | "workshop" | "workspace:<name>" | archetype-defined
  backing: "mongo" | "filesystem";
  dir?: string; // absolute, required when backing === "filesystem"
}

export type ScopeList = ScopeDecl[];

/**
 * Parse MEMORY_SCOPES_JSON env var into a validated scope list.
 * Returns [] if unset. Throws on malformed JSON or missing `dir` on filesystem scopes.
 */
export function parseScopesEnv(json: string | undefined): ScopeList {
  if (!json) return [];
  const raw: unknown = JSON.parse(json);
  if (!Array.isArray(raw)) throw new Error("MEMORY_SCOPES_JSON must be an array");
  return raw.map((s, i): ScopeDecl => {
    if (!s || typeof s !== "object") {
      throw new Error(`scope[${i}]: must be an object`);
    }
    const rec = s as Record<string, unknown>;
    if (typeof rec.id !== "string") throw new Error(`scope[${i}]: missing id`);
    if (rec.backing !== "mongo" && rec.backing !== "filesystem") {
      throw new Error(`scope[${i}]: backing must be "mongo" or "filesystem"`);
    }
    if (rec.backing === "filesystem") {
      if (typeof rec.dir !== "string" || !rec.dir.startsWith("/")) {
        throw new Error(`scope[${i}]: filesystem scope requires absolute dir`);
      }
    }
    return {
      id: rec.id,
      backing: rec.backing,
      dir: typeof rec.dir === "string" ? rec.dir : undefined,
    };
  });
}

export class ScopeRouter {
  private readonly stores = new Map<string, FsMemoryStore>();
  constructor(private readonly scopes: ScopeList) {
    for (const s of scopes) {
      if (s.backing === "filesystem" && s.dir) {
        this.stores.set(s.id, new FsMemoryStore(s.dir));
      }
    }
  }

  scopeIds(): string[] {
    return this.scopes.map((s) => s.id);
  }

  get(id: string): ScopeDecl | undefined {
    return this.scopes.find((s) => s.id === id);
  }

  fsStore(id: string): FsMemoryStore | undefined {
    return this.stores.get(id);
  }

  /** Throws a friendly error with the valid scope list if the id is unknown. */
  requireFs(id: string): FsMemoryStore {
    const store = this.stores.get(id);
    if (!store) {
      throw new Error(
        `Unknown filesystem memory scope: ${id}. Valid scopes: ${this.scopeIds().join(", ") || "(none)"}`,
      );
    }
    return store;
  }
}
