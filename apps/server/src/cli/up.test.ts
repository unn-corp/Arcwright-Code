import * as Option from "effect/Option";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/cli";
import { afterEach, vi } from "vite-plus/test";

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";
import { upsertServiceEnv } from "./service.ts";
import { connectEnabled, planRoutes, upCommand } from "./up.ts";

const none = Option.none<boolean>();

it.each([
  {
    label: "a new machine starts from T3 Connect and asks",
    setup: { installed: false, connect: false, lan: false },
    flags: { connect: none, lan: none },
    expected: { routes: { connect: true, lan: false }, ask: ["connect", "lan"] },
  },
  {
    label: "a build without T3 Connect never offers it",
    setup: { installed: false, connect: null, lan: false },
    flags: { connect: none, lan: none },
    expected: { routes: { connect: false, lan: false }, ask: ["lan"] },
  },
  {
    label: "a rerun starts from the current setup",
    setup: { installed: true, connect: false, lan: true },
    flags: { connect: none, lan: none },
    expected: { routes: { connect: false, lan: true }, ask: ["connect", "lan"] },
  },
  {
    label: "a route flag on a new machine turns on only that route",
    setup: { installed: false, connect: false, lan: false },
    flags: { connect: none, lan: Option.some(true) },
    expected: { routes: { connect: false, lan: true }, ask: [] },
  },
  {
    label: "a route flag asks nothing and keeps the other route",
    setup: { installed: true, connect: true, lan: true },
    flags: { connect: none, lan: Option.some(false) },
    expected: { routes: { connect: true, lan: false }, ask: [] },
  },
])("$label", ({ setup, flags, expected }) => {
  expect(planRoutes(setup, flags)).toEqual(expected);
});

it.each([
  {
    label: "a CLI managed link",
    cliDesired: true,
    cliMode: "managed",
    managedTunnel: false,
    revoked: false,
    on: true,
  },
  {
    label: "a link the app made",
    cliDesired: false,
    cliMode: "managed",
    managedTunnel: true,
    revoked: false,
    on: true,
  },
  {
    label: "a publish-only link",
    cliDesired: true,
    cliMode: "publish_only",
    managedTunnel: false,
    revoked: false,
    on: false,
  },
  {
    label: "a publish-only link with an old tunnel config",
    cliDesired: true,
    cliMode: "publish_only",
    managedTunnel: true,
    revoked: false,
    on: false,
  },
  {
    label: "a revoked link",
    cliDesired: true,
    cliMode: "managed",
    managedTunnel: true,
    revoked: true,
    on: false,
  },
  {
    label: "no link",
    cliDesired: false,
    cliMode: "managed",
    managedTunnel: false,
    revoked: false,
    on: false,
  },
] as const)("T3 Connect is on for $label: $on", ({ label: _, on, ...link }) => {
  expect(connectEnabled(link)).toBe(on);
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer))("t3 up", (it) => {
  afterEach(() => vi.restoreAllMocks());
  it.effect.each([[], ["--lan"], ["--connect", "--yes"]])(
    "rejects lifecycle setup without service operations for %j",
    (args) =>
      Effect.gen(function* () {
        const serviceLayer = vi.spyOn(BootService, "layer");
        const error = yield* Command.runWith(upCommand, { version: packageJson.version })(
          args,
        ).pipe(Effect.flip);
        expect(error.message).toContain("unavailable until maintenance admission is supported");
        expect(serviceLayer).not.toHaveBeenCalled();
      }),
  );
});

it("rewrites only the named service.env keys and keeps the user's lines", () => {
  const before = ["# my settings", "T3CODE_PORT=4000", "export T3CODE_LAN=0", "T3CODE_LAN=1", ""];
  expect(upsertServiceEnv(before.join("\n"), { T3CODE_LAN: "true", T3CODE_HOST: undefined })).toBe(
    ["# my settings", "T3CODE_PORT=4000", "T3CODE_LAN=true", ""].join("\n"),
  );
  expect(upsertServiceEnv("", { T3CODE_LAN: "false" })).toBe("T3CODE_LAN=false\n");
});
