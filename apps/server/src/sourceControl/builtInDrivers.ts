import * as GitHubApi from "@t3tools/source-control-github/server/GitHubApi";
import * as GitHubDriver from "@t3tools/source-control-github/server/driver";
import type {
  SourceControlDriver,
  SourceControlDriverInstance,
} from "@t3tools/source-control-core/server/driver";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSourceControlHost from "./ServerSourceControlHost.ts";
import { BUILT_IN_SOURCE_CONTROL_DRIVER_LIST } from "./sourceControlDefinitions.ts";

export interface SourceControlDriverEntry {
  readonly driver: Pick<SourceControlDriver, "kind" | "definition">;
  readonly instance: SourceControlDriverInstance;
}

/** Every driver's instance, in registry order. Everything that reads a host reads it here. */
export class SourceControlDrivers extends Context.Service<
  SourceControlDrivers,
  ReadonlyArray<SourceControlDriverEntry>
>()("t3/sourceControl/builtInDrivers/SourceControlDrivers") {}

const make = Effect.gen(function* () {
  // The fork API and upstream driver must share credentials, quota and caches.
  const github = yield* GitHubDriver.makeWithForkApi;
  const entries = yield* Effect.forEach(BUILT_IN_SOURCE_CONTROL_DRIVER_LIST, (driver) =>
    Effect.gen(function* () {
      const instance: SourceControlDriverInstance =
        driver.kind === "github" ? github.instance : yield* driver.make;
      return { driver, instance };
    }),
  );
  return Context.make(SourceControlDrivers, entries).pipe(
    Context.add(GitHubApi.GitHubApi, github.api),
  );
});

export const layer = Layer.effectContext(make).pipe(
  Layer.provideMerge(ServerSourceControlHost.layer),
  Layer.provideMerge(SourceControlRateLimit.layer),
);
