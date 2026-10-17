import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { HomeDirectory } from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpClient } from "effect/http";
import * as Configuration from "./OpenWhisprConfiguration.ts";
import * as OpenWhispr from "./OpenWhispr.ts";

const audio = new Uint8Array(48);
const cloud = {
  endpoint: "https://speech.example/v1/audio/transcriptions",
  model: "saved-model",
  apiKey: "saved-cloud-key",
  language: "en",
};
const layer = (
  fetch: typeof globalThis.fetch,
  current = Effect.succeed<Configuration.OpenWhisprCloudConfiguration | null>(cloud),
) =>
  OpenWhispr.layer.pipe(
    Layer.provide(Layer.succeed(Configuration.OpenWhisprConfiguration, { current })),
    Layer.provide(
      FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
    ),
    Layer.provide(NodeServices.layer),
    Layer.provide(Layer.succeed(HomeDirectory, "/missing/arcwright-cloud-dictation-fixture")),
  );

it.effect(
  "discovers the configured cloud model without local downloads, probes, or exposing its key",
  () =>
    Effect.gen(function* () {
      const voice = yield* OpenWhispr.OpenWhispr;
      expect(yield* voice.status).toEqual({
        status: "ready",
        backend: "desktop",
        provider: "custom-cloud",
      });
    }).pipe(
      Effect.provide(
        layer(async () => {
          throw new Error("Cloud discovery must send no audio or provider requests");
        }),
      ),
    ),
);
it.effect("uses OpenWhispr's saved endpoint, model, key, and language for multipart audio", () =>
  Effect.gen(function* () {
    const voice = yield* OpenWhispr.OpenWhispr;
    expect(yield* voice.transcribe(audio)).toEqual({ text: "cloud dictation" });
  }).pipe(
    Effect.provide(
      layer(async (url, init) => {
        expect(String(url)).toBe(cloud.endpoint);
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${cloud.apiKey}`);
        const form = init?.body;
        expect(form).toBeInstanceOf(FormData);
        if (form instanceof FormData) {
          expect(form.get("model")).toBe(cloud.model);
          expect(form.get("language")).toBe("en");
          const file = form.get("file");
          expect(file).toBeInstanceOf(Blob);
          if (file instanceof Blob) expect(new Uint8Array(await file.arrayBuffer())).toEqual(audio);
        }
        return Response.json({ text: "  cloud dictation  " });
      }),
    ),
  ),
);
it.effect("does not send audio or fall back to local when cloud credentials are unavailable", () =>
  Effect.gen(function* () {
    const voice = yield* OpenWhispr.OpenWhispr;
    expect(yield* voice.status).toEqual({ status: "cloud_configuration_required" });
    expect(yield* voice.transcribe(audio).pipe(Effect.flip)).toMatchObject({
      reason: "cloud_configuration_required",
    });
  }).pipe(
    Effect.provide(
      OpenWhispr.layer.pipe(
        Layer.provide(
          Layer.succeed(Configuration.OpenWhisprConfiguration, {
            current: Effect.fail(
              new Configuration.OpenWhisprConfigurationError({ reason: "credentials" }),
            ),
          }),
        ),
        Layer.provide(
          FetchHttpClient.layer.pipe(
            Layer.provide(
              Layer.succeed(FetchHttpClient.Fetch, async () => {
                throw new Error("Must not send audio");
              }),
            ),
          ),
        ),
        Layer.provide(NodeServices.layer),
        Layer.provide(Layer.succeed(HomeDirectory, "/missing/arcwright-cloud-dictation-fixture")),
      ),
    ),
  ),
);
it.effect("rejects a malformed cloud transcript", () =>
  Effect.gen(function* () {
    const voice = yield* OpenWhispr.OpenWhispr;
    expect(yield* voice.transcribe(audio).pipe(Effect.flip)).toMatchObject({
      reason: "invalid_response",
    });
  }).pipe(Effect.provide(layer(async () => Response.json({ text: 5 })))),
);
it.effect("reports cloud failure without exposing the key or switching providers", () => {
  let calls = 0;
  return Effect.gen(function* () {
    const voice = yield* OpenWhispr.OpenWhispr;
    const failure = yield* voice.transcribe(audio).pipe(Effect.flip);
    expect(failure.reason).toBe("cloud_request_failed");
    expect(failure.message).not.toContain(cloud.apiKey);
    expect(calls).toBe(1);
  }).pipe(
    Effect.provide(
      layer(async () => {
        calls++;
        return new Response(cloud.apiKey, { status: 401 });
      }),
    ),
  );
});
it.effect("honors the latest saved cloud model on each dictation", () => {
  let config = cloud,
    calls = 0;
  return Effect.gen(function* () {
    const voice = yield* OpenWhispr.OpenWhispr;
    yield* voice.transcribe(audio);
    config = { ...cloud, model: "second-model", apiKey: "second-key" };
    yield* voice.transcribe(audio);
    expect(calls).toBe(2);
  }).pipe(
    Effect.provide(
      layer(
        async (_url, init) => {
          calls++;
          expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${config.apiKey}`);
          expect(init?.body instanceof FormData && init.body.get("model")).toBe(config.model);
          return Response.json({ text: "updated" });
        },
        Effect.sync(() => config),
      ),
    ),
  );
});
it.effect("aborts a cloud upload when dictation is cancelled", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let signal: AbortSignal | undefined;
    const client = HttpClient.make((_request, _url, requestSignal) =>
      Effect.gen(function* () {
        signal = requestSignal;
        yield* Deferred.succeed(started, undefined);
        return yield* Effect.never;
      }),
    );
    yield* Effect.gen(function* () {
      const voice = yield* OpenWhispr.OpenWhispr,
        task = yield* voice.transcribe(audio).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(task);
      expect(signal?.aborted).toBe(true);
    }).pipe(
      Effect.provide(
        OpenWhispr.layer.pipe(
          Layer.provide(
            Layer.succeed(Configuration.OpenWhisprConfiguration, {
              current: Effect.succeed(cloud),
            }),
          ),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
          Layer.provide(NodeServices.layer),
          Layer.provide(Layer.succeed(HomeDirectory, "/missing/arcwright-cloud-dictation-fixture")),
        ),
      ),
    );
  }),
);
