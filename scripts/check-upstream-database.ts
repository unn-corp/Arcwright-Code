// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeProcess from "node:process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import historical from "../apps/server/src/persistence/historical-migration-identities.json" with { type: "json" };
import patches from "./upstream-database-patches.json" with { type: "json" };
import { auditUpstreamDatabase, type MigrationSource } from "./upstreamDatabaseAudit.ts";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const pin: unknown = JSON.parse(
  NodeFS.readFileSync(NodePath.join(root, "fork-upstream.json"), "utf8"),
);
if (
  pin === null ||
  typeof pin !== "object" ||
  !("upstreamCommit" in pin) ||
  typeof pin.upstreamCommit !== "string" ||
  !/^[a-f0-9]{40}$/.test(pin.upstreamCommit)
)
  throw new Error("fork-upstream.json must contain a pinned full upstream commit.");
const ref = pin.upstreamCommit;
const prefix = "apps/server/src/persistence/";
const git = (...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
const readUpstream = (filename: string) => git("show", `${ref}:${filename}`);
const manifest = readUpstream(prefix + "Migrations.ts");
const imports = (text: string) =>
  new Map([...text.matchAll(/import (Migration\d+) from "([^"]+)";/g)].map((m) => [m[1]!, m[2]!]));
const upstreamImports = imports(manifest);
const localText = NodeFS.readFileSync(NodePath.join(root, prefix, "UpstreamMigrations.ts"), "utf8");
const localImports = imports(localText);
const registered = [...localText.matchAll(/\[(\d+),\s*(\d+),\s*"([^"]+)",\s*(Migration\d+)\]/g)];
const localPaths = new Map(registered.map((m) => [m[3]!, localImports.get(m[4]!)!]));
const forkText = NodeFS.readFileSync(NodePath.join(root, prefix, "ForkMigrations.ts"), "utf8");
const deployed = [
  ...registered.map((m) => [Number(m[2]), m[3]!] as const),
  ...[...forkText.matchAll(/\[(\d+),\s*"([^"]+)",\s*Migration\d+\]/g)].map(
    (m) => [Number(m[1]), m[2]!] as const,
  ),
];
const upstream = [...manifest.matchAll(/\[(\d+),\s*"([^"]+)",\s*(Migration\d+)\]/g)];
if (upstream.length === 0)
  throw new Error("Could not read the pinned upstream migration manifest; review its format.");
const sources: MigrationSource[] = [];
for (const match of upstream) {
  const upstreamPath = NodePath.posix.join(prefix, upstreamImports.get(match[3]!)!);
  const local = localPaths.get(match[2]!);
  if (local === undefined) continue;
  const localPath = NodePath.posix.join(prefix, local);
  sources.push({
    upstreamPath,
    localPath,
    upstream: readUpstream(upstreamPath),
    local: NodeFS.readFileSync(NodePath.join(root, localPath), "utf8"),
  });
}
for (const filename of git(
  "ls-tree",
  "-r",
  "--name-only",
  ref,
  "--",
  prefix + "Migrations/OrchestrationV2",
)
  .trim()
  .split("\n")) {
  if (!filename.endsWith(".ts") || filename.includes(".test.")) continue;
  sources.push({
    upstreamPath: filename,
    localPath: filename,
    upstream: readUpstream(filename),
    local: NodeFS.readFileSync(NodePath.join(root, filename), "utf8"),
  });
}
const historicalEntries: Array<readonly [number, string]> = historical.map((row) => {
  if (row.length !== 2 || typeof row[0] !== "number" || typeof row[1] !== "string")
    throw new Error("Invalid published migration identity snapshot.");
  return [row[0], row[1]];
});
const issues = auditUpstreamDatabase({
  upstream: upstream.map((m) => [Number(m[1]), m[2]!] as const),
  registered: registered.map((m) => ({
    upstreamId: Number(m[1]),
    forkId: Number(m[2]),
    name: m[3]!,
  })),
  deployed,
  historical: historicalEntries,
  sources,
  patches: patches.patches,
});
if (issues.length)
  throw new Error(
    "Upstream database audit failed:\n" + issues.map((issue) => "- " + issue).join("\n"),
  );
NodeProcess.stdout.write(
  `Verified ${upstream.length} upstream migrations, ${historical.length} published fork identities, ${sources.length} migration sources, and ${patches.patches.length} reviewed patch.\n`,
);
