// @effect-diagnostics nodeBuiltinImport:off globalFetch:off processEnv:off — the controller talks to the fork's release origin and the host registry.
import * as NodeFSP from "node:fs/promises";
declare const __T3CODE_FORK_PROVENANCE__:
  | { upstreamVersion?: string; upstreamCommit?: string; forkBuildNumber?: number }
  | undefined;
import {
  ForkMaintenanceError,
  type ForkMaintenanceActionInput,
  type ForkMaintenanceInteraction,
  type ForkRecoveryRequest,
  type ForkUpdatePolicyPatch,
  type ForkUpdateStatus,
} from "@t3tools/contracts";
import { detectForkPackaging, forkPlatformKey } from "@t3tools/shared/forkMaintenance";
import { listForkReleases, type FetchLike } from "@t3tools/shared/forkMaintenanceFeed";
import {
  processCreationIdentity,
  UNKNOWN_PROCESS_IDENTITY,
} from "@t3tools/shared/forkMaintenanceStore";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import { DesktopMaintenanceBridge } from "./DesktopMaintenanceBridge.ts";
import {
  createDesktopMaintenance,
  type DesktopMaintenance,
  type ManagedWslRuntime,
  type StartupPlan,
  type TrialTarget,
} from "./maintenanceCore.ts";
import { wslCommandFromStartArgs } from "./wslTransport.ts";

const { logInfo, logError } = DesktopObservability.makeComponentLogger("desktop-maintenance");

const RELEASES_PER_CHECK = 12;

const isMaintenanceError = Schema.is(ForkMaintenanceError);
const AppPackageMetadata = Schema.Struct({
  t3codeCommitHash: Schema.optional(Schema.Unknown),
});
const decodeAppPackageMetadata = Schema.decodeEffect(Schema.fromJsonString(AppPackageMetadata));
const toMaintenanceError = (cause: unknown) =>
  isMaintenanceError(cause)
    ? cause
    : new ForkMaintenanceError({ reason: cause instanceof Error ? cause.message : String(cause) });

export class DesktopForkMaintenance extends Context.Service<
  DesktopForkMaintenance,
  {
    readonly status: Effect.Effect<ForkUpdateStatus>;
    /** Current status plus every later one. The controller is the only source: there is no second copy of update state. */
    readonly subscribe: Effect.Effect<
      { readonly latest: ForkUpdateStatus; readonly changes: Stream.Stream<ForkUpdateStatus> },
      never,
      Scope.Scope
    >;
    /** Check the release origin and stage what it finds. */
    readonly check: Effect.Effect<ForkUpdateStatus, ForkMaintenanceError>;
    readonly install: (
      targetArtifactSha256: string,
    ) => Effect.Effect<ForkUpdateStatus, ForkMaintenanceError>;
    readonly cancelCountdown: Effect.Effect<ForkUpdateStatus, ForkMaintenanceError>;
    readonly updatePolicy: (
      patch: ForkUpdatePolicyPatch,
    ) => Effect.Effect<ForkUpdateStatus, ForkMaintenanceError>;
    readonly runAction: (
      input: ForkMaintenanceActionInput,
    ) => Effect.Effect<ForkUpdateStatus, ForkMaintenanceError>;
    readonly recover: (
      request: ForkRecoveryRequest,
    ) => Effect.Effect<ForkUpdateStatus, ForkMaintenanceError>;
    readonly reportInteraction: (input: ForkMaintenanceInteraction) => Effect.Effect<void>;
    /** Why in-product installation is not available on this installation, or None. */
    readonly disabledReason: Effect.Effect<Option.Option<string>>;
    /**
     * Opens the device coordinator and decides how this launch starts. Must run before any backend does: a
     * transaction that must finish first (a restore) is resumed here, and a trial runtime is told so.
     */
    readonly prepareStartup: Effect.Effect<StartupPlan>;
    /** After the backends started: finish an interrupted transaction while they are health-checked. */
    readonly resumeInBackground: Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/maintenance/DesktopForkMaintenance") {}

export const readCommit = (
  packageJsonPath: string,
  override: string | undefined,
  readFileString: FileSystem.FileSystem["readFileString"],
): Effect.Effect<string | null> => {
  if (override !== undefined && /^[0-9a-f]{40}$/i.test(override))
    return Effect.succeed(override.toLowerCase());
  return readFileString(packageJsonPath).pipe(
    // Use Effect's filesystem provider here: Electron's asar-aware reads must be used
    // for resources/app.asar/package.json in packaged builds.
    Effect.flatMap((raw) => decodeAppPackageMetadata(raw)),
    Effect.map((parsed) => {
      return typeof parsed.t3codeCommitHash === "string" &&
        /^[0-9a-f]{40}$/i.test(parsed.t3codeCommitHash)
        ? parsed.t3codeCommitHash.toLowerCase()
        : null;
    }),
    Effect.orElseSucceed(() => null),
  );
};
const exists = async (target: string) =>
  NodeFSP.access(target).then(
    () => true,
    () => false,
  );

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* DesktopConfig.DesktopConfig;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const desktopState = yield* DesktopState.DesktopState;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const settings = yield* DesktopAppSettings.DesktopAppSettings;
  const fileSystem = yield* FileSystem.FileSystem;
  const bridge = yield* DesktopMaintenanceBridge;
  const context = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(context);

  const platform = forkPlatformKey(environment.platform, environment.processArch);
  const installedByDpkg =
    environment.platform === "linux" && environment.isPackaged
      ? yield* Effect.promise(() =>
          NodeFSP.readFile(
            environment.path.join(environment.resourcesPath, "package-type"),
            "utf8",
          ).then(
            (value) => value.trim() === "deb",
            () => false,
          ),
        )
      : false;
  const appImage = Option.getOrUndefined(config.appImagePath);
  const packaging = detectForkPackaging({
    platform: environment.platform,
    env: appImage === undefined ? {} : { APPIMAGE: appImage },
    installedByDpkg,
  });
  const desktopPackaging = packaging === "service" ? null : packaging;
  const disabledReason =
    environment.isDevelopment || !environment.isPackaged
      ? "Updates are only available in packaged production builds."
      : config.disableAutoUpdate
        ? "Arcwright Code updates are disabled. Set ARCWRIGHT_CODE_DISABLE_AUTO_UPDATE=0 to enable them."
        : null;
  const commit = yield* readCommit(
    environment.path.join(environment.appRoot, "package.json"),
    Option.getOrUndefined(environment.commitHashOverride),
    fileSystem.readFileString,
  );

  const statusChanges = yield* PubSub.sliding<ForkUpdateStatus>(16);
  const latestRef = yield* Ref.make(Option.none<ForkUpdateStatus>());
  const emit = (status: ForkUpdateStatus) => {
    void runPromise(
      Ref.set(latestRef, Option.some(status)).pipe(
        Effect.andThen(PubSub.publish(statusChanges, status)),
        Effect.andThen(electronWindow.sendAll(IpcChannels.MAINTENANCE_STATUS_CHANNEL, status)),
      ),
    );
  };

  const fetchLike: FetchLike = (input, init) => fetch(input, init);

  const managedWsl = async (): Promise<ReadonlyArray<ManagedWslRuntime>> => {
    const current = await runPromise(settings.get);
    if (
      !current.localEnvironmentEnabled ||
      !current.wslBackendEnabled ||
      environment.platform !== "win32"
    )
      return [];
    const instances = await runPromise(pool.list);
    const result = new Map<string, ManagedWslRuntime>();
    for (const instance of instances) {
      const started = Option.getOrNull(await runPromise(instance.currentConfig));
      if (started === null || started.runningDistro === undefined) continue;
      result.set(started.runningDistro, {
        distro: started.runningDistro,
        command: wslCommandFromStartArgs(started.args),
      });
    }
    // Enabled but not yet resolved: still a managed home. It blocks (no command) instead of vanishing from the set.
    if (result.size === 0)
      result.set(current.wslDistro ?? "(default)", {
        distro: current.wslDistro ?? "(default)",
        command: null,
      });
    return [...result.values()];
  };

  const core: DesktopMaintenance = createDesktopMaintenance({
    namespace: process.env.T3CODE_MAINTENANCE_NAMESPACE,
    baseDir: environment.baseDir,
    version: environment.appVersion,
    provenance:
      typeof __T3CODE_FORK_PROVENANCE__ === "undefined" ? undefined : __T3CODE_FORK_PROVENANCE__,
    commit,
    platform,
    packaging: desktopPackaging,
    relaunchEnvironment: process.env,
    installTarget:
      appImage !== undefined && desktopPackaging === "appimage" ? appImage : process.execPath,
    disabledReason,
    authorizationRequired: () =>
      desktopPackaging === "deb"
        ? "Installing a Debian package asks for your system password. Choose Install to start it yourself."
        : null,
    feed: () => listForkReleases(fetchLike, { perPage: RELEASES_PER_CHECK }),
    fetch: (url, init) => fetch(url, init),
    runtime: {
      stopRuntimes: () =>
        runPromise(
          pool.list.pipe(
            Effect.flatMap((instances) =>
              Effect.forEach(
                instances,
                (instance) => instance.stop({ timeout: Duration.seconds(5) }),
                { concurrency: "unbounded", discard: true },
              ),
            ),
          ),
        ),
      startRuntimes: () =>
        runPromise(
          pool.list.pipe(
            Effect.flatMap((instances) =>
              Effect.forEach(instances, (instance) => instance.start, {
                concurrency: "unbounded",
                discard: true,
              }),
            ),
          ),
        ),
      quit: () =>
        runPromise(Ref.set(desktopState.quitting, true).pipe(Effect.andThen(electronApp.quit))),
      self: async () => ({
        pid: process.pid,
        started: (await processCreationIdentity(process.pid)) ?? "",
      }),
    },
    managedWsl,
    descendants: async () => {
      const instances = await runPromise(pool.list);
      const found: Array<{ pid: number; started: string; label: string }> = [];
      for (const instance of instances) {
        const pid = Option.getOrNull((await runPromise(instance.snapshot)).activePid);
        if (pid === null) continue;
        const started = await processCreationIdentity(pid).catch(() => UNKNOWN_PROCESS_IDENTITY);
        if (started !== null) found.push({ pid, started, label: "Arcwright Code backend" });
      }
      return found;
    },
    hasWindow: () => Option.isSome(Effect.runSyncWith(context)(electronWindow.currentMainOrFirst)),
    onStatus: emit,
    userHasExistingData: async () =>
      (await exists(environment.path.join(environment.baseDir, "userdata", "statev2.sqlite"))) ||
      (await exists(environment.path.join(environment.baseDir, "userdata", "state.sqlite"))),
  });
  yield* bridge.provide({
    trialEnv: (target: TrialTarget) => core.trialEnv(target),
    recordWslRuntime: (runtimeId) => core.recordWslRuntime(runtimeId),
    retainedWslRuntimes: () => core.retainedWslRuntimes(),
  });
  yield* Effect.addFinalizer(() => Effect.promise(() => core.stop()).pipe(Effect.ignore));

  const attempt = <A>(work: () => Promise<A>) =>
    Effect.tryPromise({ try: work, catch: toMaintenanceError });
  const publishing = (work: () => Promise<ForkUpdateStatus>) =>
    attempt(work).pipe(Effect.tap((status) => Effect.sync(() => emit(status))));

  /**
   * Resolves how this launch starts. A transaction that has to finish first is finished inside `core.start`, and a launch it
   * cannot finish comes back as `blocked`: nothing here falls through to a normal start.
   */
  const prepareStartup = Effect.gen(function* () {
    const plan = yield* Effect.promise(() => core.start());
    if (plan.kind === "unavailable")
      yield* logInfo("device maintenance unavailable", { reason: plan.reason });
    if (plan.kind === "blocked")
      yield* logError("device maintenance holds this launch", { reason: plan.reason });
    // Settings subscribers hold a placeholder until the coordinator is open.
    yield* Effect.promise(() => core.status().then(emit)).pipe(Effect.ignore);
    return plan;
  });

  const resumeInBackground = Effect.promise(() => core.resumeInterrupted()).pipe(
    Effect.catchCause((cause) =>
      logError("interrupted device update could not be resumed", { cause: String(cause) }),
    ),
    Effect.forkScoped,
    Effect.asVoid,
  );

  return DesktopForkMaintenance.of({
    status: Effect.promise(() => core.status()),
    subscribe: Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(statusChanges);
      const latest = yield* Ref.get(latestRef);
      const initial = Option.isSome(latest)
        ? latest.value
        : yield* Effect.promise(() => core.status());
      return { latest: initial, changes: Stream.fromSubscription(subscription) };
    }),
    check: publishing(() => core.check()),
    install: (digest) => publishing(() => core.install(digest)),
    cancelCountdown: publishing(() => core.cancelCountdown()),
    updatePolicy: (patch) => publishing(() => core.updatePolicy(patch)),
    runAction: (input) => publishing(() => core.runAction(input)),
    recover: (request) => publishing(() => core.recover(request)),
    reportInteraction: (input) => Effect.sync(() => core.reportInteraction(input)),
    disabledReason: Effect.sync(() => Option.fromNullishOr(disabledReason)),
    prepareStartup,
    resumeInBackground,
  });
});

export const layer = Layer.effect(DesktopForkMaintenance, make);
