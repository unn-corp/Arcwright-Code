import { EnvironmentId, UsageDay } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  presentations: new Map(),
  sessions: vi.fn(),
  summaries: vi.fn(),
  providers: vi.fn(),
}));
vi.mock("./presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentPresentations: { presentationsAtom: Atom.make(() => state.presentations) } };
});
vi.mock("./session", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const { AuthDiagnosticsReadScope } = await import("@t3tools/contracts");
  return {
    readEnvironmentScope: () => true,
    environmentSession: {
      sessionStateAtom: (id: EnvironmentId) => {
        state.sessions(id);
        return Atom.make(
          AsyncResult.success({ authenticated: true, scopes: [AuthDiagnosticsReadScope] }),
        );
      },
    },
  };
});
vi.mock("./server", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return {
    serverEnvironment: {
      usageSummary: ({ environmentId }: { environmentId: EnvironmentId }) => {
        state.summaries(environmentId);
        return Atom.make(AsyncResult.success({ sources: [] }));
      },
      providersValueAtom: (id: EnvironmentId) => {
        state.providers(id);
        return Atom.make([]);
      },
    },
  };
});

import { usageByWindowAtom } from "./usage";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const input = {
  sinceDay: UsageDay.make("2026-10-13"),
  untilDay: UsageDay.make("2026-10-13"),
  timeZone: "UTC",
};
let registry: AtomRegistry.AtomRegistry;
beforeEach(() => {
  registry = AtomRegistry.make();
  state.sessions.mockClear();
  state.summaries.mockClear();
  state.providers.mockClear();
  state.presentations = new Map(
    [local, remote].map((id) => [
      id,
      { entry: { target: { label: id } }, connection: { phase: "connected" } },
    ]),
  );
});
afterEach(() => registry.dispose());

it("does not read an unselected device's session, history, or providers", () => {
  const statuses = registry.get(
    usageByWindowAtom(JSON.stringify({ input, environmentIds: [local] })),
  );
  expect(state.sessions).toHaveBeenCalledExactlyOnceWith(local);
  expect(state.summaries).toHaveBeenCalledExactlyOnceWith(local);
  expect(state.providers).toHaveBeenCalledExactlyOnceWith(local);
  expect(statuses.map(({ environmentId }) => environmentId)).toEqual([local, remote]);
  expect(statuses[1]).toMatchObject({ summary: null, error: null, isPending: false });
});

it("does not start any device query without a current connection", () => {
  registry.get(usageByWindowAtom(JSON.stringify({ input, environmentIds: [] })));
  expect(state.sessions).not.toHaveBeenCalled();
  expect(state.summaries).not.toHaveBeenCalled();
  expect(state.providers).not.toHaveBeenCalled();
});

it("still reads all environments when combining history is explicitly selected", () => {
  registry.get(usageByWindowAtom(JSON.stringify({ input, environmentIds: null })));
  expect(state.summaries.mock.calls).toEqual([[local], [remote]]);
});
