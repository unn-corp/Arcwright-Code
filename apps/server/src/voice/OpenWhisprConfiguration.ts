// @effect-diagnostics nodeBuiltinImport:off -- OpenWhispr encrypts its API key with the OS keyring and Node AES-GCM.
import * as NodeCrypto from "node:crypto";
import { Environment, HomeDirectory, Platform } from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { chromiumStorageFiles, decodeChromiumLocalStorage } from "./chromiumLocalStorage.ts";

export class OpenWhisprConfigurationError extends Schema.TaggedError<OpenWhisprConfigurationError>()(
  "OpenWhisprConfigurationError",
  { reason: Schema.Literals(["settings", "credentials"]) },
) {
  override get message(): string {
    return "Could not read the configured OpenWhispr cloud model.";
  }
}

export interface OpenWhisprCloudConfiguration {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey: string;
  readonly language?: string;
}

export class OpenWhisprConfiguration extends Context.Service<
  OpenWhisprConfiguration,
  {
    readonly current: Effect.Effect<
      OpenWhisprCloudConfiguration | null,
      OpenWhisprConfigurationError
    >;
  }
>()("t3/voice/OpenWhisprConfiguration") {}

const keys = new Set([
  "transcriptionMode",
  "useLocalWhisper",
  "cloudTranscriptionMode",
  "cloudTranscriptionProvider",
  "cloudTranscriptionBaseUrl",
  "cloudTranscriptionModel",
  "remoteTranscriptionUrl",
  "remoteTranscriptionModel",
  "preferredLanguage",
  "customTranscriptionApiKey",
]);
const MAX_STORAGE_BYTES = 64 * 1024 * 1024;
const decodeLegacyQuotedKey = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.String));

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path;
  const home = yield* HomeDirectory,
    platform = yield* Platform,
    env = yield* Environment;
  const root =
    platform === "darwin"
      ? path.join(home, "Library", "Application Support")
      : platform === "win32"
        ? env.APPDATA || path.join(home, "AppData", "Roaming")
        : env.XDG_CONFIG_HOME || path.join(home, ".config");
  const profile = path.join(root, "open-whispr"),
    storage = path.join(profile, "Local Storage", "leveldb");
  const read = (file: string) =>
    Effect.gen(function* () {
      const stat = yield* fs.stat(file);
      if (stat.size > BigInt(MAX_STORAGE_BYTES))
        return yield* new OpenWhisprConfigurationError({ reason: "settings" });
      const data = yield* fs.readFile(file);
      if (data.length > MAX_STORAGE_BYTES)
        return yield* new OpenWhisprConfigurationError({ reason: "settings" });
      return data;
    });
  const readPreferences = Effect.gen(function* () {
    const currentFile = path.join(storage, "CURRENT");
    if (!(yield* fs.exists(currentFile))) return null;
    const current = (yield* fs.readFileString(currentFile)).trim();
    if (!/^MANIFEST-\d+$/.test(current))
      return yield* new OpenWhisprConfigurationError({ reason: "settings" });
    const manifest = yield* read(path.join(storage, current));
    const names = yield* fs.readDirectory(storage);
    const selected = yield* Effect.try(() => chromiumStorageFiles(manifest, names));
    let total = 0;
    const files = new Map<string, Uint8Array>();
    for (const name of selected) {
      const data = yield* read(path.join(storage, name));
      total += data.length;
      if (total > MAX_STORAGE_BYTES)
        return yield* new OpenWhisprConfigurationError({ reason: "settings" });
      files.set(name, data);
    }
    if ((yield* fs.readFileString(currentFile)).trim() !== current)
      return yield* new OpenWhisprConfigurationError({ reason: "settings" });
    const finalManifest = yield* read(path.join(storage, current));
    if (!Buffer.from(manifest).equals(finalManifest))
      return yield* new OpenWhisprConfigurationError({ reason: "settings" });
    return yield* Effect.try(() => decodeChromiumLocalStorage(files, keys));
  }).pipe(
    Effect.mapError(() => new OpenWhisprConfigurationError({ reason: "settings" })),
    // Compaction may retire a table between CURRENT and the last read. Retry from CURRENT once.
    Effect.retry({ times: 1 }),
  );
  const readKey = (preferences: ReadonlyMap<string, string>) =>
    Effect.gen(function* () {
      const encryptedFile = path.join(profile, "secure-keys", "CUSTOM_TRANSCRIPTION_API_KEY.enc");
      if (yield* fs.exists(encryptedFile)) {
        const encrypted = yield* read(encryptedFile);
        return yield* Effect.tryPromise(async (signal) => {
          const { AsyncEntry } = await import("@napi-rs/keyring");
          const stored = await new AsyncEntry("OpenWhispr", "secrets-master-key").getPassword(
            signal,
          );
          if (!stored || encrypted.length <= 28) throw new Error("Cloud credential unavailable");
          const key = Buffer.from(stored, "base64");
          if (key.length !== 32) throw new Error("Invalid master key");
          const decipher = NodeCrypto.createDecipheriv(
            "aes-256-gcm",
            key,
            encrypted.subarray(0, 12),
          );
          decipher.setAuthTag(encrypted.subarray(12, 28));
          return Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()])
            .toString("utf8")
            .trim();
        }).pipe(
          Effect.timeoutOrElse({
            duration: 3_000,
            orElse: () => Effect.fail(new OpenWhisprConfigurationError({ reason: "credentials" })),
          }),
        );
      }
      const legacy = preferences.get("customTranscriptionApiKey")?.trim();
      if (legacy) return legacy;
      const envFile = path.join(profile, ".env");
      if (!(yield* fs.exists(envFile))) return "";
      const text = new TextDecoder().decode(yield* read(envFile));
      const value = /^\s*CUSTOM_TRANSCRIPTION_API_KEY\s*=\s*(.*?)\s*$/m.exec(text)?.[1] ?? "";
      if (value.startsWith('"') && value.endsWith('"')) {
        return yield* decodeLegacyQuotedKey(value);
      }
      if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
      return value.replace(/\s+#.*$/, "").trim();
    }).pipe(Effect.mapError(() => new OpenWhisprConfigurationError({ reason: "credentials" })));

  return OpenWhisprConfiguration.of({
    current: Effect.gen(function* () {
      const preferences = yield* readPreferences;
      if (!preferences) return null;
      const mode = preferences.get("transcriptionMode"),
        selfHosted = mode === "self-hosted";
      if (mode === "local" || (!mode && preferences.get("useLocalWhisper") === "true")) return null;
      if (
        preferences.get("cloudTranscriptionProvider") !== "custom" ||
        preferences.get("cloudTranscriptionMode") !== "byok"
      )
        return null;
      const baseUrl =
        (selfHosted ? preferences.get("remoteTranscriptionUrl") : null) ||
        preferences.get("cloudTranscriptionBaseUrl") ||
        "";
      const model =
        (selfHosted ? preferences.get("remoteTranscriptionModel") : null) ||
        preferences.get("cloudTranscriptionModel") ||
        "whisper-1";
      const endpoint = yield* Effect.try(() => {
        const url = new URL(baseUrl);
        if (
          (url.protocol !== "https:" && url.protocol !== "http:") ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error("Invalid cloud endpoint");
        const pathname = url.pathname.replace(/\/+$/, "");
        url.pathname = pathname.endsWith("/audio/transcriptions")
          ? pathname
          : `${pathname}/audio/transcriptions`;
        return url.toString();
      }).pipe(Effect.mapError(() => new OpenWhisprConfigurationError({ reason: "settings" })));
      const language = preferences.get("preferredLanguage")?.split("-")[0];
      return {
        endpoint,
        model: model.trim() || "whisper-1",
        apiKey: yield* readKey(preferences),
        ...(language && language !== "auto" ? { language } : {}),
      };
    }),
  });
});

export const layer = Layer.effect(OpenWhisprConfiguration, make);
