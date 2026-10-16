import "vite-plus/test/config";
import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../../vite.config.ts";
import {
  loadRepoEnv,
  connectProfileReceipt,
  connectProfileDigest,
} from "../../scripts/lib/public-config.ts";
import { buildIdentity } from "../../scripts/lib/build-identity.ts";
import packageJson from "./package.json" with { type: "json" };
import { WeightedShardSequencer } from "./src/testUtils/weightedShardSequencer.ts";

// NSIS install time tracks file count, not bytes.
import {
  isExternalCliDependency,
  shouldBundleCliDependency,
} from "../../scripts/lib/cli-external-packages.ts";

export { shouldBundleCliDependency };

const repoEnv = loadRepoEnv();
const cliBuildChannel = packageJson.version.includes("-nightly.") ? "nightly" : "latest";
const configuredAppVersion = process.env.APP_VERSION?.trim() || packageJson.version;

export default mergeConfig(
  baseConfig,
  defineConfig({
    run: {
      tasks: {
        build: {
          command: "node scripts/cli.ts build",
          dependsOn: ["@t3tools/web#build"],
          cache: false,
        },
      },
    },
    pack: {
      entry: ["src/bin.ts"],
      outDir: "dist",
      sourcemap: true,
      clean: true,
      deps: {
        // `neverBundle` forces the native packages out: returning false from
        // `alwaysBundle` only means "no opinion", so a transitive dependency
        // would still be bundled — which silently inlined native loaders such
        // as node-gyp-build, losing native acceleration.
        alwaysBundle: shouldBundleCliDependency,
        neverBundle: (id: string) => isExternalCliDependency(id),
        onlyBundle: false,
      },
      banner: {
        js: "#!/usr/bin/env node\n",
      },
      define: {
        __T3CODE_APP_VERSION__: JSON.stringify(configuredAppVersion),
        __T3CODE_BUILD_IDENTITY__: JSON.stringify(buildIdentity(configuredAppVersion)),
        __T3CODE_BUILD_CHANNEL__: JSON.stringify(cliBuildChannel),
        __T3CODE_BUILD_CONNECT_MODE__: JSON.stringify(repoEnv.T3CODE_CONNECT_MODE ?? "legacy"),
        __T3CODE_BUILD_HOSTED_APP_URL__: JSON.stringify(repoEnv.T3CODE_HOSTED_APP_URL ?? ""),
        __T3CODE_BUILD_CLERK_JWT_TEMPLATE__: JSON.stringify(
          repoEnv.T3CODE_CLERK_JWT_TEMPLATE ?? "",
        ),
        __T3CODE_BUILD_CONNECT_PROFILE_DIGEST__: JSON.stringify(
          connectProfileDigest(connectProfileReceipt(repoEnv)),
        ),
        __T3CODE_BUILD_RELAY_URL__: JSON.stringify(repoEnv.T3CODE_RELAY_URL?.trim() ?? ""),
        __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: JSON.stringify(
          repoEnv.T3CODE_CLERK_PUBLISHABLE_KEY?.trim() ?? "",
        ),
        __T3CODE_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__: JSON.stringify(
          repoEnv.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID?.trim() ?? "",
        ),
        __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__: JSON.stringify(
          repoEnv.T3CODE_RELAY_CLIENT_OTLP_TRACES_URL?.trim() ?? "",
        ),
        __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__: JSON.stringify(
          repoEnv.T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET?.trim() ?? "",
        ),
        __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__: JSON.stringify(
          repoEnv.T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN?.trim() ?? "",
        ),
      },
    },
    test: {
      // The server suite exercises sqlite, git, temp worktrees, and orchestration
      // runtimes heavily. Running files in parallel introduces load-sensitive flakes.
      fileParallelism: false,
      sequence: { sequencer: WeightedShardSequencer },
      // Appended to the root setup, which mergeConfig concatenates.
      setupFiles: ["./src/testUtils/gitConfig.setup.ts"],
      hookTimeout: 120_000,
      testTimeout: 120_000,
    },
  }),
);
