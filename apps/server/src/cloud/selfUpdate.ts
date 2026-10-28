import {
  ServerSelfUpdateError,
  type ServerSelfUpdateCapability,
  type ServerSelfUpdateInput,
  type ServerSelfUpdateProgressEvent,
  type ServerSelfUpdateProgressStage,
  type ServerSelfUpdateResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";

import { CLI_RELEASE_BASE_URL_ENV } from "@t3tools/shared/cliRelease";
import type { CoordinatorStore } from "@t3tools/shared/forkMaintenanceStore";

import * as ServerConfig from "../config.ts";
import { acquireMaintenanceHost } from "../maintenance/MaintenanceHost.ts";
import * as DesktopAppUpdate from "../desktopUpdate/DesktopAppUpdate.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  ensurePinnedRuntimeInstalled,
  pinnedRuntimeCommand,
  PinnedRuntimeInstallError,
  pinnedRuntimePaths,
  prunePinnedRuntimes,
  PinnedRuntimePreflightBlockedError,
  type PinnedRuntimePaths,
} from "./pinnedRuntime.ts";
import { decodeServicePreflightResult } from "./servicePreflight.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";
import { isExactServiceVersion, SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

import packageJson from "../../package.json" with { type: "json" };

const PREFLIGHT_TIMEOUT = Duration.seconds(30);

export function resolveServerSelfUpdateCapability(input: {
  readonly desktopManaged: boolean;
  readonly launcherManaged: boolean;
}): ServerSelfUpdateCapability | null {
  if (input.desktopManaged) return "desktop-managed" as const;
  return input.launcherManaged ? ("boot-service" as const) : null;
}

export class ServerSelfUpdate extends Context.Service<
  ServerSelfUpdate,
  {
    /** The update path this host supports, for descriptors. Installation itself runs through device maintenance. */
    readonly capability: ServerSelfUpdateCapability | null;
    /**
     * Downloads, digest-checks, extracts and preflights one exact runtime version. It never
     * asks the launcher to activate it: that is the device maintenance transaction's job.
     */
    readonly stage: (input: {
      readonly targetVersion: string;
      readonly expectedArchiveSha256?: string | undefined;
    }) => Effect.Effect<PinnedRuntimePaths, ServerSelfUpdateError>;
    /** Desktop updates delegate to the upstream desktop updater; service replacement retains its coordinator. */
    readonly update: (
      input: ServerSelfUpdateInput,
      reportProgress?: (
        stage: ServerSelfUpdateProgressStage,
      ) => Effect.Effect<void, ServerSelfUpdateError>,
      onHandoffAccepted?: () => Effect.Effect<void>,
    ) => Effect.Effect<ServerSelfUpdateResult, ServerSelfUpdateError>;
    /** Commit a desktop update prepared through the remote desktop handshake. */
    readonly commitDesktopUpdate: (
      requestId: string,
      onHandoffAccepted?: () => Effect.Effect<void>,
    ) => Effect.Effect<never, ServerSelfUpdateError>;
  }
>()("t3/cloud/selfUpdate/ServerSelfUpdate") {}

const RETIRED_REASON =
  "In-product updates run through device maintenance, which checks that no agent is active and keeps a restore point. Use App updates in settings.";

/**
 * A server starting from the runtime its launcher settled on means runtimes left by earlier
 * updates can go. The boot service says so through its IPC context. The SSH launcher and the
 * install script's `t3` start this home's pinned runtime directly, without one.
 */
export const pruneRuntimesOnStart = Effect.fn("cloud.server_self_update.prune_on_start")(
  function* (input: {
    readonly baseDir: string;
    readonly managed: boolean;
    readonly journals?: Pick<CoordinatorStore, "listJournals">;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const executablePath = yield* HostProcess.ExecutablePath;
    const { entryPath } = pinnedRuntimePaths(path, input.baseDir, packageJson.version, platform);
    // The executable path is resolved, so it names the real path of a symlinked T3 home.
    const realEntryPath = yield* fs.realPath(entryPath).pipe(Effect.orElseSucceed(() => entryPath));
    if (!input.managed && executablePath !== entryPath && executablePath !== realEntryPath) {
      return [];
    }
    // Committed service state no longer names the previous runtime, but a
    // retained database restore point can still require that exact binary.
    const journalStore = input.journals;
    const journals = journalStore
      ? yield* Effect.tryPromise(() => journalStore.listJournals())
      : [];
    const removed = yield* prunePinnedRuntimes({
      baseDir: input.baseDir,
      keep: [
        packageJson.version,
        ...journals.flatMap((journal) =>
          journal.target === null
            ? [journal.previous.version]
            : [journal.previous.version, journal.target.version],
        ),
      ],
    });
    if (removed.length > 0) {
      yield* Effect.logInfo("Removed unused t3 runtimes.", { versions: removed });
    }
    return removed;
  },
);

export const make = Effect.fn("cloud.server_self_update.make")(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  // Kept so existing compositions still construct; desktop-managed servers no longer drive it.
  const desktopAppUpdate = yield* DesktopAppUpdate.DesktopAppUpdate;
  const httpClient = yield* HttpClient.HttpClient;
  const releaseBaseUrl = Option.getOrUndefined(
    yield* Config.String(CLI_RELEASE_BASE_URL_ENV).pipe(Config.option),
  );

  yield* Effect.gen(function* () {
    const host = yield* acquireMaintenanceHost(serverConfig);
    if (host.mode === "unavailable") return;
    yield* pruneRuntimesOnStart({
      baseDir: serverConfig.baseDir,
      managed: launcher.managed,
      ...(host.mode === "active" ? { journals: host.store } : {}),
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Kept runtimes because recovery retention could not be verified.", cause),
    ),
    Effect.forkScoped,
  );
  const capability: ServerSelfUpdateCapability | null =
    serverConfig.mode === "desktop" ? "desktop-managed" : launcher.managed ? "boot-service" : null;
  const failWith = (reason: string, cause?: unknown) =>
    cause === undefined
      ? new ServerSelfUpdateError({ reason })
      : new ServerSelfUpdateError({ reason, cause });

  const stage: ServerSelfUpdate["Service"]["stage"] = Effect.fn("cloud.server_self_update.stage")(
    function* (input) {
      if (capability !== "boot-service")
        return yield* failWith("Only a background service stages its own runtime.");
      const targetVersion = input.targetVersion.trim();
      if (!isExactServiceVersion(targetVersion)) {
        return yield* failWith(`'${targetVersion}' is not an exact t3 version.`);
      }
      return yield* ensurePinnedRuntimeInstalled({
        baseDir: serverConfig.baseDir,
        version: targetVersion,
        fs,
        path,
        runner,
        httpClient,
        platform,
        arch,
        releaseBaseUrl,
        expectedArchiveSha256: input.expectedArchiveSha256,
        validate: (runtime) =>
          runner
            .run({
              command: pinnedRuntimeCommand(runtime).command,
              args: [
                ...pinnedRuntimeCommand(runtime).args,
                "__service-preflight",
                "--database-path",
                serverConfig.dbPath,
                "--launcher-protocol",
                String(SERVICE_LAUNCHER_PROTOCOL),
              ],
              timeout: PREFLIGHT_TIMEOUT,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new PinnedRuntimeInstallError({
                    step: "running the staged service preflight",
                    cause,
                  }),
              ),
              Effect.flatMap(
                (
                  result,
                ): Effect.Effect<
                  void,
                  PinnedRuntimeInstallError | PinnedRuntimePreflightBlockedError
                > => {
                  if (result.code !== 0) {
                    return Effect.fail(
                      new PinnedRuntimeInstallError({
                        step: "running the staged service preflight",
                        exitCode: Number(result.code),
                        stdoutLength: result.stdout.length,
                        stderrLength: result.stderr.length,
                      }),
                    );
                  }
                  let parsed: unknown;
                  try {
                    parsed = JSON.parse(result.stdout.trim());
                  } catch (cause) {
                    return Effect.fail(
                      new PinnedRuntimeInstallError({
                        step: "decoding the staged service preflight",
                        cause,
                      }),
                    );
                  }
                  const preflight = decodeServicePreflightResult(parsed);
                  if (preflight === undefined || preflight.version !== targetVersion) {
                    return Effect.fail(
                      new PinnedRuntimeInstallError({
                        step: "verifying the staged service preflight",
                      }),
                    );
                  }
                  return preflight.status === "ready"
                    ? Effect.void
                    : Effect.fail(
                        new PinnedRuntimePreflightBlockedError({
                          version: targetVersion,
                          reason: preflight.reason,
                        }),
                      );
                },
              ),
            ),
      }).pipe(
        Effect.mapError((error) =>
          error._tag === "PinnedRuntimePreflightBlockedError"
            ? failWith(error.reason, error)
            : failWith(`Could not prepare t3@${targetVersion}.`, error),
        ),
      );
    },
  );

  return ServerSelfUpdate.of({
    capability,
    stage,
    update: Effect.fn("ServerSelfUpdate.update")(function (
      _input,
      reportProgress = () => Effect.void,
    ) {
      return capability === "desktop-managed" && desktopAppUpdate.available
        ? desktopAppUpdate.run(reportProgress)
        : Effect.fail(failWith(RETIRED_REASON));
    }),
    commitDesktopUpdate: Effect.fn("ServerSelfUpdate.commitDesktopUpdate")(
      function (requestId, onHandoffAccepted) {
        return capability === "desktop-managed" && desktopAppUpdate.available
          ? desktopAppUpdate.commit(requestId, onHandoffAccepted)
          : Effect.fail(failWith(RETIRED_REASON));
      },
    ),
  });
});

export const layer = Layer.effect(ServerSelfUpdate, make()).pipe(
  Layer.provide(ProcessRunner.layer),
);

// The update outlives client sockets; progress offers to a closed queue are ignored.
export const updateProgressStream = (
  selfUpdate: ServerSelfUpdate["Service"],
  input: ServerSelfUpdateInput,
) =>
  Stream.callback<ServerSelfUpdateProgressEvent, ServerSelfUpdateError>((queue) => {
    const offer = (event: ServerSelfUpdateProgressEvent) =>
      Queue.offer(queue, event).pipe(Effect.ignore);

    return selfUpdate
      .update(input, (stage) => offer({ type: "progress", stage }))
      .pipe(
        Effect.flatMap((result) => offer({ type: "complete", result })),
        Effect.catchTags({
          ServerSelfUpdateError: (error) => Queue.fail(queue, error).pipe(Effect.ignore),
        }),
        Effect.andThen(Queue.end(queue).pipe(Effect.ignore)),
        Effect.forkDetach,
      );
  });
