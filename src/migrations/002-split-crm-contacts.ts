import type { Db } from "mongodb";
import type { createLogger } from "../logging/logger.js";

export const migration002SplitCrmContacts = {
  id: "002-split-crm-contacts",
  async run(db: Db, log: ReturnType<typeof createLogger>): Promise<void> {
    const contacts = db.collection("contacts");
    const crmContacts = db.collection("crm_contacts");

    // Create indexes on crm_contacts (idempotent)
    await crmContacts.createIndex(
      { email: 1 },
      { unique: true, partialFilterExpression: { email: { $type: "string" } } },
    );
    await crmContacts.createIndex({ "phones.number": 1 });
    await crmContacts.createIndex({ name: "text", email: "text", company: "text" });
    await crmContacts.createIndex({ tags: 1 });
    await crmContacts.createIndex({ updatedAt: 1 });
    await crmContacts.createIndex({ source: 1 });
    await crmContacts.createIndex({ sourceId: 1 }, { sparse: true });

    const cursor = contacts.find({ source: "hubspot" });
    let moved = 0;
    let skipped = 0;

    for await (const doc of cursor) {
      try {
        await crmContacts.replaceOne({ _id: doc._id }, doc, { upsert: true });
        await contacts.deleteOne({ _id: doc._id });
        moved++;
      } catch (err) {
        log.warn("Failed to move contact record", { id: doc._id, err });
        skipped++;
      }
    }

    log.info("Migration complete", {
      migration: "002-split-crm-contacts",
      moved,
      skipped,
    });
  },
};
