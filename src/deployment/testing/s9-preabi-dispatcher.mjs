/**
 * Pre-ABI public dispatcher preserved from 19272158 (before hive-pilot-probe/1).
 * Unknown modes fail closed; this is not a production entrypoint.
 */
const mode = process.argv[2];
if (mode === "pilot-abi" || mode === "pilot-abi-v1" || mode === "pilot" || mode === "pilot-inventory") {
  process.stderr.write("PILOT_PROBE_ABI_UNSUPPORTED\n");
  process.exit(2);
}
if (mode === "config" || mode === "bridge" || mode === "worker") {
  process.stdout.write(`${JSON.stringify({ ok: true, classification: "pre-abi-dispatcher", mode })}\n`);
  process.exit(0);
}
process.stderr.write(`unknown mode: ${mode ?? ""}\n`);
process.exit(2);
