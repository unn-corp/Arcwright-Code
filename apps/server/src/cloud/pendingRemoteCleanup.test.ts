import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import {
  readPendingRemoteCleanup,
  rememberPendingRemoteCleanup,
  clearMatchingPendingRemoteCleanup,
} from "./pendingRemoteCleanup.ts";
const fixture = ServerConfig.layerTest("/", { prefix: "t3-connect-pending-cleanup-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.effect(
  "durably deduplicates public reminders and clears only the matching service/environment",
  () =>
    Effect.gen(function* () {
      const first = { relayUrl: "https://old.example.test/", environmentId: "env-one" };
      yield* rememberPendingRemoteCleanup(first);
      yield* rememberPendingRemoteCleanup({ ...first, environmentId: "env-two" });
      yield* rememberPendingRemoteCleanup({
        relayUrl: "https://other.example.test",
        environmentId: "env-one",
      });
      yield* rememberPendingRemoteCleanup(first);
      const read = yield* readPendingRemoteCleanup;
      assert.equal(read.length, 3);
      assert.deepEqual(Object.keys(read[0]!).sort(), [
        "environmentId",
        "relayOrigin",
        "status",
        "unlinkedAt",
      ]);
      yield* clearMatchingPendingRemoteCleanup(first);
      const remaining = yield* readPendingRemoteCleanup;
      assert.equal(remaining.length, 2);
      assert.isTrue(remaining.some((value) => value.environmentId === "env-two"));
      assert.isTrue(remaining.some((value) => value.relayOrigin === "https://other.example.test"));
    }).pipe(Effect.provide(fixture)),
);

it.effect("refuses a seventeenth reminder without discarding any existing cleanup reference", () =>
  Effect.gen(function* () {
    for (let index = 0; index < 16; index++)
      yield* rememberPendingRemoteCleanup({
        relayUrl: `https://old${index}.example.test`,
        environmentId: "env-one",
      });
    const error = yield* Effect.flip(
      rememberPendingRemoteCleanup({
        relayUrl: "https://seventeenth.example.test",
        environmentId: "env-one",
      }),
    );
    assert.equal(error._tag, "PendingRemoteCleanupError");
    assert.equal((yield* readPendingRemoteCleanup).length, 16);
  }).pipe(Effect.provide(fixture)),
);

it.effect("refuses oversized public state before another cleanup reference is written", () =>
  Effect.gen(function* () {
    yield* rememberPendingRemoteCleanup({
      relayUrl: "https://old.example.test",
      environmentId: "env-one",
    });
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const filePath = path.join(
      path.dirname(config.serverRuntimeStatePath),
      "connect-pending-remote-cleanup.json",
    );
    const oversized = " ".repeat(8193);
    yield* fs.writeFileString(filePath, oversized);
    const error = yield* Effect.flip(
      rememberPendingRemoteCleanup({
        relayUrl: "https://next.example.test",
        environmentId: "env-one",
      }),
    );
    assert.equal(error._tag, "PendingRemoteCleanupError");
    assert.equal(yield* fs.readFileString(filePath), oversized);
  }).pipe(Effect.provide(fixture)),
);
