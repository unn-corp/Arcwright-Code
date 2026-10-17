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

const isTranscriptionError = Schema.is(OpenWhisprTranscriptionError);

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
    | { status: "ready"; backend: "whisper"; port: number }
    | { status: "unavailable" | "upgrade_required" | "model_required" };

  // Discovery sends no audio. Never accept a host/URL from the bridge file or expose its token.
  const discover: Effect.Effect<Backend> = Effect.gen(function* () {
    const bridge = yield* fs
      .readFileString(bridgeFile)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(bridgeSchema)), Effect.option);
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
      ? ({ status: "ready", backend: "whisper", port: port.value } as const)
      : unavailable;
  });

  return OpenWhispr.of({
    status: discover.pipe(
      Effect.map((result): OpenWhisprStatus =>
        result.status === "ready"
          ? { status: "ready", backend: result.backend }
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
              return {
                text: result.data.text.trim() === "[BLANK_AUDIO]" ? "" : result.data.text.trim(),
              };
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
        const response = yield* httpClient
          .execute(
            HttpClientRequest.post(`http://127.0.0.1:${backend.port}/inference`).pipe(
              HttpClientRequest.bodyFormData(form),
            ),
          )
          .pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.mapError(() => new OpenWhisprTranscriptionError({ reason: "unavailable" })),
          );
        const result = yield* HttpClientResponse.schemaBodyJson(
          Schema.Struct({ text: Schema.String }),
        )(response).pipe(
          Effect.mapError(() => new OpenWhisprTranscriptionError({ reason: "invalid_response" })),
        );
        const text = result.text.trim();
        return { text: text === "[BLANK_AUDIO]" ? "" : text };
      },
      Effect.timeoutOrElse({
        duration: OPENWHISPR_TIMEOUT_MS,
        orElse: () => Effect.fail(new OpenWhisprTranscriptionError({ reason: "timeout" })),
      }),
    ),
  });
});

export const layer = Layer.effect(OpenWhispr, make);
