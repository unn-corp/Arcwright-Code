import type { OrganizationWorkStatusSnapshot } from "@t3tools/contracts";
import { EnvironmentId, OrganizationId, OrganizationWorkError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  effects: [] as Array<() => (() => void) | undefined>,
  supported: false,
  streamReads: 0,
  legacyReads: 0,
}));
vi.mock("react", () => ({
  useEffect: (effect: () => (() => void) | undefined) => fixture.effects.push(effect),
  useEffectEvent: <T>(callback: T) => callback,
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: <A>(atom: Atom.Atom<A>) => registry.get(atom),
  useAtomRefresh: (atom: Atom.Atom<unknown>) => () => {
    refresh();
    registry.refresh(atom);
  },
}));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createEnvironmentRpcSubscriptionAtomFamily: () => () => {
    fixture.streamReads++;
    return stream;
  },
}));
vi.mock("./environments", () => ({
  usePrimaryEnvironmentId: () => EnvironmentId.make("environment"),
}));
vi.mock("./server", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentServerConfigsAtom: Atom.make(
      () =>
        new Map([
          [
            "environment",
            { environment: { capabilities: { organizationWorkStatusPush: fixture.supported } } },
          ],
        ]),
    ),
  };
});
vi.mock("./organizations", () => ({
  organizationEnvironment: {
    getWorkDrainStatus: () => {
      fixture.legacyReads++;
      return legacyDrain;
    },
    getEmergencyStopStatus: () => {
      fixture.legacyReads++;
      return legacyStop;
    },
  },
}));
import {
  useOrganizationDrainStatus,
  useOrganizationEmergencyStopStatus,
} from "./organizationWorkStatus";

const organizationId = OrganizationId.make("org");
const snapshot: OrganizationWorkStatusSnapshot = {
  organizationId,
  drain: { organizationId, state: "none", requestedAt: null },
  emergencyStop: {
    organizationId,
    state: "none",
    requestedAt: null,
    admittedPhases: 0,
    unverifiedProviderLaunches: 0,
    verifiedProviderExits: 0,
    verifiedScopes: 0,
  },
};
const stream = Atom.make<
  AsyncResult.AsyncResult<OrganizationWorkStatusSnapshot, OrganizationWorkError>
>(AsyncResult.success(snapshot));
const legacyDrain = Atom.make(AsyncResult.success(snapshot.drain));
const legacyStop = Atom.make(AsyncResult.success(snapshot.emergencyStop));
let registry: AtomRegistry.AtomRegistry;
let page: EventTarget & { visibilityState: string };
const refresh = vi.fn();
let cleanups: Array<() => void> = [];
beforeEach(() => {
  registry = AtomRegistry.make();
  fixture.effects.length = 0;
  fixture.streamReads = 0;
  fixture.legacyReads = 0;
  refresh.mockClear();
  vi.useFakeTimers();
  page = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
  registry.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function mount() {
  const drain = useOrganizationDrainStatus(organizationId, false);
  const stop = useOrganizationEmergencyStopStatus(organizationId, false);
  cleanups = fixture.effects.map((effect) => effect()).filter((cleanup) => cleanup !== undefined);
  return { drain, stop };
}
it("keeps idle push subscriptions selected, exposes failures, and schedules no status polling", () => {
  fixture.supported = true;
  expect(mount().drain.data?.state).toBe("none");
  expect(fixture.streamReads).toBe(2);
  expect(fixture.legacyReads).toBe(0);
  expect(refresh).not.toHaveBeenCalled();
  const denied = new OrganizationWorkError({ code: "forbidden", message: "Read access denied." });
  registry.set(stream, AsyncResult.failure(Cause.fail(denied)));
  const result = useOrganizationEmergencyStopStatus(organizationId, false);
  expect(result.error).toBe("Read access denied.");
  expect(result.failure).toEqual(denied);
  vi.advanceTimersByTime(60_000);
  expect(refresh).not.toHaveBeenCalled();
});
it("polls legacy idle status every five visible seconds and cleans up on unmount", () => {
  fixture.supported = false;
  expect(mount().stop.data?.state).toBe("none");
  expect(fixture.streamReads).toBe(0);
  expect(fixture.legacyReads).toBe(2);
  expect(refresh).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(5_000);
  expect(refresh).toHaveBeenCalledTimes(4);
  page.visibilityState = "hidden";
  page.dispatchEvent(new Event("visibilitychange"));
  expect(refresh).toHaveBeenCalledTimes(4);
  vi.advanceTimersByTime(60_000);
  expect(refresh).toHaveBeenCalledTimes(4);
  page.visibilityState = "visible";
  page.dispatchEvent(new Event("visibilitychange"));
  expect(refresh).toHaveBeenCalledTimes(6);
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
  vi.advanceTimersByTime(60_000);
  expect(refresh).toHaveBeenCalledTimes(6);
});
