import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RunAttemptId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as AgentStartAdmission from "../resourceTelemetry/AgentStartAdmission.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";

const layer = EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory));

it.effect("keeps four workers available under memory pressure and resumes 20 agents", () =>
  Effect.gen(function* () {
    const available = yield* Ref.make(4 * 1024 ** 3);
    const accepted = yield* Ref.make<ReadonlyArray<string>>([]);
    const layerMemory = AgentStartAdmission.layer.pipe(
      Layer.provide(
        Layer.succeed(HostResources.HostResources, {
          read: Ref.get(available).pipe(
            Effect.map((availableMemoryBytes) => ({
              sampledAt: 0,
              cpuCount: 16,
              cpuUtilization: 1,
              totalMemoryBytes: 64 * 1024 ** 3,
              availableMemoryBytes,
            })),
          ),
        }),
      ),
    );
    const layerWorker = EffectWorker.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          layer,
          layerMemory,
          Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, {
            execute: (effect) => Ref.update(accepted, (ids) => [...ids, effect.id]),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* outbox.enqueue(
        Array.from({ length: 20 }, (_, index) => ({
          id: `start:${index}`,
          commandId: CommandId.make(`command:${index}`),
          threadId: ThreadId.make(`thread:${index}`),
          request: { type: "provider-turn.start" as const, runId: RunId.make(`run:${index}`) },
        })),
      );
      assert.deepEqual(
        yield* Effect.all(
          Array.from({ length: 4 }, () => worker.runOnce),
          { concurrency: 4 },
        ),
        [false, false, false, false],
      );
      assert.isEmpty(yield* Ref.get(accepted));
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const next = yield* worker.nextClaimableAt;
      assert.isTrue(Option.isSome(next));
      if (Option.isSome(next)) assert.equal(DateTime.toEpochMillis(next.value) - now, 5_000);
      yield* outbox.enqueue([
        {
          id: "stop",
          commandId: CommandId.make("command:stop"),
          threadId: ThreadId.make("thread:running"),
          availableAt: DateTime.add(yield* DateTime.now, { milliseconds: 1_000 }),
          request: {
            type: "provider-turn.interrupt",
            providerSessionId: ProviderSessionId.make("session"),
            providerThreadId: ProviderThreadId.make("provider-thread"),
            providerTurnId: ProviderTurnId.make("turn"),
          },
        },
      ]);
      assert.isFalse(yield* worker.runOnce);
      const nextControl = yield* worker.nextClaimableAt;
      assert.isTrue(Option.isSome(nextControl));
      if (Option.isSome(nextControl)) {
        assert.equal(DateTime.toEpochMillis(nextControl.value) - now, 1_000);
      }
      yield* TestClock.adjust("1 second");
      assert.isTrue(yield* worker.runOnce);
      assert.deepEqual(yield* Ref.get(accepted), ["stop"]);
      yield* Ref.set(available, 12 * 1024 ** 3);
      assert.equal(yield* worker.drain(), 20);
      assert.equal((yield* Ref.get(accepted)).length, 21);
    }).pipe(Effect.provide(Layer.fresh(layerWorker)));
  }),
);

it.effect("holds restarts and continuations while allowing recovery cleanup", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const commandId = CommandId.make("command:recovery");
    yield* outbox.enqueue([
      {
        id: "continue",
        commandId,
        threadId: ThreadId.make("thread:continue"),
        request: { type: "provider-runtime.continue", sourceRunId: RunId.make("run:continue") },
      },
      {
        id: "cleanup",
        commandId,
        threadId: ThreadId.make("thread:continue"),
        request: { type: "terminal.cleanup" },
      },
      {
        id: "restart",
        commandId,
        threadId: ThreadId.make("thread:restart"),
        request: {
          type: "provider-turn.restart",
          runId: RunId.make("run:restart"),
          interruptedAttemptId: RunAttemptId.make("attempt"),
          providerSessionId: ProviderSessionId.make("session"),
          providerThreadId: ProviderThreadId.make("provider-thread"),
          providerTurnId: ProviderTurnId.make("turn"),
        },
      },
    ]);
    const claim = { workerId: "memory-test", leaseDurationMs: 30_000, excludeProviderStarts: true };
    const cleanup = yield* outbox.claimNext(claim);
    assert.isTrue(Option.isSome(cleanup));
    if (Option.isNone(cleanup)) return;
    assert.equal(cleanup.value.id, "cleanup");
    yield* outbox.succeed({ effectId: cleanup.value.id, workerId: claim.workerId });
    assert.isTrue(Option.isNone(yield* outbox.claimNext(claim)));
    for (const id of ["continue", "restart"]) {
      const pending = yield* outbox.get(id);
      assert.isTrue(Option.isSome(pending));
      if (Option.isSome(pending)) assert.equal(pending.value.attemptCount, 0);
    }
  }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect("holds 20 starts durably without spending attempts, then admits all 20", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const effects = Array.from({ length: 20 }, (_, index) => ({
      id: `start:${index}`,
      commandId: CommandId.make(`command:${index}`),
      threadId: ThreadId.make(`thread:${index}`),
      request: { type: "provider-turn.start" as const, runId: RunId.make(`run:${index}`) },
    }));
    yield* outbox.enqueue(effects);
    const claim = { workerId: "memory-test", leaseDurationMs: 30_000 };
    assert.isTrue(
      Option.isNone(yield* outbox.claimNext({ ...claim, excludeProviderStarts: true })),
    );
    for (const effect of effects) {
      const stored = yield* outbox.get(effect.id);
      assert.isTrue(Option.isSome(stored));
      if (Option.isNone(stored)) return;
      assert.equal(stored.value.status, "pending");
      assert.equal(stored.value.attemptCount, 0);
    }
    const started = new Set<string>();
    for (let index = 0; index < 20; index++) {
      const next = yield* outbox.claimNext(claim);
      assert.isTrue(Option.isSome(next));
      if (Option.isNone(next)) return;
      started.add(next.value.id);
      yield* outbox.succeed({ effectId: next.value.id, workerId: claim.workerId });
    }
    assert.equal(started.size, 20);
  }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect("still handles cleanup and cancellation while starts are held", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const threadId = ThreadId.make("thread:held");
    const commandId = CommandId.make("command:held");
    yield* outbox.enqueue([
      {
        id: "held",
        commandId,
        threadId,
        request: { type: "provider-turn.start", runId: RunId.make("run:held") },
      },
      { id: "after-held", commandId, threadId, request: { type: "terminal.cleanup" } },
      {
        id: "other",
        commandId,
        threadId: ThreadId.make("thread:other"),
        request: { type: "terminal.cleanup" },
      },
    ]);
    const claim = { workerId: "memory-test", leaseDurationMs: 30_000, excludeProviderStarts: true };
    const other = yield* outbox.claimNext(claim);
    assert.isTrue(Option.isSome(other));
    if (Option.isNone(other)) return;
    assert.equal(other.value.id, "other");
    yield* outbox.succeed({ effectId: other.value.id, workerId: claim.workerId });
    // Preserve per-thread ordering until Stop cancels the pending start.
    assert.isTrue(Option.isNone(yield* outbox.claimNext(claim)));
    yield* outbox.cancelUnsettled({
      threadId,
      effectTypes: ["provider-turn.start"],
      reason: "Stopped before start",
    });
    const cleanup = yield* outbox.claimNext(claim);
    assert.isTrue(Option.isSome(cleanup));
    if (Option.isSome(cleanup)) assert.equal(cleanup.value.id, "after-held");
  }).pipe(Effect.provide(Layer.fresh(layer))),
);
