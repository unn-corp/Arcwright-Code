import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

/** Reconcile serially on topology changes and credential/retry deadlines. */
export function registrationReconciliation<A>(options: {
  readonly build: Effect.Effect<A>;
  readonly nextDelay: Effect.Effect<number | undefined>;
  readonly subscribe: (wake: () => void) => () => void;
}): Stream.Stream<A> {
  return Stream.callback<A>(
    (mailbox) =>
      Effect.gen(function* () {
        const triggers = yield* Queue.sliding<void>(1);
        const wake = () => {
          Queue.offerUnsafe(triggers, undefined);
        };
        const cleanup = options.subscribe(wake);
        yield* Effect.addFinalizer(() => Effect.sync(cleanup));
        wake();
        let nextDelay: number | undefined;
        yield* Effect.forever(
          Effect.gen(function* () {
            yield* nextDelay === undefined
              ? Queue.take(triggers)
              : Queue.take(triggers).pipe(Effect.timeoutOption(nextDelay));
            Queue.offerUnsafe(mailbox, yield* options.build);
            nextDelay = yield* options.nextDelay;
          }),
        ).pipe(Effect.forkScoped);
      }),
    { bufferSize: 1, strategy: "sliding" },
  );
}
