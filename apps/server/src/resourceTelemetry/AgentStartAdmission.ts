import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as HostResources from "./HostResources.ts";

/** Production installs host admission; isolated domain tests do not sample the host. */
export const AgentStartAdmission = Context.Reference<{
  readonly canStart: Effect.Effect<boolean>;
}>("t3/resourceTelemetry/AgentStartAdmission", {
  defaultValue: () => ({ canStart: Effect.succeed(true) }),
});

const make = Effect.gen(function* () {
  const resources = yield* HostResources.HostResources;
  const held = yield* Ref.make(false);
  return {
    canStart: Effect.gen(function* () {
      // HostResources shares a five-second cache with host diagnostics. There is
      // no process scan or permanent sampling loop for idle environments.
      const snapshot = yield* resources.read;
      const total = snapshot.totalMemoryBytes;
      const available = snapshot.availableMemoryBytes;
      const valid =
        Number.isFinite(total) && total > 0 && Number.isFinite(available) && available >= 0;
      const reserve = Math.min(8 * 1024 ** 3, Math.max(512 * 1024 ** 2, total * 0.1));
      const transition = yield* Ref.modify(held, (wasHeld) => {
        // Hysteresis avoids repeatedly launching and holding near the boundary.
        const isHeld = !valid || available < reserve * (wasHeld ? 1.25 : 1);
        return [{ changed: isHeld !== wasHeld, isHeld }, isHeld] as const;
      });
      if (transition.changed) {
        yield* (transition.isHeld ? Effect.logWarning : Effect.logInfo)(
          transition.isHeld
            ? "Holding new agent starts until host memory recovers"
            : "Resuming agent starts after host memory recovered",
          { availableMemoryBytes: available, totalMemoryBytes: total, reserveMemoryBytes: reserve },
        );
      }
      return !transition.isHeld;
    }),
  };
});

export const layer = Layer.effect(AgentStartAdmission, make);
