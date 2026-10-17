// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeProcess from "node:process";
import * as NodeUtil from "node:util";
import * as NodePerfHooks from "node:perf_hooks";
import { createUpstreamStorageCopy } from "../packages/shared/src/upstreamStorageCopy.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    source: { type: "string" },
    destination: { type: "string" },
    "immutable-snapshot": { type: "boolean", default: false },
  },
});
if (!values.source || !values.destination) {
  throw new Error(
    "Usage: node scripts/create-upstream-storage-copy.ts --source <database> --destination <new-directory> [--immutable-snapshot]",
  );
}
let lastProgress = 0;
const report = await createUpstreamStorageCopy({
  source: values.source,
  destinationDirectory: values.destination,
  immutableSnapshot: values["immutable-snapshot"],
  progress: async (stage, rows) => {
    if (NodePerfHooks.performance.now() - lastProgress < 3000) return;
    lastProgress = NodePerfHooks.performance.now();
    NodeProcess.stdout.write(JSON.stringify({ stage, rows }) + "\n");
  },
});
NodeProcess.stdout.write(
  JSON.stringify({
    status: report.status,
    output: report.output,
    schemaUnchanged: report.schemaUnchanged,
    ledgerUnchanged: report.ledgerUnchanged,
    payloadsExpanded: report.payloadsExpanded,
    promptsExpanded: report.promptsExpanded,
    integrity: report.integrity,
  }) + "\n",
);
