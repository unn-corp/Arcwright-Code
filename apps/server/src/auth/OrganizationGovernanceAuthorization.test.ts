import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { requireInteractiveOrganizationSession } from "./OrganizationGovernanceAuthorization.ts";

describe("Organization governance session boundary", () => {
  it.effect("does not dispatch a mutation from a bearer or relay client", () =>
    Effect.gen(function* () {
      let dispatched = 0;
      const mutation = Effect.sync(() => ++dispatched);
      for (const method of ["bearer-access-token", "dpop-access-token"] as const) {
        const result = yield* Effect.flip(
          requireInteractiveOrganizationSession(
            { method, subject: "cli-issued-session" },
            mutation,
          ),
        );
        expect(result.code).toBe("forbidden");
      }
      expect(dispatched).toBe(0);
    }),
  );

  it.effect("allows a browser session to dispatch the mutation", () =>
    Effect.gen(function* () {
      let dispatched = 0;
      const result = yield* requireInteractiveOrganizationSession(
        { method: "browser-session-cookie", subject: "one-time-token" },
        Effect.sync(() => ++dispatched),
      );
      expect(result).toBe(1);
      expect(dispatched).toBe(1);
    }),
  );

  it.effect(
    "allows a trusted desktop bootstrap session, but not a relay token claiming that subject",
    () =>
      Effect.gen(function* () {
        let dispatched = 0;
        const mutation = Effect.sync(() => ++dispatched);
        expect(
          yield* requireInteractiveOrganizationSession(
            { method: "bearer-access-token", subject: "desktop-bootstrap" },
            mutation,
          ),
        ).toBe(1);
        const denied = yield* Effect.flip(
          requireInteractiveOrganizationSession(
            { method: "dpop-access-token", subject: "desktop-bootstrap" },
            mutation,
          ),
        );
        expect(denied.code).toBe("forbidden");
        expect(dispatched).toBe(1);
      }),
  );
});
