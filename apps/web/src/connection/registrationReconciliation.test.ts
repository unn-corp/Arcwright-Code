import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { registrationReconciliation } from "./registrationReconciliation";

it.effect("stays idle with push, wakes at credential/retry deadlines, and cleans up", () =>
  Effect.gen(function* () {
    let wake!: () => void;
    let disposed = false;
    let builds = 0;
    let delay: number | undefined;
    const results = yield* Queue.unbounded<number>();
    const fiber = yield* registrationReconciliation({
      build: Effect.sync(() => ++builds),
      nextDelay: Effect.sync(() => delay),
      subscribe: (notify) => {
        wake = notify;
        return () => {
          disposed = true;
        };
      },
    }).pipe(
      Stream.runForEach((value) => Queue.offer(results, value)),
      Effect.forkChild,
    );
    assert.equal(yield* Queue.take(results), 1);
    yield* TestClock.adjust("60 seconds");
    assert.equal(builds, 1);
    delay = 30_000;
    wake();
    assert.equal(yield* Queue.take(results), 2);
    yield* TestClock.adjust("29 seconds");
    assert.equal(builds, 2);
    delay = 3_000;
    yield* TestClock.adjust("1 second");
    assert.equal(yield* Queue.take(results), 3);
    delay = undefined;
    yield* TestClock.adjust("3 seconds");
    assert.equal(yield* Queue.take(results), 4);
    yield* Fiber.interrupt(fiber);
    assert.equal(disposed, true);
    wake();
    yield* TestClock.adjust("60 seconds");
    assert.equal(builds, 4);
  }),
);
it.effect("coalesces events during an in-flight read and reconciles again without overlap", () =>
  Effect.gen(function* () {
    let wake!: () => void;
    let builds = 0;
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const results = yield* Queue.unbounded<number>();
    const fiber = yield* registrationReconciliation({
      build: Effect.gen(function* () {
        const value = ++builds;
        if (value === 1) {
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
        }
        return value;
      }),
      nextDelay: Effect.sync(() => undefined),
      subscribe: (notify) => {
        wake = notify;
        return () => {};
      },
    }).pipe(
      Stream.runForEach((value) => Queue.offer(results, value)),
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    for (let n = 0; n < 100; n++) wake();
    assert.equal(builds, 1);
    yield* Deferred.succeed(release, undefined);
    yield* Queue.take(results);
    yield* TestClock.adjust("0 seconds");
    assert.equal(builds, 2);
    yield* Fiber.interrupt(fiber);
  }),
);
