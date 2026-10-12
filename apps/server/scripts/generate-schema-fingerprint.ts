// @effect-diagnostics nodeBuiltinImport:off - generates a source-owned schema contract, without user data.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { migrationEntries } from "../src/persistence/Migrations.ts";
import { readSchemaObjects, schemaDigest } from "../src/persistence/SchemaFingerprint.ts";

const objects = await Effect.runPromise(
  Effect.gen(function* () {
    yield* Migrator.make({})({
      loader: Migrator.fromRecord(
        Object.fromEntries(
          migrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
        ),
      ),
    });
    return yield* readSchemaObjects;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
const filename = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../src/persistence/schema-fingerprint.json",
);
await NodeFSP.writeFile(
  filename,
  JSON.stringify({ format: 1, schemaSha256: schemaDigest(objects), objects }, null, 2) + "\n",
);
