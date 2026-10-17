import {
  OPENWHISPR_MAX_AUDIO_BYTES,
  OPENWHISPR_TIMEOUT_MS,
  OpenWhisprTranscriptionError,
  type OpenWhisprStatus,
} from "@t3tools/contracts";
import { HomeDirectory } from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import {
  applyOpenWhisprLibrary,
  isOpenWhisprDictionaryEcho,
  openWhisprDictionaryPrompt,
  type OpenWhisprLibrary,
} from "./openwhisprLibrary.ts";
import * as OpenWhisprConfiguration from "./OpenWhisprConfiguration.ts";

const isTranscriptionError = Schema.is(OpenWhisprTranscriptionError);
interface LibraryBridge {
  readonly port: number;
  readonly token: string;
}

export class OpenWhispr extends Context.Service<
  OpenWhispr,
  {
    readonly status: Effect.Effect<OpenWhisprStatus>;
    readonly transcribe: (
      audio: Uint8Array,
    ) => Effect.Effect<{ readonly text: string }, OpenWhisprTranscriptionError>;
  }
>()("t3/voice/OpenWhispr") {}

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HomeDirectory;
  const configuration = yield* OpenWhisprConfiguration.OpenWhisprConfiguration;
  const bridgeFile = path.join(home, ".openwhispr", "cli-bridge.json");
  const bridgeSchema = Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Literal(1),
      port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
      token: Schema.NonEmptyString,
    }),
  );
  const modelsSchema = Schema.Struct({
    data: Schema.Array(
      Schema.Struct({
        model: Schema.String,
        default: Schema.Boolean,
        downloaded: Schema.Boolean,
      }),
    ),
  });
  type Backend =
    | { status: "ready"; backend: "desktop"; port: number; token: string }
    | { status: "ready"; backend: "whisper"; port: number; libraryBridge?: LibraryBridge }
    | ({
        status: "ready";
        backend: "cloud";
        libraryBridge?: LibraryBridge;
      } & OpenWhisprConfiguration.OpenWhisprCloudConfiguration)
    | {
        status:
          | "unavailable"
          | "upgrade_required"
          | "model_required"
          | "cloud_configuration_required";
      };

  // Discovery sends no audio. Never accept a host/URL from the bridge file or expose its token.
  const discover: Effect.Effect<Backend> = Effect.gen(function* () {
    const bridge = yield* fs
      .readFileString(bridgeFile)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(bridgeSchema)), Effect.option);
    const cloud = yield* configuration.current.pipe(
      Effect.match({
        onFailure: (): Backend => ({ status: "cloud_configuration_required" }),
        onSuccess: (config): Backend | null =>
          config
            ? {
                ...config,
                status: "ready",
                backend: "cloud",
                ...(Option.isSome(bridge) ? { libraryBridge: bridge.value } : {}),
              }
            : null,
      }),
    );
    if (cloud) return cloud;
    let unavailable: Backend = { status: "unavailable" };
    if (Option.isSome(bridge)) {
      const { port, token } = bridge.value;
      const models = yield* httpClient
        .execute(
          HttpClientRequest.get(`http://127.0.0.1:${port}/v1/transcribe/models`).pipe(
            HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
          ),
        )
        .pipe(
          Effect.flatMap((response) =>
            response.status === 404
              ? Effect.succeed<Backend>({ status: "upgrade_required" })
              : HttpClientResponse.filterStatusOk(response).pipe(
                  Effect.flatMap(HttpClientResponse.schemaBodyJson(modelsSchema)),
                  Effect.map((result): Backend =>
                    result.data.some((model) => model.default && model.downloaded)
                      ? ({ status: "ready", backend: "desktop", port, token } as const)
                      : ({ status: "model_required" } as const),
                  ),
                ),
          ),
          Effect.timeoutOption(1_500),
          Effect.orElseSucceed(() => Option.none()),
        );
      if (Option.isSome(models)) {
        if (models.value.status === "ready") return models.value;
        unavailable = models.value;
      }
    }
    // Older OpenWhispr whisper.cpp instances choose any free port in this range.
    const ports = yield* Effect.forEach(
      Array.from({ length: 22 }, (_, i) => 8178 + i),
      (port) =>
        httpClient.execute(HttpClientRequest.get(`http://127.0.0.1:${port}/health`)).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(
            HttpClientResponse.schemaBodyJson(Schema.Struct({ status: Schema.Literal("ok") })),
          ),
          Effect.as(port),
          Effect.timeoutOption(400),
          Effect.orElseSucceed(() => Option.none()),
        ),
      { concurrency: 4 },
    );
    const port = ports.find(Option.isSome);
    return port
      ? ({
          status: "ready",
          backend: "whisper",
          port: port.value,
          ...(Option.isSome(bridge) ? { libraryBridge: bridge.value } : {}),
        } as const)
      : unavailable;
  });

  const dictionarySchema = Schema.Struct({ data: Schema.Array(Schema.String) });
  const snippetsSchema = Schema.Struct({
    data: Schema.Array(
      Schema.Struct({
        trigger: Schema.String,
        replacement: Schema.String,
      }),
    ),
  });
  const readLibrary = (bridge: LibraryBridge | undefined): Effect.Effect<OpenWhisprLibrary> => {
    if (!bridge) return Effect.succeed({ words: [], snippets: [] });
    const get = (route: string) =>
      httpClient
        .execute(
          HttpClientRequest.get(`http://127.0.0.1:${bridge.port}/v1/${route}/list`).pipe(
            HttpClientRequest.setHeader("authorization", `Bearer ${bridge.token}`),
          ),
        )
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
    // Read current app data each time. Missing/older optional routes must not break recording.
    return Effect.all(
      {
        words: get("dictionary").pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(dictionarySchema)),
          Effect.map((value) => value.data),
          Effect.timeoutOption(1_500),
          Effect.map(Option.getOrElse(() => [])),
          Effect.orElseSucceed(() => []),
        ),
        snippets: get("snippets").pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(snippetsSchema)),
          Effect.map((value) => value.data),
          Effect.timeoutOption(1_500),
          Effect.map(Option.getOrElse(() => [])),
          Effect.orElseSucceed(() => []),
        ),
      },
      { concurrency: 2 },
    );
  };

  return OpenWhispr.of({
    status: discover.pipe(
      Effect.map((result): OpenWhisprStatus =>
        result.status === "ready"
          ? result.backend === "cloud"
            ? // Keep the native OpenWhispr backend discriminator understood by older paired clients.
              { status: "ready", backend: "desktop", provider: "custom-cloud" }
            : { status: "ready", backend: result.backend }
          : { status: result.status },
      ),
    ),
    transcribe: Effect.fn("OpenWhispr.transcribe")(
      function* (audio) {
        if (audio.byteLength <= 44 || audio.byteLength > OPENWHISPR_MAX_AUDIO_BYTES) {
          return yield* new OpenWhisprTranscriptionError({ reason: "invalid_audio" });
        }
        const backend = yield* discover;
        if (backend.status !== "ready") {
          return yield* new OpenWhisprTranscriptionError({ reason: backend.status });
        }
        const library = yield* readLibrary(
          backend.backend === "desktop" ? backend : backend.libraryBridge,
        );
        const finish = (text: string) => ({
          text: text.trim() === "[BLANK_AUDIO]" ? "" : applyOpenWhisprLibrary(text.trim(), library),
        });
        if (backend.backend === "desktop") {
          // The public desktop bridge accepts a local file path, not uploaded audio.
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const directory = yield* fs.makeTempDirectoryScoped({
                prefix: "arcwright-dictation-",
              });
              yield* fs.chmod(directory, 0o700);
              const file = path.join(directory, "dictation.wav");
              yield* fs.writeFile(file, audio, { mode: 0o600 });
              const request = yield* HttpClientRequest.bodyJson(
                HttpClientRequest.post(`http://127.0.0.1:${backend.port}/v1/transcribe`).pipe(
                  HttpClientRequest.setHeader("authorization", `Bearer ${backend.token}`),
                ),
                { path: file },
              );
              const response = yield* httpClient.execute(request).pipe(
                Effect.flatMap(HttpClientResponse.filterStatusOk),
                Effect.mapError(() => new OpenWhisprTranscriptionError({ reason: "unavailable" })),
              );
              const result = yield* HttpClientResponse.schemaBodyJson(
                Schema.Struct({ data: Schema.Struct({ text: Schema.String }) }),
              )(response).pipe(
                Effect.mapError(
                  () => new OpenWhisprTranscriptionError({ reason: "invalid_response" }),
                ),
              );
              return finish(result.data.text);
            }),
          ).pipe(
            Effect.mapError((error) =>
              isTranscriptionError(error)
                ? error
                : new OpenWhisprTranscriptionError({ reason: "unavailable" }),
            ),
          );
        }
        const form = new FormData();
        form.append(
          "file",
          new Blob([new Uint8Array(audio)], { type: "audio/wav" }),
          "t3-voice.wav",
        );
        form.append("response_format", "json");
        if (backend.backend === "cloud") {
          form.append("model", backend.model);
          if (backend.language) form.append("language", backend.language);
        }
        const prompt = openWhisprDictionaryPrompt(library);
        if (prompt) form.append("prompt", prompt);
        const infer = () =>
          httpClient
            .execute(
              HttpClientRequest.post(
                backend.backend === "cloud"
                  ? backend.endpoint
                  : `http://127.0.0.1:${backend.port}/inference`,
              ).pipe(
                HttpClientRequest.setHeaders(
                  backend.backend === "cloud" && backend.apiKey.length > 0
                    ? { authorization: `Bearer ${backend.apiKey}` }
                    : {},
                ),
                HttpClientRequest.bodyFormData(form),
              ),
            )
            .pipe(
              Effect.flatMap(HttpClientResponse.filterStatusOk),
              Effect.mapError(
                () =>
                  new OpenWhisprTranscriptionError({
                    reason: backend.backend === "cloud" ? "cloud_request_failed" : "unavailable",
                  }),
              ),
              Effect.flatMap((response) =>
                HttpClientResponse.schemaBodyJson(Schema.Struct({ text: Schema.String }))(
                  response,
                ).pipe(
                  Effect.mapError(
                    () => new OpenWhisprTranscriptionError({ reason: "invalid_response" }),
                  ),
                ),
              ),
            );
        let result = yield* infer();
        if (prompt && isOpenWhisprDictionaryEcho(result.text, prompt)) {
          form.delete("prompt");
          result = yield* infer();
        }
        return finish(result.text);
      },
      Effect.timeoutOrElse({
        duration: OPENWHISPR_TIMEOUT_MS,
        orElse: () => Effect.fail(new OpenWhisprTranscriptionError({ reason: "timeout" })),
      }),
    ),
  });
});

export const layer = Layer.effect(OpenWhispr, make);
