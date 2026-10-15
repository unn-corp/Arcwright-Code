import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as DesktopUpdates from "./DesktopUpdates.ts";
import { idleStatus, makeHarness, stagedStatus } from "./updatesTestHarness.ts";

describe("DesktopUpdates", () => {
  it.effect("follows the controller: its phases are the only update state", () => {
    const harness = makeHarness();
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        assert.equal((yield* updates.getState).status, "idle");

        yield* harness.publish(
          stagedStatus({
            blockers: [
              { participantId: "x", reason: "active-agents", label: "An agent is running." },
            ],
            installable: false,
          }),
        );
        const waiting = yield* updates.getState;
        // A staged build that cannot install yet says why; this view never decides.
        assert.equal(waiting.status, "downloaded");
        assert.equal(waiting.downloadedVersion, "1.2.4");
        assert.equal(waiting.message, "An agent is running.");

        yield* harness.publish(
          idleStatus({ phase: "failed", lastError: "The new version did not start." }),
        );
        const failed = yield* updates.getState;
        assert.equal(failed.status, "error");
        assert.equal(failed.errorContext, "install");
        assert.isAbove(harness.sentStates.length, 1);
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect("publishes every controller change to subscribers", () => {
    const harness = makeHarness();
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        const { latest, changes } = yield* updates.subscribe;
        assert.equal(latest.status, "idle");
        yield* harness.publish(
          idleStatus({ phase: "available", targetBuild: stagedStatus().targetBuild }),
        );
        const next = yield* changes.pipe(Stream.take(1), Stream.runCollect);
        assert.equal(next[0]?.status, "available");
        assert.equal(next[0]?.availableVersion, "1.2.4");
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect("installs only through the controller, bound to the staged build's digest", () => {
    const harness = makeHarness({ initial: stagedStatus() });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        const result = yield* updates.install;
        assert.equal(result.accepted, true);
        assert.deepEqual(harness.installs, ["b".repeat(64)]);
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "refuses to install when the controller says the build cannot install, and never reaches an installer",
    () => {
      const harness = makeHarness({
        initial: stagedStatus({
          installable: false,
          blockers: [{ participantId: "x", reason: "idle-window", label: "Waiting." }],
        }),
      });
      return Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          const direct = yield* updates.install;
          assert.deepEqual(
            { accepted: direct.accepted, completed: direct.completed },
            { accepted: false, completed: false },
          );
          const prepared = yield* updates.installPrepared("1.2.4");
          assert.equal(prepared.accepted, false);
          assert.deepEqual(harness.installs, []);
        }),
      ).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("refuses a prepared install whose version is no longer the staged one", () => {
    const harness = makeHarness({ initial: stagedStatus() });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        const result = yield* updates.installPrepared("1.2.5");
        assert.equal(result.accepted, false);
        assert.equal(result.failed, false);
        assert.deepEqual(harness.installs, []);
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect("reports a controller refusal as a failed install with its reason", () => {
    const harness = makeHarness({
      initial: stagedStatus(),
      installFailure: "Installation is blocked: an agent is running.",
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        const result = yield* updates.installPrepared("1.2.4");
        assert.equal(result.accepted, true);
        assert.equal(result.failed, true);
        assert.equal(result.state.message, "Installation is blocked: an agent is running.");
        assert.equal(result.state.errorContext, "install");
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect("checks through the controller and leaves staging to it", () => {
    const harness = makeHarness({ afterCheck: stagedStatus() });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        const checked = yield* updates.check("test");
        assert.equal(checked.checked, true);
        assert.equal(checked.state.status, "downloaded");
        assert.equal(harness.checks(), 1);
        const download = yield* updates.download;
        assert.deepEqual(
          { accepted: download.accepted, completed: download.completed },
          { accepted: true, completed: true },
        );
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "maps the channel choice to the controller's policy and reports a refusal as an action in progress",
    () => {
      const accepted = makeHarness();
      const refused = makeHarness({
        policyFailure: "Policy cannot change while an update is in progress.",
      });
      return Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const updates = yield* DesktopUpdates.DesktopUpdates;
            yield* updates.configure;
            const state = yield* updates.setChannel("nightly");
            assert.equal(state.channel, "nightly");
            assert.deepEqual(accepted.policies, [{ channel: "nightly" }]);
          }),
        ).pipe(Effect.provide(accepted.layer));
        const failure = yield* Effect.scoped(
          Effect.gen(function* () {
            const updates = yield* DesktopUpdates.DesktopUpdates;
            return yield* updates.setChannel("latest").pipe(Effect.flip);
          }),
        ).pipe(Effect.provide(refused.layer));
        assert.equal(failure._tag, "DesktopUpdateActionInProgressError");
      });
    },
  );

  it.effect("stays disabled with its reason when the installation cannot update in-product", () => {
    const harness = makeHarness({
      disabledReason: "Updates are only available in packaged production builds.",
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        const state = yield* updates.getState;
        assert.equal(state.enabled, false);
        assert.equal(state.status, "disabled");
        assert.equal(
          Option.getOrNull(yield* updates.disabledReason),
          "Updates are only available in packaged production builds.",
        );
        const checked = yield* updates.check("menu");
        assert.equal(checked.checked, false);
        assert.equal(harness.checks(), 0);
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect("tells a caller whether an action or an install is in flight", () => {
    const harness = makeHarness({ initial: stagedStatus({ phase: "installing" }) });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        assert.equal(yield* updates.isActionActive, true);
        assert.equal(yield* updates.isInstallActive, true);
        yield* harness.publish(stagedStatus({ phase: "staged" }));
        assert.equal(yield* updates.isActionActive, false);
      }),
    ).pipe(Effect.provide(harness.layer));
  });
});

describe("describeUpdateErrorCause", () => {
  it("preserves network and nested failure reasons", () => {
    const networkError = Object.assign(new Error("getaddrinfo ENOTFOUND updates.example.com"), {
      code: "ENOTFOUND",
    });
    const cause = new Error("fetch failed", { cause: networkError });

    assert.equal(
      DesktopUpdates.describeUpdateErrorCause(Cause.fail(cause)),
      "Error: fetch failed; caused by Error [ENOTFOUND]: getaddrinfo ENOTFOUND updates.example.com",
    );
    assert.include(DesktopUpdates.describeUpdateErrorCause(Cause.die(networkError)), "[ENOTFOUND]");
  });

  it("removes URLs, credentials, response bodies, and headers from summaries", () => {
    const messages = [
      "Cannot download https://user:url-secret@example.com/update?token=query-secret, status 403",
      "Request failed: Bearer bearer-secret",
      "Request failed: Basic basic-secret",
      "Request failed: Authorization: Bearer header-secret",
      "Request failed: Cookie=session-secret",
      "Request failed: api_key=\"key-secret\" password='password-secret' access_token=token-secret",
      '404 Not Found\n{"body":"body-secret"}\nHeaders: cookie=header-secret',
      "Request failed\rHeaders: cookie=header-secret",
    ];

    for (const message of messages) {
      const summary = DesktopUpdates.describeUpdateErrorCause(new Error(message));
      assert.include(summary, "Error:");
      assert.notInclude(summary, "secret");
      assert.notInclude(summary, "https://");
      assert.notInclude(summary, "Headers:");
    }
    assert.equal(
      DesktopUpdates.describeUpdateErrorCause("404 Not Found\nbody-secret"),
      "404 Not Found",
    );
  });

  it("bounds long messages, parallel failures, and cyclic causes", () => {
    const longError = new Error("x".repeat(10_000));
    const parallel = Cause.combine(Cause.fail(longError), Cause.die(longError));
    assert.isAtMost(DesktopUpdates.describeUpdateErrorCause(parallel).length, 1024);

    const cyclic = new Error("retry failed");
    cyclic.cause = cyclic;
    assert.include(DesktopUpdates.describeUpdateErrorCause(cyclic), "[truncated cause]");
    assert.isAtMost(DesktopUpdates.describeUpdateErrorCause(cyclic).length, 1024);
  });

  it("does not serialize arbitrary payloads or let unreadable errors break logging", () => {
    assert.equal(DesktopUpdates.describeUpdateErrorCause({ payload: "secret" }), "object");
    const unreadable = Object.defineProperty({}, "message", {
      get() {
        throw new Error("unreadable error");
      },
    });
    assert.equal(DesktopUpdates.describeUpdateErrorCause(unreadable), "UnknownError");
  });
});
