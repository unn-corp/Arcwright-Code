// @effect-diagnostics nodeBuiltinImport:off - The fixture's fetch callback inspects the WAV supplied to the external desktop bridge.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { HomeDirectory, Platform } from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import * as NodeFSP from "node:fs/promises";
import * as OpenWhispr from "./OpenWhispr.ts";

const audio = new Uint8Array(48);
const models = { data: [{ model: "parakeet-v3", default: true, downloaded: true }] };
const noRoute = () => new Response(null, { status: 404 });
const bridge = { version: 1, port: 8207, token: "fixture-local-token" };
const decodeAudioPath = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ path: Schema.String })),
);

function audioPathFromBody(body: unknown): string {
  const json =
    typeof body === "string"
      ? body
      : body instanceof Uint8Array
        ? new TextDecoder().decode(body)
        : undefined;
  return decodeAudioPath(json).path;
}

function withBridge<E>(
  fetchFn: typeof fetch,
  run: Effect.Effect<void, E, OpenWhispr.OpenWhispr | FileSystem.FileSystem>,
  manifest: unknown = bridge,
  httpClient?: HttpClient.HttpClient,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "arcwright-openwhispr-test-" });
    yield* fs.makeDirectory(path.join(home, ".openwhispr"));
    yield* fs.writeFileString(
      path.join(home, ".openwhispr", "cli-bridge.json"),
      JSON.stringify(manifest),
    );
    yield* run.pipe(
      Effect.provide(
        OpenWhispr.layer.pipe(
          Layer.provide(
            httpClient
              ? Layer.succeed(HttpClient.HttpClient, httpClient)
              : FetchHttpClient.layer.pipe(
                  Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn)),
                ),
          ),
          Layer.provide(NodeServices.layer),
          Layer.provide(Layer.succeed(HomeDirectory, home)),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer));
}

it.effect(
  "discovers the desktop bridge and transcribes a private, temporary WAV with its default model",
  () =>
    Effect.gen(function* () {
      const platform = yield* Platform;
      let audioPath = "";
      yield* withBridge(
        async (url, options) => {
          expect(String(url).startsWith("http://127.0.0.1:8207/")).toBe(true);
          expect(new Headers(options?.headers).get("authorization")).toBe(`Bearer ${bridge.token}`);
          if (String(url).endsWith("/models")) return Response.json(models);
          expect(String(url)).toBe("http://127.0.0.1:8207/v1/transcribe");
          audioPath = audioPathFromBody(options?.body);
          expect(new Uint8Array(await NodeFSP.readFile(audioPath))).toEqual(audio);
          if (platform !== "win32")
            expect((await NodeFSP.stat(audioPath)).mode & 0o777).toBe(0o600);
          return Response.json({ data: { text: "  detected correctly  " } });
        },
        Effect.gen(function* () {
          const service = yield* OpenWhispr.OpenWhispr;
          const status = yield* service.status;
          expect(status).toEqual({ status: "ready", backend: "desktop" });
          expect(JSON.stringify(status)).not.toContain(bridge.token);
          expect(yield* service.transcribe(audio)).toEqual({ text: "detected correctly" });
          expect(yield* (yield* FileSystem.FileSystem).exists(audioPath)).toBe(false);
        }),
      );
    }),
);

it.effect("cleans up temporary audio after a failed desktop transcription", () => {
  let audioPath = "";
  return withBridge(
    async (url, options) => {
      if (String(url).endsWith("/models")) return Response.json(models);
      audioPath = audioPathFromBody(options?.body);
      return new Response(null, { status: 500 });
    },
    Effect.gen(function* () {
      const service = yield* OpenWhispr.OpenWhispr;
      expect(yield* service.transcribe(audio).pipe(Effect.flip)).toMatchObject({
        reason: "unavailable",
      });
      expect(audioPath.length).toBeGreaterThan(0);
      expect(yield* (yield* FileSystem.FileSystem).exists(audioPath)).toBe(false);
    }),
  );
});

it.effect("aborts the desktop request and removes its temporary WAV when cancelled", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<string>();
    let signal: AbortSignal | null | undefined;
    const client = HttpClient.make((request, _url, requestSignal) =>
      Effect.gen(function* () {
        if (request.method === "GET")
          return HttpClientResponse.fromWeb(request, Response.json(models));
        const file = audioPathFromBody(
          request.body._tag === "Uint8Array" ? request.body.body : undefined,
        );
        signal = requestSignal;
        yield* Deferred.succeed(started, file);
        return yield* Effect.never;
      }),
    );
    yield* withBridge(
      async () => {
        throw new Error("Unexpected fetch outside the HTTP fixture layer");
      },
      Effect.gen(function* () {
        const service = yield* OpenWhispr.OpenWhispr;
        const fs = yield* FileSystem.FileSystem;
        const request = yield* service.transcribe(audio).pipe(Effect.forkChild);
        const file = yield* Deferred.await(started);
        expect(yield* fs.exists(file)).toBe(true);
        yield* Fiber.interrupt(request);
        expect(signal?.aborted).toBe(true);
        expect(yield* fs.exists(file)).toBe(false);
      }),
      bridge,
      client,
    );
  }),
);

it.effect("identifies an older desktop bridge without sending audio", () =>
  withBridge(
    async (_url, options) => {
      expect(options?.method).toBe("GET");
      return noRoute();
    },
    Effect.gen(function* () {
      const service = yield* OpenWhispr.OpenWhispr;
      expect(yield* service.status).toEqual({ status: "upgrade_required" });
      expect(yield* service.transcribe(audio).pipe(Effect.flip)).toMatchObject({
        reason: "upgrade_required",
      });
    }),
  ),
);

it.effect("requires the configured model to be downloaded", () =>
  withBridge(
    async (url, options) => {
      expect(options?.method).toBe("GET");
      return String(url).endsWith("/models")
        ? Response.json({ data: [{ model: "whisper-large", default: true, downloaded: false }] })
        : noRoute();
    },
    Effect.gen(function* () {
      const service = yield* OpenWhispr.OpenWhispr;
      expect(yield* service.status).toEqual({ status: "model_required" });
    }),
  ),
);

it.effect("discovers a nondefault Whisper port when the bridge is stale", () =>
  withBridge(
    async (url, options) => {
      if (String(url).startsWith("http://127.0.0.1:8207/"))
        return new Response(null, { status: 401 });
      expect(new Headers(options?.headers).has("authorization")).toBe(false);
      if (String(url) === "http://127.0.0.1:8184/health") return Response.json({ status: "ok" });
      if (String(url) === "http://127.0.0.1:8184/inference")
        return Response.json({ text: "legacy works" });
      return noRoute();
    },
    Effect.gen(function* () {
      const service = yield* OpenWhispr.OpenWhispr;
      expect(yield* service.status).toEqual({ status: "ready", backend: "whisper" });
      expect(yield* service.transcribe(audio)).toEqual({ text: "legacy works" });
    }),
  ),
);

it.effect("rejects an invalid bridge port and unrelated HTTP services", () =>
  withBridge(
    async (url, options) => {
      expect(new URL(String(url)).hostname).toBe("127.0.0.1");
      expect(options?.method).toBe("GET");
      expect(new Headers(options?.headers).has("authorization")).toBe(false);
      return Response.json({ message: "some other service" });
    },
    Effect.gen(function* () {
      const service = yield* OpenWhispr.OpenWhispr;
      expect(yield* service.status).toEqual({ status: "unavailable" });
    }),
    { ...bridge, port: 70_000, url: "https://untrusted.example" },
  ),
);
