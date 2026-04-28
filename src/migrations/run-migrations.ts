import type { Db } from "mongodb";
import { createLogger } from "../logging/logger.js";
import { migration001BackfillHomeBase } from "./001-backfill-home-base.js";

const log = createLogger("migrations");

export interface Migration {
  id: string;
  run(db: Db, log: ReturnType<typeof createLogger>): Promise<void>;
}

interface MigrationRecord {
  _id: string;
  ranAt: Date;
  notes?: string;
}

export const MIGRATIONS: Migration[] = [migration001BackfillHomeBase];

export async function runMigrations(db: Db, registry: Migration[] = MIGRATIONS): Promise<void> {
  const coll = db.collection<MigrationRecord>("migrations");
  for (const migration of registry) {
    const existing = await coll.findOne({ _id: migration.id });
    if (existing) {
      log.debug("Migration already applied, skipping", { id: migration.id });
      continue;
    }
    log.info("Running migration", { id: migration.id });
    await migration.run(db, log);
    await coll.insertOne({ _id: migration.id, ranAt: new Date() });
    log.info("Migration applied", { id: migration.id });
  }
}
