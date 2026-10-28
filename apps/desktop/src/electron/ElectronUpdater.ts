// @effect-diagnostics nodeBuiltinImport:off -- electron-updater boundary verifies its native installer paths before handing off.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { autoUpdater } from "electron-updater";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import type { NsisUpdater, VerifyUpdateCodeSignature } from "electron-updater";

type AutoUpdater = typeof autoUpdater;

export type ElectronUpdaterFeedUrl = Parameters<AutoUpdater["setFeedURL"]>[0] & {
  readonly expectedArtifact?: { readonly sha256: string; readonly bytes: number };
};
let expectedArtifact: ElectronUpdaterFeedUrl["expectedArtifact"];
let verifiedArtifact:
  | { readonly path: string; readonly sha256: string; readonly bytes: number }
  | undefined;

async function verifyInstaller(path: string, artifact: NonNullable<typeof expectedArtifact>) {
  if ((await NodeFSP.stat(path)).size !== artifact.bytes)
    throw new Error("The Arcwright installer size does not match its release.");
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(path)) hash.update(chunk);
  if (hash.digest("hex") !== artifact.sha256)
    throw new Error("The Arcwright installer failed its release digest check.");
}

export class ElectronUpdaterCheckForUpdatesError extends Schema.TaggedError<ElectronUpdaterCheckForUpdatesError>()(
  "ElectronUpdaterCheckForUpdatesError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to check for updates on channel ${this.channel ?? "default"}.`;
  }
}

export class ElectronUpdaterDownloadUpdateError extends Schema.TaggedError<ElectronUpdaterDownloadUpdateError>()(
  "ElectronUpdaterDownloadUpdateError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to download the update on channel ${this.channel ?? "default"}.`;
  }
}

export class ElectronUpdaterQuitAndInstallError extends Schema.TaggedError<ElectronUpdaterQuitAndInstallError>()(
  "ElectronUpdaterQuitAndInstallError",
  {
    channel: Schema.NullOr(Schema.String),
    isSilent: Schema.Boolean,
    isForceRunAfter: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to quit and install the update on channel ${this.channel ?? "default"} (silent: ${this.isSilent}, force run after: ${this.isForceRunAfter}).`;
  }
}

export const ElectronUpdaterError = Schema.Union([
  ElectronUpdaterCheckForUpdatesError,
  ElectronUpdaterDownloadUpdateError,
  ElectronUpdaterQuitAndInstallError,
]);
export type ElectronUpdaterError = typeof ElectronUpdaterError.Type;

export class ElectronUpdater extends Context.Service<
  ElectronUpdater,
  {
    readonly setFeedURL: (options: ElectronUpdaterFeedUrl) => Effect.Effect<void>;
    readonly setAutoDownload: (value: boolean) => Effect.Effect<void>;
    readonly setAutoInstallOnAppQuit: (value: boolean) => Effect.Effect<void>;
    readonly setChannel: (channel: string) => Effect.Effect<void>;
    readonly setAllowPrerelease: (value: boolean) => Effect.Effect<void>;
    readonly allowDowngrade: Effect.Effect<boolean>;
    readonly setAllowDowngrade: (value: boolean) => Effect.Effect<void>;
    readonly setFullChangelog: (value: boolean) => Effect.Effect<void>;
    readonly setDisableDifferentialDownload: (value: boolean) => Effect.Effect<void>;
    readonly pendingDownloadDirectory: Effect.Effect<Option.Option<string>>;
    readonly checkForUpdates: Effect.Effect<void, ElectronUpdaterCheckForUpdatesError>;
    readonly downloadUpdate: Effect.Effect<void, ElectronUpdaterDownloadUpdateError>;
    readonly quitAndInstall: (options: {
      readonly isSilent: boolean;
      readonly isForceRunAfter: boolean;
    }) => Effect.Effect<void, ElectronUpdaterQuitAndInstallError>;
    readonly on: <Args extends ReadonlyArray<unknown>>(
      eventName: string,
      listener: (...args: Args) => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronUpdater") {}

const signatureChecksWithRetry = new WeakSet<VerifyUpdateCodeSignature>();

const retrySignatureCheckAfterTimeout = () => {
  // Only the Windows NSIS updater exposes this hook; its PowerShell check times out after 20 s.
  const updater = autoUpdater as AutoUpdater &
    Partial<Pick<NsisUpdater, "verifyUpdateCodeSignature">>;
  const verify = updater.verifyUpdateCodeSignature;
  if (verify === undefined || signatureChecksWithRetry.has(verify)) return;

  const verifyWithRetry: VerifyUpdateCodeSignature = async (publisherNames, path) => {
    try {
      return await verify(publisherNames, path);
    } catch (error) {
      if (!(error instanceof Error && "killed" in error && error.killed === true)) throw error;
    }

    const logger = updater.logger;
    let skipped = false;
    updater.logger = {
      info: (message) => logger?.info(message),
      warn: (message) => {
        // A failed capability probe makes electron-updater warn and return null without checking.
        skipped ||= String(message).includes("Ignoring signature validation");
        logger?.warn(message);
      },
      error: (message) => logger?.error(message),
      debug: (message) => logger?.debug?.(message),
    };
    try {
      const result = await verify(publisherNames, path);
      return skipped ? "Signature validation was skipped after a timed-out check." : result;
    } finally {
      updater.logger = logger;
    }
  };
  signatureChecksWithRetry.add(verifyWithRetry);
  updater.verifyUpdateCodeSignature = verifyWithRetry;
};

/** @public */
export const make = ElectronUpdater.of({
  setFeedURL: Effect.fn("ElectronUpdater.setFeedURL")(function (options) {
    return Effect.suspend(() => {
      if (typeof options === "string") {
        expectedArtifact = undefined;
        verifiedArtifact = undefined;
        autoUpdater.setFeedURL(options);
        return Effect.void;
      }
      const { expectedArtifact: artifact, ...feed } = options;
      expectedArtifact = artifact;
      // A check may replace the feed while the previous installer is still queued.
      // Its verified binding belongs to the download, not to the newest feed.
      autoUpdater.setFeedURL(feed);
      return Effect.void;
    });
  }),
  setAutoDownload: Effect.fn("ElectronUpdater.setAutoDownload")(function (value) {
    return Effect.suspend(() => {
      autoUpdater.autoDownload = value;
      return Effect.void;
    });
  }),
  setAutoInstallOnAppQuit: Effect.fn("ElectronUpdater.setAutoInstallOnAppQuit")(function (value) {
    return Effect.suspend(() => {
      autoUpdater.autoInstallOnAppQuit = value;
      return Effect.void;
    });
  }),
  setChannel: Effect.fn("ElectronUpdater.setChannel")(function (channel) {
    return Effect.suspend(() => {
      autoUpdater.channel = channel;
      return Effect.void;
    });
  }),
  setAllowPrerelease: Effect.fn("ElectronUpdater.setAllowPrerelease")(function (value) {
    return Effect.suspend(() => {
      autoUpdater.allowPrerelease = value;
      return Effect.void;
    });
  }),
  allowDowngrade: Effect.sync(() => autoUpdater.allowDowngrade),
  setAllowDowngrade: Effect.fn("ElectronUpdater.setAllowDowngrade")(function (value) {
    return Effect.suspend(() => {
      autoUpdater.allowDowngrade = value;
      return Effect.void;
    });
  }),
  setFullChangelog: Effect.fn("ElectronUpdater.setFullChangelog")(function (value) {
    return Effect.suspend(() => {
      autoUpdater.fullChangelog = value;
      return Effect.void;
    });
  }),
  setDisableDifferentialDownload: Effect.fn("ElectronUpdater.setDisableDifferentialDownload")(
    function (value) {
      return Effect.suspend(() => {
        autoUpdater.disableDifferentialDownload = value;
        return Effect.void;
      });
    },
  ),
  // Use the updater's helper so cache lookup follows the same configuration as downloads.
  pendingDownloadDirectory: Effect.tryPromise(() =>
    (
      autoUpdater as unknown as {
        getOrCreateDownloadHelper: () => Promise<{ readonly cacheDirForPendingUpdate: string }>;
      }
    ).getOrCreateDownloadHelper(),
  ).pipe(
    Effect.map((helper) => helper.cacheDirForPendingUpdate),
    Effect.option,
  ),
  checkForUpdates: Effect.suspend(() => {
    const channel = autoUpdater.channel;
    return Effect.tryPromise({
      try: () => autoUpdater.checkForUpdates(),
      catch: (cause) => new ElectronUpdaterCheckForUpdatesError({ channel, cause }),
    }).pipe(Effect.asVoid);
  }),
  downloadUpdate: Effect.suspend(() => {
    retrySignatureCheckAfterTimeout();
    const channel = autoUpdater.channel;
    return Effect.tryPromise({
      try: async () => {
        const artifact = expectedArtifact;
        verifiedArtifact = undefined;
        const files = await autoUpdater.downloadUpdate();
        if (artifact) {
          if (files.length !== 1 || !files[0]) throw new Error("Expected one Arcwright installer.");
          await verifyInstaller(files[0], artifact);
          verifiedArtifact = { path: files[0], ...artifact };
        }
      },
      catch: (cause) => new ElectronUpdaterDownloadUpdateError({ channel, cause }),
    }).pipe(Effect.asVoid);
  }),
  quitAndInstall: Effect.fn("ElectronUpdater.quitAndInstall")(function ({
    isSilent,
    isForceRunAfter,
  }) {
    return Effect.suspend(() => {
      const channel = autoUpdater.channel;
      return Effect.tryPromise({
        try: async () => {
          if (verifiedArtifact) await verifyInstaller(verifiedArtifact.path, verifiedArtifact);
          else if (expectedArtifact)
            throw new Error("The Arcwright installer has not been verified.");
          autoUpdater.quitAndInstall(isSilent, isForceRunAfter);
        },
        catch: (cause) =>
          new ElectronUpdaterQuitAndInstallError({
            channel,
            isSilent,
            isForceRunAfter,
            cause,
          }),
      });
    });
  }),
  on: Effect.fn("ElectronUpdater.on")(function (eventName, listener) {
    const eventTarget = autoUpdater as unknown as {
      on: (eventName: string, listener: (...args: Array<unknown>) => void) => void;
      removeListener: (eventName: string, listener: (...args: Array<unknown>) => void) => void;
    };
    const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
    return Effect.acquireRelease(
      Effect.sync(() => {
        eventTarget.on(eventName, untypedListener);
      }),
      () =>
        Effect.sync(() => {
          eventTarget.removeListener(eventName, untypedListener);
        }),
    ).pipe(Effect.asVoid);
  }),
});

export const layer = Layer.succeed(ElectronUpdater, make);
