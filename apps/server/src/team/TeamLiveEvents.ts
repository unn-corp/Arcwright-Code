import type { OrchestrationThreadStreamItem } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import {
  makeLiveStreamBudget,
  type RetainedLiveItem,
} from "../orchestration-v2/LiveStreamBudget.ts";

/** Teams has no tool updates to coalesce. Bound the complete retained delivery queue. */
export const makeTeamLiveEvents = Effect.fn("TeamLiveEvents.make")(function* () {
  const budget = yield* makeLiveStreamBudget();
  const queue = yield* Queue.unbounded<RetainedLiveItem<OrchestrationThreadStreamItem>>();
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      budget.release(yield* Queue.clear(queue).pipe(Effect.orDie));
      yield* Queue.shutdown(queue);
    }),
  );
  const offer = (item: OrchestrationThreadStreamItem) =>
    budget.retain(item).pipe(
      Effect.flatMap((retained) => Queue.offer(queue, retained)),
      Effect.asVoid,
    );
  return {
    offer,
    offerAll: (items: ReadonlyArray<OrchestrationThreadStreamItem>) =>
      Effect.forEach(items, offer, { discard: true }),
    failed: budget.failed,
    stream: budget.deliver(Stream.fromQueue(queue)),
  };
});
