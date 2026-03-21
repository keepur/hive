// MongoDB migration: hive → hive_dodi
// Run with Hive STOPPED: mongosh < setup/migrate-hive-db.js

const cols = [
  "memory", "memory_versions", "agent_sessions", "model_overrides",
  "agent_config_overrides", "devices", "agent_callbacks", "contacts",
  "prompt_overrides", "schedule_overrides"
];

print("=== Migrating hive → hive_dodi ===\n");

// Check source
const srcDb = db.getSiblingDB("hive");
const srcCols = srcDb.getCollectionNames();
print("Source collections: " + srcCols.join(", "));
print("");

for (const c of cols) {
  if (!srcCols.includes(c)) {
    print("SKIP " + c + " (not found in hive)");
    continue;
  }
  const count = srcDb.getCollection(c).countDocuments();
  print("RENAME hive." + c + " → hive_dodi." + c + " (" + count + " docs)");
  db.adminCommand({ renameCollection: "hive." + c, to: "hive_dodi." + c });
}

print("\n=== Verification ===");
const dstDb = db.getSiblingDB("hive_dodi");
for (const c of cols) {
  const count = dstDb.getCollection(c).countDocuments();
  print("hive_dodi." + c + ": " + count + " docs");
}

print("\n=== Checking source is empty ===");
const remaining = srcDb.getCollectionNames();
if (remaining.length === 0) {
  print("hive database is empty. Safe to drop.");
  // Uncomment to drop: srcDb.dropDatabase();
} else {
  print("WARNING: hive still has collections: " + remaining.join(", "));
}

print("\nDone.");
