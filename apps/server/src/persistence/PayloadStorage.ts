// @effect-diagnostics nodeBuiltinImport:off
import * as Effect from "effect/Effect";
import type { SqlClient } from "effect/sql/SqlClient";
import {
  compressText,
  expandBlob,
  payloadReference,
  PAYLOAD_INLINE_BYTES,
  MAX_PAYLOAD_BYTES,
} from "@t3tools/shared/forkStorageCodec";

/** Called inside the surrounding event transaction; an interrupted append leaves no dangling reference. */
export const storePayload = (sql: SqlClient, json: string) =>
  Effect.gen(function* () {
    const bytes = Buffer.byteLength(json);
    if (bytes < PAYLOAD_INLINE_BYTES || bytes > MAX_PAYLOAD_BYTES) return json;
    const blob = yield* Effect.try(() => compressText(json));
    // Keep incompressible bodies inline rather than growing the database with a second index entry.
    if (blob.compressed.length + 160 >= blob.rawBytes) return json;
    const inserted = yield* sql<{
      digest: string;
    }>`INSERT INTO arcwright_payload_blobs(digest, raw_bytes, compressed)
      VALUES (${blob.digest}, ${blob.rawBytes}, ${blob.compressed}) ON CONFLICT(digest) DO NOTHING RETURNING digest`;
    if (inserted.length === 0) {
      const existing = yield* sql<{
        raw_bytes: number;
        compressed: Uint8Array;
      }>`SELECT raw_bytes,compressed
        FROM arcwright_payload_blobs WHERE digest=${blob.digest}`;
      const stored = existing[0];
      yield* Effect.try(() => {
        if (
          stored === undefined ||
          expandBlob({
            digest: blob.digest,
            rawBytes: stored.raw_bytes,
            compressed: stored.compressed,
          }) !== json
        )
          throw new Error("Existing payload failed its integrity check; append refused.");
      });
    }
    return payloadReference(blob);
  });
