// @effect-diagnostics nodeBuiltinImport:off - verify exact source SHA-256 in the Node-only merge checker.
import * as NodeCrypto from "node:crypto";

export interface MigrationIdentity {
  readonly upstreamId: number;
  readonly forkId: number;
  readonly name: string;
}
export interface MigrationPatch {
  readonly upstreamPath: string;
  readonly localPath: string;
  readonly upstreamSha256: string;
  readonly forkSha256: string;
  readonly reason: string;
}
export interface MigrationSource {
  readonly upstreamPath: string;
  readonly localPath: string;
  readonly upstream: string;
  readonly local: string;
}

const normalize = (text: string) => text.replaceAll("\r\n", "\n");
const digest = (text: string) =>
  NodeCrypto.createHash("sha256").update(normalize(text)).digest("hex");

/** Read identities and source paths without executing a migration module. */
export function readMigrationManifest(
  text: string,
  registry: "migrationEntries" | "upstreamMigrationEntries" | "forkMigrationEntries",
  idCount: 1 | 2 = 1,
): ReadonlyArray<readonly [id: number, deployedId: number, name: string, source: string]> {
  const content = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, "");
  const body = new RegExp(String.raw`const ${registry}\s*=\s*\[([\s\S]*?)\]\s+as\s+const\s*;`).exec(
    content,
  )?.[1];
  if (body === undefined) throw new Error(`Unsupported migration registry: ${registry}.`);
  const imports = new Map(
    [...content.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s+(["'])([^"'\r\n]+)\2\s*;/g)].map(
      (match) => [match[1]!, match[3]!],
    ),
  );
  const identity = String.raw`(\d+)\s*,\s*`;
  const entry = new RegExp(
    String.raw`\[\s*${identity.repeat(idCount)}(?<quote>["'])(?<name>[^"'\\\r\n]+)\k<quote>\s*,\s*(?<binding>[A-Za-z_$][\w$]*)\s*,?\s*\]`,
    "g",
  );
  const matches = [...body.matchAll(entry)];
  if (matches.length === 0 || body.replace(entry, "").replace(/[\s,]/g, "") !== "")
    throw new Error(`Unsupported entries in migration registry: ${registry}. Review its format.`);
  return matches.map((match) => {
    const id = Number(match[1]);
    const deployedId = Number(match[idCount]);
    const source = imports.get(match.groups!.binding!);
    if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(deployedId) || deployedId < 1)
      throw new Error(`Invalid migration identity in ${registry}.`);
    if (source === undefined)
      throw new Error(`Migration ${id} in ${registry} has no static default import.`);
    return [id, deployedId, match.groups!.name!, source] as const;
  });
}

/** Verify migration identity and reviewed source divergence without running SQL. */
export function auditUpstreamDatabase(input: {
  readonly upstream: ReadonlyArray<readonly [number, string]>;
  readonly registered: ReadonlyArray<MigrationIdentity>;
  readonly deployed: ReadonlyArray<readonly [number, string]>;
  readonly historical: ReadonlyArray<readonly [number, string]>;
  readonly sources: ReadonlyArray<MigrationSource>;
  readonly patches: ReadonlyArray<MigrationPatch>;
}): ReadonlyArray<string> {
  const issues: string[] = [];
  const registered = new Map(input.registered.map((m) => [m.upstreamId, m]));
  for (const [id, name] of input.upstream) {
    if (registered.get(id)?.name !== name)
      issues.push(`Upstream migration ${id}_${name} has no matching registry entry.`);
  }
  if (
    input.registered.length !== input.upstream.length ||
    registered.size !== input.registered.length
  )
    issues.push("Upstream registry has missing, duplicate, or stale identities.");
  const deployed = new Map(input.deployed);
  if (
    deployed.size !== input.deployed.length ||
    new Set(input.deployed.map(([, name]) => name)).size !== input.deployed.length
  )
    issues.push("Fork migration IDs and names must be unique.");
  for (const [id, name] of input.historical) {
    if (deployed.get(id) !== name)
      issues.push(`Published migration ${id}_${name} was removed or renamed.`);
  }
  for (const entry of input.registered) {
    if (deployed.get(entry.forkId) !== entry.name)
      issues.push(
        `Upstream ${entry.upstreamId}_${entry.name} maps to the wrong fork identity ${entry.forkId}.`,
      );
  }
  const used = new Set<MigrationPatch>();
  for (const source of input.sources) {
    if (normalize(source.upstream) === normalize(source.local)) continue;
    const patch = input.patches.find(
      (p) => p.upstreamPath === source.upstreamPath && p.localPath === source.localPath,
    );
    if (
      patch === undefined ||
      patch.upstreamSha256 !== digest(source.upstream) ||
      patch.forkSha256 !== digest(source.local) ||
      patch.reason.trim().length === 0
    ) {
      issues.push(
        `Unreviewed migration difference: ${source.upstreamPath} -> ${source.localPath}.`,
      );
    } else used.add(patch);
  }
  for (const patch of input.patches) {
    if (!used.has(patch))
      issues.push(`Stale or changed migration patch declaration: ${patch.upstreamPath}.`);
  }
  return issues;
}
