import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { CodexSettings } from "@t3tools/contracts";
import {
  CodexShadowHomePathConflictError,
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "./CodexHomeLayout.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
const decodeCodexSettingsValue = Schema.decodeSync(CodexSettings);

const decodeCodexSettings = (input: {
  readonly enabled?: boolean;
  readonly homePath?: string;
  readonly shadowHomePath?: string;
  readonly customModels?: readonly string[];
  readonly binaryPath?: string;
}): CodexSettings => decodeCodexSettingsValue(input);

const makeTempDir = Effect.fn("CodexHomeLayout.test.makeTempDir")(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

const writeTextFile = Effect.fn("CodexHomeLayout.test.writeTextFile")(function* (
  filePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFileString(filePath, contents);
});

it.layer(NodeServices.layer)("CodexHomeLayout", (it) => {
  describe("resolveCodexHomeLayout", () => {
    it.effect("pins a blank instance home instead of inheriting another account's CODEX_HOME", () =>
      Effect.gen(function* () {
        const root = yield* makeTempDir("t3code-codex-default-home-");
        const path = yield* Path.Path;
        const layout = yield* resolveCodexHomeLayout(decodeCodexSettings({})).pipe(
          Effect.provideService(HostProcess.HomeDirectory, root),
          Effect.provideService(HostProcess.Environment, { CODEX_HOME: path.join(root, "work") }),
        );
        expect(layout.effectiveHomePath).toBe(path.join(root, ".codex"));
        expect(layout.sharedHomePath).toBe(layout.effectiveHomePath);
      }),
    );

    it.effect("honors a declared instance home but gives configured paths precedence", () =>
      Effect.gen(function* () {
        const root = yield* makeTempDir("t3code-codex-instance-home-");
        const path = yield* Path.Path;
        const declared = [
          { name: "CODEX_HOME", value: path.join(root, "declared"), sensitive: false },
        ];
        const blank = yield* resolveCodexHomeLayout(decodeCodexSettings({}), declared);
        expect(blank.effectiveHomePath).toBe(declared[0]?.value);
        const configured = yield* resolveCodexHomeLayout(
          decodeCodexSettings({ homePath: path.join(root, "configured") }),
          declared,
        );
        expect(configured.effectiveHomePath).toBe(path.join(root, "configured"));
        const overlay = yield* resolveCodexHomeLayout(
          decodeCodexSettings({ shadowHomePath: path.join(root, "private") }),
          declared,
        );
        expect(overlay.effectiveHomePath).toBe(path.join(root, "private"));
        expect(overlay.sharedHomePath).toBe(declared[0]?.value);
      }),
    );

    it.effect("uses the shared home for continuation and the shadow home for runtime", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
        const shadowHome = path.join(shadowRoot, "shadow");

        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({
            homePath: sharedHome,
            shadowHomePath: shadowHome,
          }),
        );

        expect(layout).toMatchObject({
          mode: "authOverlay",
          sharedHomePath: sharedHome,
          effectiveHomePath: shadowHome,
          continuationKey: `codex:home:${sharedHome}`,
        });
      }),
    );
  });

  describe("materializeCodexShadowHome", () => {
    it.effect.skipIf(!symlinksSupported)(
      "keeps Finder metadata local across repeated shadow home setup",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
          const sharedMetadata = path.join(sharedHome, ".DS_Store");
          const shadowMetadata = path.join(shadowHome, ".DS_Store");

          yield* writeTextFile(sharedMetadata, "shared Finder metadata");
          yield* writeTextFile(shadowMetadata, "shadow Finder metadata");
          yield* writeTextFile(path.join(shadowHome, "auth.json"), '{"shadow":true}\n');
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );

          yield* materializeCodexShadowHome(layout);
          expect(yield* fileSystem.readFileString(shadowMetadata)).toBe("shadow Finder metadata");
          yield* fileSystem.remove(shadowMetadata);
          yield* materializeCodexShadowHome(layout);
          expect(yield* fileSystem.exists(shadowMetadata)).toBe(false);

          yield* writeTextFile(shadowMetadata, "shadow Finder metadata");
          yield* materializeCodexShadowHome(layout);
          yield* materializeCodexShadowHome(layout);

          expect(yield* fileSystem.readFileString(sharedMetadata)).toBe("shared Finder metadata");
          expect(yield* fileSystem.readFileString(shadowMetadata)).toBe("shadow Finder metadata");
          expect(yield* fileSystem.readFileString(path.join(shadowHome, "auth.json"))).toBe(
            '{"shadow":true}\n',
          );
          expect(yield* fileSystem.readLink(path.join(shadowHome, "sessions"))).toBe(
            path.join(sharedHome, "sessions"),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "materializes a shadow home with shared state links and private auth",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");

          yield* fileSystem.makeDirectory(path.join(sharedHome, "sessions"));
          yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');
          yield* writeTextFile(
            path.join(sharedHome, "models_cache.json"),
            '{"models":["shared"]}\n',
          );
          yield* writeTextFile(path.join(sharedHome, "auth.json"), '{"shared":true}\n');
          yield* fileSystem.makeDirectory(shadowHome, { recursive: true });
          yield* writeTextFile(path.join(shadowHome, "auth.json"), '{"shadow":true}\n');
          yield* fileSystem.symlink(
            path.join(sharedHome, "models_cache.json"),
            path.join(shadowHome, "models_cache.json"),
          );

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout);

          const sessionsTarget = yield* fileSystem.readLink(path.join(shadowHome, "sessions"));
          const configTarget = yield* fileSystem.readLink(path.join(shadowHome, "config.toml"));
          const mcpOauthLocksTarget = yield* fileSystem.readLink(
            path.join(shadowHome, "mcp-oauth-locks"),
          );
          const modelsCacheExists = yield* fileSystem.exists(
            path.join(shadowHome, "models_cache.json"),
          );
          const authLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, "auth.json"))
            .pipe(Effect.result);
          const authContents = yield* fileSystem.readFileString(path.join(shadowHome, "auth.json"));

          expect(sessionsTarget).toBe(path.join(sharedHome, "sessions"));
          expect(configTarget).toBe(path.join(sharedHome, "config.toml"));
          expect(mcpOauthLocksTarget).toBe(path.join(sharedHome, "mcp-oauth-locks"));
          expect(modelsCacheExists).toBe(false);
          expect(authLinkResult._tag).toBe("Failure");
          expect(authContents).toContain("shadow");
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "replaces a Codex-created local sqlite maintenance lock with the shared lock",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          const sharedLock = path.join(sharedHome, ".sqlite-maintenance.lock");
          const shadowLock = path.join(shadowHome, ".sqlite-maintenance.lock");

          yield* writeTextFile(sharedLock, "");
          yield* writeTextFile(shadowLock, "");

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout);

          expect(yield* fileSystem.readLink(shadowLock)).toBe(sharedLock);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "replaces Codex-created local MCP OAuth locks with the shared lock directory",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          const sharedLocks = path.join(sharedHome, "mcp-oauth-locks");
          const shadowLocks = path.join(shadowHome, "mcp-oauth-locks");

          yield* writeTextFile(path.join(sharedLocks, "file-store.lock"), "");
          yield* writeTextFile(path.join(shadowLocks, "file-store.lock"), "");

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout);

          const locksTarget = yield* fileSystem.readLink(shadowLocks);
          const sharedLockExists = yield* fileSystem.exists(
            path.join(sharedLocks, "file-store.lock"),
          );

          expect(locksTarget).toBe(sharedLocks);
          expect(sharedLockExists).toBe(true);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "accepts Codex-created shadow-local runtime directories",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");

          yield* fileSystem.makeDirectory(path.join(sharedHome, "log"));
          yield* fileSystem.makeDirectory(path.join(sharedHome, "memories"));
          yield* fileSystem.makeDirectory(path.join(sharedHome, "tmp"));
          yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');
          yield* writeTextFile(path.join(shadowHome, "auth.json"), '{"shadow":true}\n');
          yield* fileSystem.makeDirectory(path.join(shadowHome, "log"), { recursive: true });
          yield* fileSystem.makeDirectory(path.join(shadowHome, "memories"), { recursive: true });
          yield* fileSystem.makeDirectory(path.join(shadowHome, "tmp"), { recursive: true });

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout);

          const configTarget = yield* fileSystem.readLink(path.join(shadowHome, "config.toml"));
          const logLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, "log"))
            .pipe(Effect.result);
          const memoriesLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, "memories"))
            .pipe(Effect.result);
          const tmpLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, "tmp"))
            .pipe(Effect.result);

          expect(configTarget).toBe(path.join(sharedHome, "config.toml"));
          expect(logLinkResult._tag).toBe("Failure");
          expect(memoriesLinkResult._tag).toBe("Failure");
          expect(tmpLinkResult._tag).toBe("Failure");
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "keeps each account's Codex app-server daemon state out of the shared home",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          const sharedDaemonPid = path.join(sharedHome, "app-server-daemon", "daemon.pid");
          const shadowDaemon = path.join(shadowHome, "app-server-daemon");
          const shadowControlLock = path.join(
            shadowHome,
            "app-server-control",
            "app-server-startup.lock",
          );

          yield* writeTextFile(sharedDaemonPid, "shared account daemon");
          yield* writeTextFile(
            path.join(sharedHome, "app-server-control", "app-server-startup.lock"),
            "shared account lock",
          );
          yield* writeTextFile(shadowControlLock, "shadow account lock");
          yield* writeTextFile(path.join(shadowHome, "auth.json"), '{"shadow":true}\n');
          // Shadow homes created by earlier builds link the shared daemon directory.
          yield* fileSystem.symlink(path.join(sharedHome, "app-server-daemon"), shadowDaemon);

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );

          yield* materializeCodexShadowHome(layout);

          expect(yield* fileSystem.exists(shadowDaemon)).toBe(false);
          expect(yield* fileSystem.readFileString(shadowControlLock)).toBe("shadow account lock");
          expect(yield* fileSystem.readFileString(sharedDaemonPid)).toBe("shared account daemon");
        }),
    );

    it.effect("rejects shadow homes that point at the shared home", () =>
      Effect.gen(function* () {
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({
            homePath: sharedHome,
            shadowHomePath: sharedHome,
          }),
        );

        const error = yield* materializeCodexShadowHome(layout).pipe(Effect.flip);

        expect(error).toBeInstanceOf(CodexShadowHomePathConflictError);
        expect(error).toMatchObject({
          sharedHomePath: sharedHome,
          effectiveHomePath: sharedHome,
        });
        expect(error.message).toBe(
          `Codex shadow home path '${sharedHome}' must be different from the shared home path '${sharedHome}'.`,
        );
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "moves legacy real shared files aside before creating their links",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');
          yield* writeTextFile(path.join(shadowHome, "config.toml"), 'model = "local"\n');

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout);

          const configTarget = yield* fileSystem.readLink(path.join(shadowHome, "config.toml"));
          const backupRoot = path.join(
            path.dirname(shadowHome),
            `${path.basename(shadowHome)}.t3-shadow-backups`,
          );
          const backupDirectories = yield* fileSystem.readDirectory(backupRoot);
          const backupContents = yield* fileSystem.readFileString(
            path.join(backupRoot, backupDirectories[0]!, "config.toml"),
          );

          expect(configTarget).toBe(path.join(sharedHome, "config.toml"));
          expect(backupDirectories).toHaveLength(1);
          expect(backupContents).toBe('model = "local"\n');

          yield* materializeCodexShadowHome(layout);
          expect(yield* fileSystem.readDirectory(backupRoot)).toHaveLength(1);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "moves legacy real shared directories aside before creating their links",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");

          yield* fileSystem.makeDirectory(path.join(sharedHome, "ambient-suggestions"));
          yield* fileSystem.makeDirectory(path.join(shadowHome, "ambient-suggestions"), {
            recursive: true,
          });
          yield* writeTextFile(
            path.join(shadowHome, "ambient-suggestions", "legacy.json"),
            '{"legacy":true}\n',
          );

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout);

          const directoryTarget = yield* fileSystem.readLink(
            path.join(shadowHome, "ambient-suggestions"),
          );
          const backupRoot = path.join(
            path.dirname(shadowHome),
            `${path.basename(shadowHome)}.t3-shadow-backups`,
          );
          const backupDirectories = yield* fileSystem.readDirectory(backupRoot);
          const backupContents = yield* fileSystem.readFileString(
            path.join(backupRoot, backupDirectories[0]!, "ambient-suggestions", "legacy.json"),
          );

          expect(directoryTarget).toBe(path.join(sharedHome, "ambient-suggestions"));
          expect(backupDirectories).toHaveLength(1);
          expect(backupContents).toBe('{"legacy":true}\n');
        }),
    );
  });
});
