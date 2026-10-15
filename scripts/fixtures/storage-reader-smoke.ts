// @effect-diagnostics nodeBuiltinImport:off - isolated artifact-level worker fixture.
import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqliteClient from "../../packages/shared/src/nodeSqliteClient.ts";
import {
  compressText,
  compressHistoryBlock,
  digestBytes,
  historyBlockReference,
  historyBlockSchema,
  payloadReference,
  storageSchema,
} from "../../packages/shared/src/forkStorageCodec.ts";
const encodePayload = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ text: Schema.String })),
);

await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "arcwright-bundled-reader-" });
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      for (const ddl of storageSchema) yield* sql.unsafe(ddl);
      yield* sql.unsafe(historyBlockSchema);
      const text = yield* encodePayload({ text: "Shared history 🦊".repeat(800) });
      const blob = compressText(text);
      yield* sql`INSERT INTO arcwright_payload_blobs VALUES (${blob.digest}, ${blob.rawBytes}, ${blob.compressed})`;
      const bytes = Buffer.from(text);
      const framed = Buffer.alloc(4 + bytes.length);
      framed.writeUInt32BE(bytes.length);
      bytes.copy(framed, 4);
      const block = compressHistoryBlock(framed);
      yield* sql`INSERT INTO arcwright_history_blocks VALUES (${block.digest}, ${block.rawBytes}, ${block.compressed})`;
      const ref = historyBlockReference(block.digest, 0);
      const query = sql`SELECT arcwright_payload_json(${payloadReference(blob)}) AS payload,
      arcwright_payload_bytes(${payloadReference(blob)}) AS bytes,
      arcwright_history_json(${blob.digest}, ${blob.rawBytes}, ${blob.compressed}) AS gzip,
      arcwright_history_json(${digestBytes(bytes)}, ${bytes.length}, ${ref}) AS block`;
      const expected = [{ payload: text, bytes: bytes.length, gzip: text, block: text }];
      NodeAssert.deepEqual(
        (yield* query).map((row) => ({ ...row })),
        expected,
      );
      NodeAssert.deepEqual(
        (yield* query.pipe(SqliteClient.readOnly)).map((row) => ({ ...row })),
        expected,
      );
      const corrupt = Buffer.from(block.compressed);
      corrupt[0] = corrupt[0]! ^ 255;
      yield* sql`UPDATE arcwright_history_blocks SET compressed=${corrupt} WHERE digest=${block.digest}`;
      const failed =
        yield* sql`SELECT arcwright_history_json(${digestBytes(bytes)}, ${bytes.length}, ${ref})`.pipe(
          SqliteClient.readOnly,
          Effect.flip,
        );
      NodeAssert.equal(failed._tag, "SqlError");
    }).pipe(
      Effect.provide(
        SqliteClient.layer({ filename: path.join(directory, "state.sqlite"), readerWorker: true }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
await Effect.runPromise(
  Console.log("Bundled SQLite reader: gzip, Brotli, byte counts and corruption checks passed."),
);
