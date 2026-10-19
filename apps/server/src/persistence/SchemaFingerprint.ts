// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import schemaFingerprint from "./schema-fingerprint.json" with { type: "json" };

export interface SchemaObject {
  readonly type: string;
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string;
}

export class SchemaFingerprintError extends Schema.TaggedError<SchemaFingerprintError>()(
  "SchemaFingerprintError",
  { reason: Schema.String },
) {}

const digest = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const migrationManifestDigest = (manifest: ReadonlyArray<readonly [number, string]>) =>
  digest([manifest, schemaFingerprint.format, schemaFingerprint.schemaSha256]);
export const expectedSchemaObjects: ReadonlyArray<SchemaObject> = schemaFingerprint.objects;

/** Tokenize quoted values separately: whitespace/case in SQL literals must remain significant. */
function tokens(sql: string): string[] {
  return (
    sql.match(
      /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_][A-Za-z0-9_$]*|\d+(?:\.\d+)?|[^\s]/g,
    ) ?? []
  ).map((token) => {
    if (token.startsWith("'")) return token;
    if (token.startsWith('"') || token.startsWith("`"))
      return (
        "id:" +
        token
          .slice(1, -1)
          .replaceAll(token[0]! + token[0]!, token[0]!)
          .toLowerCase()
      );
    if (token.startsWith("[")) return "id:" + token.slice(1, -1).toLowerCase();
    if (/^[A-Za-z_]/.test(token)) return "id:" + token.toLowerCase();
    return token.toLowerCase();
  });
}

/** Older releases added some columns in a different order. Names, types and constraints must match; physical column order need not. */
export function canonicalSchemaDefinition(object: SchemaObject): string {
  const list = tokens(object.sql);
  if (object.type !== "table") return JSON.stringify(list);
  const open = list.indexOf("(");
  if (open < 0) return JSON.stringify(list);
  let depth = 0,
    close = open;
  const columns: string[][] = [];
  let column: string[] = [];
  for (let i = open + 1; i < list.length; i++) {
    const token = list[i]!;
    if (token === ")" && depth === 0) {
      close = i;
      columns.push(column);
      break;
    }
    if (token === "," && depth === 0) {
      columns.push(column);
      column = [];
      continue;
    }
    if (token === "(") depth++;
    if (token === ")") depth--;
    column.push(token);
  }
  return JSON.stringify([
    list.slice(0, open),
    columns.map((value) => JSON.stringify(value)).sort(),
    list.slice(close + 1),
  ]);
}

export const readSchemaObjects = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // These three unused indexes are removed by the one-time worker, not by normal startup.
  return yield* sql<SchemaObject>`SELECT type,name,tbl_name,sql FROM sqlite_master
    WHERE name NOT GLOB 'sqlite_*' AND sql IS NOT NULL
      AND name NOT IN ('idx_orch_events_correlation_id','idx_orch_command_receipts_aggregate','idx_orch_command_receipts_sequence')
    ORDER BY type,name`;
});

export const schemaDigest = (objects: ReadonlyArray<SchemaObject>) =>
  digest(
    objects.map((object) => [
      object.type,
      object.name,
      object.tbl_name,
      canonicalSchemaDefinition(object),
    ]),
  );
const readLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    migration_id: number;
    name: string;
  }>`SELECT migration_id,name FROM effect_sql_migrations ORDER BY migration_id`;
});

/** Three tiny metadata reads. No user rows, file bytes, VACUUM or migration write transaction is needed on a match. */
export const hasCurrentSchemaFingerprint = (manifest: ReadonlyArray<readonly [number, string]>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const objects = yield* readSchemaObjects;
    if (
      !objects.some((object) => object.name === "arcwright_schema_fingerprint") ||
      !objects.some((object) => object.name === "effect_sql_migrations")
    )
      return false;
    const saved = (yield* sql<{
      manifest_sha256: string;
      schema_sha256: string;
      ledger_sha256: string;
    }>`SELECT manifest_sha256,schema_sha256,ledger_sha256 FROM arcwright_schema_fingerprint WHERE id=1`)[0];
    if (saved?.manifest_sha256 !== migrationManifestDigest(manifest)) return false;
    const ledger = yield* readLedger;
    return saved.schema_sha256 === schemaDigest(objects) && saved.ledger_sha256 === digest(ledger);
  });

/** Stamp only a verified schema after the normal migration path. Extra legacy objects are retained and covered by the SHA. */
export const recordSchemaFingerprint = (
  manifest: ReadonlyArray<readonly [number, string]>,
  expected: ReadonlyArray<SchemaObject>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const objects = yield* readSchemaObjects;
    const actual = new Map(
      objects.map((object) => [`${object.type}:${object.name}`, canonicalSchemaDefinition(object)]),
    );
    const incorrect = expected.filter(
      (object) => actual.get(`${object.type}:${object.name}`) !== canonicalSchemaDefinition(object),
    );
    if (incorrect.length > 0)
      return yield* Effect.fail(
        new SchemaFingerprintError({
          reason: `Database schema differs from this build: ${incorrect.map((object) => object.name).join(", ")}. No completed schema fingerprint was recorded.`,
        }),
      );
    const ledger = yield* readLedger;
    // A schema SHA does not prove data migrations ran. Require the exact migration ledger too.
    if (
      ledger.length !== manifest.length ||
      ledger.some(
        (row, index) =>
          row.migration_id !== manifest[index]?.[0] || row.name !== manifest[index]?.[1],
      )
    )
      return;
    yield* sql`INSERT INTO arcwright_schema_fingerprint(id,manifest_sha256,schema_sha256,ledger_sha256)
    VALUES(1,${migrationManifestDigest(manifest)},${schemaDigest(objects)},${digest(ledger)})
    ON CONFLICT(id) DO UPDATE SET manifest_sha256=excluded.manifest_sha256,schema_sha256=excluded.schema_sha256,ledger_sha256=excluded.ledger_sha256`;
  });
