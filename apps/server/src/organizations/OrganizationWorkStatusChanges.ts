import {
  OrganizationWorkStatusSnapshot,
  type OrganizationId,
  type OrganizationWorkError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as SqlClient from "effect/sql/SqlClient";
import * as OrganizationWorkStatusRead from "./OrganizationWorkStatusRead.ts";

export class OrganizationWorkStatusChanges extends Context.Service<
  OrganizationWorkStatusChanges,
  {
    readonly changed: (id: OrganizationId) => Effect.Effect<void>;
    readonly watch: (
      id: OrganizationId,
    ) => Stream.Stream<OrganizationWorkStatusSnapshot, OrganizationWorkError>;
  }
>()("t3/organizations/OrganizationWorkStatusChanges") {}

const equivalent = Schema.toEquivalence(OrganizationWorkStatusSnapshot);

interface Topic {
  readonly bus: PubSub.PubSub<void>;
  readonly pending: Queue.Queue<void>;
  readonly worker: Fiber.Fiber<void>;
  readers: number;
}

export const layer = Layer.effect(
  OrganizationWorkStatusChanges,
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    // This context is captured at app construction, outside every mutation.
    const context = yield* Effect.context<SqlClient.SqlClient>();
    const read = (id: OrganizationId) =>
      OrganizationWorkStatusRead.read(id).pipe(Effect.provideContext(context));
    const lock = yield* Semaphore.make(1);
    const topics = new Map<OrganizationId, Topic>();
    return OrganizationWorkStatusChanges.of({
      changed: Effect.fn("OrganizationWorkStatusChanges.changed")((id) =>
        Effect.sync(() => {
          // This is only a request for commit verification. It never publishes an
          // invalidation from the producer's potentially nested SQL transaction.
          const topic = topics.get(id);
          if (topic) Queue.offerUnsafe(topic.pending, undefined);
        }),
      ),
      watch: (id) =>
        Stream.unwrap(
          lock.withPermits(1)(
            Effect.gen(function* () {
              let topic = topics.get(id);
              if (!topic) {
                const bus = yield* PubSub.sliding<void>(1);
                const pending = yield* Queue.sliding<void>(1);
                let previous: OrganizationWorkStatusSnapshot | undefined;
                const worker = yield* Effect.forever(
                  Effect.gen(function* () {
                    yield* Queue.take(pending);
                    const result = yield* Effect.exit(read(id));
                    // A rollback is indistinguishable from no mutation. Only persisted
                    // changes produce invalidations, after the outer transaction settles.
                    if (Exit.isSuccess(result)) {
                      if (previous && equivalent(previous, result.value)) return;
                      previous = result.value;
                    }
                    yield* PubSub.publish(bus, undefined);
                  }),
                ).pipe(Effect.forkIn(scope));
                topic = { bus, pending, worker, readers: 0 };
                topics.set(id, topic);
              }
              const current = topic;
              current.readers++;
              yield* Effect.addFinalizer(() =>
                Effect.gen(function* () {
                  if (--current.readers === 0 && topics.get(id) === current) {
                    topics.delete(id);
                    yield* Fiber.interrupt(current.worker);
                    yield* PubSub.shutdown(current.bus);
                    yield* Queue.shutdown(current.pending);
                  }
                }),
              );
              const subscription = yield* PubSub.subscribe(current.bus);
              // Subscribe before a fresh read. A concurrent commit is either included
              // in that read or arrives in the mailbox. Reconnect never replays a cache.
              return Stream.concat(
                Stream.fromEffect(read(id)),
                Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => read(id))),
              ).pipe(Stream.changesWith(equivalent));
            }),
          ),
        ),
    });
  }),
);

/** Optional for standalone callers without a status transport. The application
 * supplies one shared instance to all live work producers and WebSocket clients.
 */
export const changed = (id: OrganizationId) =>
  Effect.flatMap(
    Effect.serviceOption(OrganizationWorkStatusChanges),
    Option.match({ onNone: () => Effect.void, onSome: (service) => service.changed(id) }),
  );
