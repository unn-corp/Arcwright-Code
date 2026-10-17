// @effect-diagnostics nodeBuiltinImport:off -- Fixtures reproduce OpenWhispr's encrypted credential format without accessing the real keyring.
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { beforeEach } from "vite-plus/test";
import { Environment, HomeDirectory, Platform } from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Configuration from "./OpenWhisprConfiguration.ts";
import { storageLog, storageManifest, storageTable } from "./testFixtures/chromiumStorage.ts";

const keyring = { password: "", reads: 0 };
beforeEach(() => {
  keyring.password = Buffer.alloc(32, 7).toString("base64");
  keyring.reads = 0;
});

const preferences: ReadonlyArray<readonly [string, string | null]> = [
  ["transcriptionMode", "providers"],
  ["useLocalWhisper", "false"],
  ["cloudTranscriptionMode", "byok"],
  ["cloudTranscriptionProvider", "custom"],
  ["cloudTranscriptionBaseUrl", "https://speech.example/v1"],
  ["cloudTranscriptionModel", "saved-cloud-model"],
  ["preferredLanguage", "en-US"],
];

function withProfile<E>(
  run: (
    profile: string,
  ) => Effect.Effect<void, E, Configuration.OpenWhisprConfiguration | FileSystem.FileSystem>,
  entries = preferences,
  platform: NodeJS.Platform = "linux",
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "arcwright-openwhispr-config-" });
    const root =
      platform === "darwin"
        ? path.join(home, "Library", "Application Support")
        : platform === "win32"
          ? path.join(home, "AppData", "Roaming")
          : path.join(home, ".config");
    const profile = path.join(root, "open-whispr"),
      storage = path.join(profile, "Local Storage", "leveldb");
    yield* fs.makeDirectory(storage, { recursive: true });
    yield* fs.writeFileString(path.join(storage, "CURRENT"), "MANIFEST-000001\n");
    yield* fs.writeFile(path.join(storage, "MANIFEST-000001"), storageManifest());
    yield* fs.writeFile(path.join(storage, "000003.log"), storageLog(entries));
    yield* run(profile).pipe(
      Effect.provide(
        Configuration.layer.pipe(
          Layer.provide(NodeServices.layer),
          Layer.provide(Layer.succeed(HomeDirectory, home)),
          Layer.provide(Layer.succeed(Platform, platform)),
          Layer.provide(Layer.succeed(Environment, {})),
          Layer.provide(
            Layer.succeed(Configuration.OpenWhisprMasterKey, async () => {
              keyring.reads++;
              return keyring.password || null;
            }),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer));
}

it.effect.each(["linux", "darwin", "win32"] as const)(
  "reads the saved custom model on %s without changing the profile",
  (platform) =>
    withProfile(
      (profile) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem,
            service = yield* Configuration.OpenWhisprConfiguration;
          const file = profile + "/Local Storage/leveldb/000003.log";
          const before = yield* fs.readFile(file);
          expect(yield* service.current).toEqual({
            endpoint: "https://speech.example/v1/audio/transcriptions",
            model: "saved-cloud-model",
            apiKey: "",
            language: "en",
          });
          expect(yield* fs.readFile(file)).toEqual(before);
          expect(yield* fs.exists(profile + "/Local Storage/leveldb/LOCK")).toBe(false);
          expect(keyring.reads).toBe(0);
        }),
      preferences,
      platform,
    ),
);

it.effect("uses the existing OS-keyring credential without copying or rewriting it", () =>
  withProfile((profile) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const iv = Buffer.alloc(12, 3),
        master = Buffer.from(keyring.password, "base64");
      const cipher = NodeCrypto.createCipheriv("aes-256-gcm", master, iv);
      const encrypted = Buffer.concat([cipher.update("saved-custom-key", "utf8"), cipher.final()]);
      const blob = Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
      yield* fs.makeDirectory(profile + "/secure-keys");
      const file = profile + "/secure-keys/CUSTOM_TRANSCRIPTION_API_KEY.enc";
      yield* fs.writeFile(file, blob);
      const service = yield* Configuration.OpenWhisprConfiguration;
      expect((yield* service.current)?.apiKey).toBe("saved-custom-key");
      expect(yield* fs.readFile(file)).toEqual(blob);
      expect(keyring.reads).toBe(1);
    }),
  ),
);

it.effect("fails closed when an encrypted key cannot be unlocked", () =>
  withProfile((profile) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(profile + "/secure-keys");
      yield* fs.writeFile(
        profile + "/secure-keys/CUSTOM_TRANSCRIPTION_API_KEY.enc",
        new Uint8Array(40),
      );
      keyring.password = "";
      const service = yield* Configuration.OpenWhisprConfiguration;
      expect(yield* service.current.pipe(Effect.flip)).toMatchObject({ reason: "credentials" });
    }),
  ),
);

it.effect("re-reads endpoint and model edits and honors switching back to local dictation", () =>
  withProfile((profile) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem,
        service = yield* Configuration.OpenWhisprConfiguration;
      expect((yield* service.current)?.model).toBe("saved-cloud-model");
      yield* fs.writeFile(
        profile + "/Local Storage/leveldb/000003.log",
        storageLog([
          ...preferences,
          ["cloudTranscriptionModel", "changed-model"],
          ["cloudTranscriptionBaseUrl", "https://second.example/v1/audio/transcriptions"],
        ]),
      );
      expect(yield* service.current).toMatchObject({
        model: "changed-model",
        endpoint: "https://second.example/v1/audio/transcriptions",
      });
      yield* fs.writeFile(
        profile + "/Local Storage/leveldb/000003.log",
        storageLog([...preferences, ["transcriptionMode", "local"]]),
      );
      expect(yield* service.current).toBeNull();
    }),
  ),
);

it.effect("reads compacted preferences and excludes obsolete credential records", () =>
  withProfile((profile) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem,
        service = yield* Configuration.OpenWhisprConfiguration;
      const storage = profile + "/Local Storage/leveldb/";
      yield* fs.writeFile(storage + "MANIFEST-000001", storageManifest([7], 9));
      yield* fs.writeFile(storage + "000007.ldb", storageTable(preferences));
      yield* fs.writeFile(
        storage + "000008.ldb",
        storageTable([["customTranscriptionApiKey", "obsolete-secret"]], 10000),
      );
      expect((yield* service.current)?.apiKey).toBe("");
      expect((yield* service.current)?.model).toBe("saved-cloud-model");
    }),
  ),
);

it.effect("uses legacy keys without leaking them into the URL", () =>
  withProfile((profile) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem,
        service = yield* Configuration.OpenWhisprConfiguration;
      yield* fs.writeFileString(profile + "/.env", 'CUSTOM_TRANSCRIPTION_API_KEY="legacy-key"\n');
      const config = yield* service.current;
      expect(config?.apiKey).toBe("legacy-key");
      expect(config?.endpoint).not.toContain("legacy-key");
    }),
  ),
);

it.effect("rejects credentials embedded in a provider URL", () =>
  withProfile(
    () =>
      Effect.gen(function* () {
        const service = yield* Configuration.OpenWhisprConfiguration;
        expect(yield* service.current.pipe(Effect.flip)).toMatchObject({ reason: "settings" });
      }),
    [...preferences, ["cloudTranscriptionBaseUrl", "https://user:secret@speech.example/v1"]],
  ),
);
