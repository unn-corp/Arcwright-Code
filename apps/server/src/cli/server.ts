import { runTeamService } from "../team/server.ts";
import { requireTeamServiceConfiguration } from "../team/serviceConfig.ts";
import { resolveTeamServiceConfig, teamServiceCommandFlags } from "./config.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, GlobalFlag } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import * as ServerConfig from "../config.ts";
import { ensureOrganizationScopeLaunchBroker } from "../organizations/OrganizationScopeLaunchBrokerBootstrap.ts";
import { OrganizationScopeRecoveryError } from "../organizations/OrganizationScopeRecoveryStore.ts";
import { type CliServerFlags, resolveServerConfig, sharedServerCommandFlags } from "./config.ts";

const encodeCommand = Schema.encodeEffect(Schema.fromJsonString(Schema.String));

const runServerCommand = (
  flags: CliServerFlags,
  options?: {
    readonly startupPresentation?: ServerConfig.StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
    readonly rejectRunningServer?: boolean;
  },
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveServerConfig(flags, logLevel, options);
    const { runServer } = yield* Effect.promise(() => import("../server.ts"));
    yield* Effect.tryPromise({
      try: () => ensureOrganizationScopeLaunchBroker(config.baseDir),
      catch: (cause) =>
        new OrganizationScopeRecoveryError({
          code: "unavailable",
          message:
            cause instanceof Error ? cause.message : "Organization launch broker unavailable",
        }),
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Organization launch broker unavailable; scoped execution is held", {
          message: cause instanceof Error ? cause.message : "Broker startup failed",
        }),
      ),
    );
    return yield* runServer.pipe(Effect.provideService(ServerConfig.ServerConfig, config));
  });

/** Bare words can name existing directories, but must not create typo projects. */
export const runDefaultServerCommand = (flags: CliServerFlags) =>
  Effect.gen(function* () {
    if (Option.isSome(flags.cwd)) {
      const cwd = flags.cwd.value.trim();
      const fs = yield* FileSystem.FileSystem;
      const platform = yield* HostProcessPlatform;
      const explicitPath =
        cwd === "." ||
        cwd === ".." ||
        cwd === "~" ||
        /[/\\]/.test(cwd) ||
        (platform === "win32" && /^[a-z]:/i.test(cwd));
      if (
        !explicitPath &&
        (!(yield* fs.exists(cwd)) || (yield* fs.stat(cwd)).type !== "Directory")
      ) {
        return yield* new CliError.UserError({
          cause: cwd,
          userMessage: `Unknown command ${yield* encodeCommand(cwd)}. Use "t3 --help" for commands or an explicit path such as "t3 ./my-project" for a new directory.`,
        });
      }
    }
    return yield* runServerCommand(flags, { rejectRunningServer: true });
  });

export const startCommand = Command.make("start", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription("Run the Arcwright Code server."),
  Command.withHandler((flags) => runServerCommand(flags, { rejectRunningServer: true })),
);

export const serveCommand = Command.make("serve", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription(
    "Run the Arcwright Code server without opening a browser and print headless pairing details.",
  ),
  Command.withHandler((flags) =>
    runServerCommand(flags, {
      startupPresentation: "headless",
      forceAutoBootstrapProjectFromCwd: false,
    }),
  ),
);

export const teamServiceCommand = Command.make("team-service", teamServiceCommandFlags).pipe(
  Command.withDescription(
    "Run the Teams collaboration service; agents run on teammates' local machines.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      yield* requireTeamServiceConfiguration;
      const config = yield* resolveTeamServiceConfig(flags, yield* GlobalFlag.LogLevel);
      return yield* runTeamService.pipe(Effect.provideService(ServerConfig.ServerConfig, config));
    }),
  ),
);
