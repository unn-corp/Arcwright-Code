import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Command, Flag, GlobalFlag } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BootService from "../cloud/bootService.ts";
import * as CliState from "../cloud/CliState.ts";
import { CLOUD_ENDPOINT_RUNTIME_CONFIG, CLOUD_LINK_REVOKED } from "../cloud/config.ts";
import { hasCloudPublicConfig } from "../cloud/publicConfig.ts";
import * as ServerConfig from "../config.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { headlessFlag } from "./connect.ts";
import * as CliService from "./service.ts";

/** How other devices reach this machine now. */
interface Setup {
  readonly service: BootService.BootServiceStatus;
  /** Null in builds without T3 Connect. Off when T3 Connect revoked the link. */
  readonly connect: boolean | null;
  /** T3 Connect revoked the link; `t3 connect` links again. */
  readonly connectRevoked: boolean;
  readonly lan: boolean;
  /** An installed service with no T3CODE_LAN keeps the old default: on. */
  readonly lanFromOldDefault: boolean;
  readonly host: string | undefined;
}

/**
 * T3 Connect is on when this CLI asked for a managed link, or when the desktop or
 * web app made one: that saves the tunnel config but no CLI marker. Revoked is off.
 */
export const connectEnabled = (link: {
  readonly cliDesired: boolean;
  readonly cliMode: CliState.CliDesiredLinkMode;
  readonly managedTunnel: boolean;
  readonly revoked: boolean;
}) =>
  // The server starts no tunnel for a CLI publish-only link, even with an old tunnel config.
  !link.revoked && (link.cliDesired ? link.cliMode === "managed" : link.managedTunnel);

const readSetup = Effect.fn("cli.up.read_setup")(function* () {
  const { baseDir } = yield* ServerConfig.ServerConfig;
  const service = yield* (yield* BootService.BootService).status;
  const { entries } = yield* CliService.readServiceEnv(baseDir);
  // Parsed as the server parses it.
  const lan = yield* Config.Boolean("T3CODE_LAN")
    .pipe(Config.option)
    .parse(ConfigProvider.fromEnv({ env: entries }));
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const connectRevoked =
    hasCloudPublicConfig && Option.isSome(yield* secrets.get(CLOUD_LINK_REVOKED));
  const connect = hasCloudPublicConfig
    ? connectEnabled({
        cliDesired: yield* CliState.readCliDesiredCloudLink,
        cliMode: yield* CliState.readCliDesiredLinkMode,
        managedTunnel: Option.isSome(yield* secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG)),
        revoked: connectRevoked,
      })
    : null;
  return {
    service,
    connect,
    connectRevoked,
    lan: Option.getOrElse(lan, () => service.installed),
    lanFromOldDefault: Option.isNone(lan) && service.installed,
    host: entries.T3CODE_HOST,
  } satisfies Setup;
});

const formatSetup = (setup: Setup) => {
  const { service } = setup;
  const rows: ReadonlyArray<readonly [string, string]> = [
    [
      "Service",
      !service.supported
        ? "unavailable"
        : service.installed
          ? `installed · t3@${service.installedVersion ?? packageJson.version}`
          : "not installed",
    ],
    ...(setup.connect === null
      ? []
      : [
          [
            "T3 Connect",
            setup.connect
              ? "on · your T3 account"
              : setup.connectRevoked
                ? "off · link revoked. Run `t3 connect`."
                : "off",
          ] as const,
        ]),
    [
      "Local network",
      setup.host !== undefined
        ? `overridden · T3CODE_HOST=${setup.host}`
        : setup.lanFromOldDefault
          ? "on · kept from an older install"
          : setup.lan
            ? "on · pairing code only"
            : "off",
    ],
  ];
  const notes = [
    ...(setup.host === undefined && setup.lan
      ? ["Anyone on your LAN or tailnet can reach the port. A pairing code is the only lock."]
      : []),
    ...(setup.lanFromOldDefault ? ["Older installs keep LAN access on."] : []),
  ];
  return [
    ...rows.map(([label, value]) => `  ${label.padEnd(15)}${value}`),
    ...(notes.length === 0 ? [] : ["", ...notes]),
  ].join("\n");
};

export const upCommand = Command.make("up", {
  ...projectLocationFlags,
  connect: Flag.Boolean("connect").pipe(
    Flag.withDescription(
      "Allow access through T3 Connect with your T3 account. Turn off with --no-connect.",
    ),
    Flag.optional,
  ),
  lan: Flag.Boolean("lan").pipe(
    Flag.withDescription(
      "Allow LAN and tailnet connections. Anyone there can reach the port; a pairing code is the only lock. Turn off with --no-lan.",
    ),
    Flag.optional,
  ),
  yes: Flag.Boolean("yes").pipe(
    Flag.withDescription(
      "Ask nothing. Keep the access settings; a new machine gets T3 Connect. A restart stops running agent turns.",
    ),
    Flag.withDefault(false),
  ),
  headless: headlessFlag,
}).pipe(
  Command.withShortDescription("Remote access setup is currently unavailable."),
  Command.withDescription(
    "Unavailable until maintenance admission is supported. Use the documented service and update procedures.",
  ),
  Command.withHandler(() =>
    Effect.fail(
      new CliError.UserError({
        cause: "uncommissioned",
        userMessage:
          "t3 up is unavailable until maintenance admission is supported. Use the documented Arcwright Code service and update procedures.",
      }),
    ),
  ),
);

/** `t3 status --json`, for scripts and agents. */
const setupJson = (setup: Setup) =>
  JSON.stringify(
    {
      service: {
        supported: setup.service.supported,
        installed: setup.service.installed,
        installedVersion: setup.service.installedVersion ?? null,
      },
      connect:
        setup.connect === null ? null : { enabled: setup.connect, revoked: setup.connectRevoked },
      lan: {
        enabled: setup.lan,
        inheritedDefault: setup.lanFromOldDefault,
        hostOverride: setup.host ?? null,
      },
    },
    null,
    2,
  );

export const statusCommand = Command.make("status", {
  ...projectLocationFlags,
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Print the settings as JSON. Does not test connections."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Show service setup and remote access settings."),
  Command.withExamples([
    { command: "t3 status", description: "Show the settings." },
    { command: "t3 status --json", description: "Print them for scripts and agents." },
  ]),
  Command.withHandler(
    Effect.fn("cli.status")(function* (flags) {
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel, {
        quietLogs: flags.json,
      });
      // Only what readSetup reads: no database, unlike the T3 Connect commands.
      const setup = yield* readSetup().pipe(
        Effect.provide(
          Layer.merge(CliService.layer(config), ServerSecretStore.layer).pipe(
            Layer.provideMerge(ServerConfig.layer(config)),
          ),
        ),
      );
      yield* Console.log(flags.json ? setupJson(setup) : `This machine\n${formatSetup(setup)}`);
    }),
  ),
);
