/** Public reminders only: never credentials, mint keys, or background retry work. */
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CLOUD_PUBLIC_AUTHORITY_SECRET, RELAY_URL_SECRET, RELAY_ISSUER_SECRET } from "./config.ts";
import { LinkPublicAuthority } from "./connectAuthority.ts";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as ServerConfig from "../config.ts";
import { resolveSymlinkTarget } from "@t3tools/shared/symlink";
import { lock } from "proper-lockfile";

const PendingCleanupReference = Schema.Struct({
  relayOrigin: Schema.NullOr(Schema.String),
  environmentId: Schema.String,
  unlinkedAt: Schema.String,
  status: Schema.Literals(["pending", "unresolved"]),
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
const isPendingRemoteCleanupError = Schema.is(PendingRemoteCleanupError);
const statePath = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(
    path.dirname(config.serverRuntimeStatePath),
    "connect-pending-remote-cleanup.json",
  );
});

/** Serialize the complete transaction across server/CLI processes, never stealing a stale lock. */
const withPendingCleanupWriteLock = <A, E, R>(task: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const target = yield* resolveSymlinkTarget(yield* statePath);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      const directory = yield* fs.realPath(path.dirname(target));
      const filePath = path.join(directory, path.basename(target));
      const compromised = yield* Deferred.make<never, PendingRemoteCleanupError>();
      const services = yield* Effect.context<never>();
      yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            lock(filePath, {
              realpath: false,
              // A crashed owner requires explicit review after all writers are stopped.
              stale: Infinity,
              update: 1000,
              retries: {
                retries: 20,
                factor: 1,
                minTimeout: 100,
                maxTimeout: 100,
                maxRetryTime: 2000,
              },
              onCompromised: () =>
                Effect.runSyncWith(services)(
                  Deferred.fail(
                    compromised,
                    new PendingRemoteCleanupError({ cause: "lock-compromised" }),
                  ),
                ),
            }),
          catch: () => new PendingRemoteCleanupError({ cause: "lock-unavailable" }),
        }),
        // A release failure must fail cleanup, preserving local authorization material.
        (release) =>
          Effect.tryPromise({
            try: () => release(),
            catch: () => new PendingRemoteCleanupError({ cause: "lock-release-failed" }),
          }).pipe(Effect.orDie),
      );
      return yield* Effect.raceFirst(task, Deferred.await(compromised));
    }),
  ).pipe(
    Effect.catchDefect((cause) =>
      isPendingRemoteCleanupError(cause) ? Effect.fail(cause) : Effect.die(cause),
    ),
  );
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
        (reference.relayOrigin !== null &&
          normalizeSecureRelayUrl(reference.relayOrigin) !== reference.relayOrigin) ||
        reference.environmentId.length > 200 ||
        reference.unlinkedAt.length > 40,
    )
  )
    return yield* new PendingRemoteCleanupError({ cause: "invalid-reference" });
  return references;
}).pipe(Effect.mapError((cause) => new PendingRemoteCleanupError({ cause })));

const decodeLinkAuthority = Schema.decodeUnknownOption(Schema.fromJsonString(LinkPublicAuthority));
export const readStoredCleanupRelayOrigin = Effect.fn(
  "pendingRemoteCleanup.readStoredCleanupRelayOrigin",
)(function* (secrets: ServerSecretStore.ServerSecretStore["Service"]) {
  const [url, issuer, stamp] = yield* Effect.all([
    secrets.get(RELAY_URL_SECRET),
    secrets.get(RELAY_ISSUER_SECRET),
    secrets.get(CLOUD_PUBLIC_AUTHORITY_SECRET),
  ]);
  for (const value of [url, issuer]) {
    if (Option.isSome(value)) {
      const origin = normalizeSecureRelayUrl(new TextDecoder().decode(value.value));
      if (origin !== null) return origin;
    }
  }
  if (Option.isSome(stamp)) {
    const decoded = decodeLinkAuthority(new TextDecoder().decode(stamp.value));
    if (Option.isSome(decoded)) return normalizeSecureRelayUrl(decoded.value.relayOrigin);
  }
  return null;
});

export const rememberPendingRemoteCleanup = Effect.fn("cloud.rememberPendingRemoteCleanup")(
  function* (input: { readonly relayUrl: string | null; readonly environmentId: string }) {
    const relayOrigin = input.relayUrl === null ? null : normalizeSecureRelayUrl(input.relayUrl);
    if (input.environmentId.length > 200)
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
        status: relayOrigin === null ? "unresolved" : "pending",
      },
    ]);
    if (new TextEncoder().encode(contents).byteLength > 8192)
      return yield* new PendingRemoteCleanupError({ cause: "size-limit" });
    yield* writeFileStringAtomically({ filePath: yield* statePath, contents });
  },
  withPendingCleanupWriteLock,
  Effect.mapError((cause) => new PendingRemoteCleanupError({ cause })),
);

export const clearMatchingPendingRemoteCleanup = Effect.fn(
  "cloud.clearMatchingPendingRemoteCleanup",
)(
  function* (input: { readonly relayUrl: string; readonly environmentId: string }) {
    const relayOrigin = normalizeSecureRelayUrl(input.relayUrl);
    if (relayOrigin === null) return false;
    const references = yield* readPendingRemoteCleanup;
    const remaining = references.filter(
      (reference) =>
        reference.relayOrigin !== relayOrigin || reference.environmentId !== input.environmentId,
    );
    if (remaining.length === references.length) return false;
    yield* writeFileStringAtomically({
      filePath: yield* statePath,
      contents: yield* encode(remaining),
    });
    return true;
  },
  withPendingCleanupWriteLock,
  Effect.mapError((cause) => new PendingRemoteCleanupError({ cause })),
);
