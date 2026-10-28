import * as Workers from "@alchemy.run/cloudflare/Workers";
import { Request } from "@alchemy.run/cloudflare/Workers";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { makeWithTransaction } from "effect/sql/SqlClient";
import { canaryProbeResponse } from "../src/ownedConnectDriverCanary.ts";

/** Offline-only bridge fixture: installed coordinator controls, no database or socket. */
export const deadlineFixtureProps = {
  main: import.meta.url,
  name: "arcwright-offline-driver-deadline",
  compatibility: { date: "2026-09-18", flags: [] },
} satisfies Workers.WorkerProps;

class DeadlineFixtureRollback extends Schema.TaggedError<DeadlineFixtureRollback>()(
  "DeadlineFixtureRollback",
  {},
) {}
class DeadlineFixture extends Workers.Worker<
  DeadlineFixture,
  {
    fetch: Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      never,
      Request | Workers.WorkerExecutionContext | RuntimeContext
    >;
  }
>()("OwnedConnectDriverDeadlineFixture") {}

export default DeadlineFixture.make(
  deadlineFixtureProps,
  Effect.sync(() => {
    const completed: string[] = [];
    const finalized: string[] = [];
    const phases = ["begin", "commit", "rollback", "scope-finalizer"] as const;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* Request;
        const phase = new URL(request.url).pathname.slice(1);
        if (request.method === "GET" && phase === "status")
          return HttpServerResponse.jsonUnsafe({ completed, finalized });
        if (request.method !== "POST" || !phases.some((knownPhase) => knownPhase === phase))
          return HttpServerResponse.empty({ status: 404 });
        const stall = Effect.sleep("17 seconds").pipe(
          Effect.andThen(
            Effect.sync(() => {
              completed.push(phase);
            }),
          ),
        );
        const transaction = makeWithTransaction({
          transactionService: Context.Service<readonly [{ readonly fixture: true }, number]>(
            `deadline-workerd-${phase}`,
          ),
          spanAttributes: [],
          acquireConnection: Effect.succeed([undefined, { fixture: true }]),
          begin: () => (phase === "begin" ? stall : Effect.void),
          commit: () => (phase === "commit" ? stall : Effect.void),
          rollback: () => (phase === "rollback" ? stall : Effect.void),
          savepoint: () => Effect.void,
          rollbackSavepoint: () => Effect.void,
        });
        const probe =
          phase === "scope-finalizer"
            ? Effect.acquireRelease(Effect.succeed({ fixture: true }), () => stall)
            : transaction(
                phase === "rollback"
                  ? Effect.fail(new DeadlineFixtureRollback())
                  : Effect.succeed({ fixture: true }),
              );
        return yield* canaryProbeResponse(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                finalized.push(phase);
              }).pipe(
                Effect.andThen(
                  Effect.suspend(() =>
                    finalized.length === phases.length
                      ? Effect.logInfo("ARCWRIGHT_DEADLINE_FIXTURE_CLEANUP_DONE")
                      : Effect.void,
                  ),
                ),
              ),
            );
            return yield* probe;
          }),
        );
      }),
    };
  }),
);
