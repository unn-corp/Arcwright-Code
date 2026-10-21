import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { vi } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerEnvironmentLabel from "./ServerEnvironmentLabel.ts";

interface CapturedLog {
  readonly message: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
}

const runMock = vi.fn<ProcessRunner.ProcessRunner["Service"]["run"]>();

const layerProcessRunnerTest = Layer.succeed(
  ProcessRunner.ProcessRunner,
  ProcessRunner.ProcessRunner.of({
    run: (input) => runMock(input),
  }),
);
const layerNoopFileSystem = FileSystem.layerNoop({});
const layerTest = Layer.merge(layerNoopFileSystem, layerProcessRunnerTest);
const withHostPlatform = <ROut, E, RIn>(
  layer: Layer.Layer<ROut, E, RIn>,
  platform: NodeJS.Platform,
  hostname: string,
  environment: NodeJS.ProcessEnv = {},
) =>
  Layer.mergeAll(
    layer,
    Layer.succeed(HostProcess.Platform, platform),
    Layer.succeed(HostProcess.Hostname, hostname),
    Layer.succeed(HostProcess.Environment, environment),
  );

afterEach(() => {
  runMock.mockReset();
});

describe("resolveServerEnvironmentLabel", () => {
  it.effect.each(["linux", "darwin", "win32"] as const)(
    "uses the configured repository name instead of %s host discovery",
    (platform) =>
      Effect.gen(function* () {
        const result = yield* ServerEnvironmentLabel.resolveServerEnvironmentLabel({
          cwdBaseName: "workspace",
        }).pipe(
          Effect.provide(
            withHostPlatform(layerTest, platform, "container-id", {
              T3CODE_ENVIRONMENT_LABEL: "  Squidhub (Personal)  ",
            }),
          ),
        );
        expect(result).toBe("Squidhub (Personal)");
        expect(runMock).not.toHaveBeenCalled();
      }),
  );

  it.effect("keeps hostname discovery when the configured label is blank", () =>
    Effect.gen(function* () {
      const result = yield* ServerEnvironmentLabel.resolveServerEnvironmentLabel({
        cwdBaseName: "workspace",
      }).pipe(
        Effect.provide(
          withHostPlatform(layerTest, "win32", "build-host", {
            T3CODE_ENVIRONMENT_LABEL: "  ",
          }),
        ),
      );
      expect(result).toBe("build-host");
    }),
  );
});
