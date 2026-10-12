/** Public reminders only: never credentials, mint keys, or background retry work. */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";

const PendingCleanupReference = Schema.Struct({
  relayOrigin: Schema.String,
  environmentId: Schema.String,
  unlinkedAt: Schema.String,
  status: Schema.Literal("pending"),
});
const PendingCleanupJson = Schema.fromJsonString(Schema.Array(PendingCleanupReference));
const decode = Schema.decodeUnknownEffect(PendingCleanupJson);
const encode = Schema.encodeEffect(PendingCleanupJson);
export class PendingRemoteCleanupError extends Schema.TaggedError<PendingRemoteCleanupError>()(
  "PendingRemoteCleanupError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not preserve the pending Connect remote cleanup reminder.";
  }
}
const statePath = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(
    path.dirname(config.serverRuntimeStatePath),
    "connect-pending-remote-cleanup.json",
  );
});
export const readPendingRemoteCleanup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const filePath = yield* statePath;
  const info = yield* fs.stat(filePath).pipe(Effect.option);
  if (Option.isSome(info) && (info.value.type !== "File" || Number(info.value.size) > 8192))
    return yield* new PendingRemoteCleanupError({ cause: "size-limit" });
  const raw = yield* fs.readFileString(filePath).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed("[]"),
    ),
  );
  if (raw.length > 8192) return yield* new PendingRemoteCleanupError({ cause: "size-limit" });
  const references = yield* decode(raw);
  if (
    references.length > 16 ||
    references.some(
      (reference) =>
        normalizeSecureRelayUrl(reference.relayOrigin) !== reference.relayOrigin ||
        reference.environmentId.length > 200 ||
        reference.unlinkedAt.length > 40,
    )
  )
    return yield* new PendingRemoteCleanupError({ cause: "invalid-reference" });
  return references;
}).pipe(Effect.mapError((cause) => new PendingRemoteCleanupError({ cause })));

export const rememberPendingRemoteCleanup = Effect.fn("cloud.rememberPendingRemoteCleanup")(
  function* (input: { readonly relayUrl: string; readonly environmentId: string }) {
    const relayOrigin = normalizeSecureRelayUrl(input.relayUrl);
    if (relayOrigin === null || input.environmentId.length > 200)
      return yield* new PendingRemoteCleanupError({ cause: "invalid-reference" });
    const references = yield* readPendingRemoteCleanup;
    if (
      references.some(
        (reference) =>
          reference.relayOrigin === relayOrigin && reference.environmentId === input.environmentId,
      )
    )
      return;
    if (references.length === 16)
      return yield* new PendingRemoteCleanupError({ cause: "reference-limit" });
    const now = yield* DateTime.now;
    const contents = yield* encode([
      ...references,
      {
        relayOrigin,
        environmentId: input.environmentId,
        unlinkedAt: DateTime.formatIso(now),
        status: "pending",
      },
    ]);
    if (new TextEncoder().encode(contents).byteLength > 8192)
      return yield* new PendingRemoteCleanupError({ cause: "size-limit" });
    yield* writeFileStringAtomically({ filePath: yield* statePath, contents });
  },
  Effect.mapError((cause) => new PendingRemoteCleanupError({ cause })),
);

export const clearMatchingPendingRemoteCleanup = Effect.fn(
  "cloud.clearMatchingPendingRemoteCleanup",
)(
  function* (input: { readonly relayUrl: string; readonly environmentId: string }) {
    const references = yield* readPendingRemoteCleanup;
    const remaining = references.filter(
      (reference) =>
        reference.relayOrigin !== normalizeSecureRelayUrl(input.relayUrl) ||
        reference.environmentId !== input.environmentId,
    );
    if (remaining.length === references.length) return;
    yield* writeFileStringAtomically({
      filePath: yield* statePath,
      contents: yield* encode(remaining),
    });
  },
  Effect.mapError((cause) => new PendingRemoteCleanupError({ cause })),
);
