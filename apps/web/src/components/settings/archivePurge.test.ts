import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  purgeArchivedThreads,
  selectArchivePurgeTargets,
  type ArchivePurgeTarget,
} from "./archivePurge";

const computer = EnvironmentId.make("computer");
const otherComputer = EnvironmentId.make("other-computer");
const project = ProjectId.make("project");
const otherProject = ProjectId.make("other-project");
const target = (id: string, overrides: Partial<ArchivePurgeTarget> = {}): ArchivePurgeTarget => ({
  id: ThreadId.make(id),
  environmentId: computer,
  projectId: project,
  archivedAt: "2026-10-20T12:00:00Z",
  ...overrides,
});

describe("archive purge scope", () => {
  const threads = [
    target("one"),
    target("two", { projectId: otherProject }),
    target("three", { environmentId: otherComputer }),
    target("active", { archivedAt: null }),
  ];
  it("limits project purge to archived threads on selected computers", () => {
    expect(
      selectArchivePurgeTargets(threads, {
        environmentIds: [computer],
        projectKeys: new Set([`${computer}:${project}`]),
      }).map((thread) => thread.id),
    ).toEqual(["one"]);
  });
  it("all-project purge retains computer scope and excludes active threads", () => {
    expect(
      selectArchivePurgeTargets(threads, { environmentIds: [computer], projectKeys: null }).map(
        (thread) => thread.id,
      ),
    ).toEqual(["one", "two"]);
  });
  it("never expands an empty or unavailable computer scope", () => {
    expect(selectArchivePurgeTargets(threads, { environmentIds: [], projectKeys: null })).toEqual(
      [],
    );
    expect(
      selectArchivePurgeTargets(threads, { environmentIds: [computer], projectKeys: new Set() }),
    ).toEqual([]);
  });
});

describe("archive purge outcomes", () => {
  it("cancellation has no effects", async () => {
    const remove = vi.fn();
    const result = await purgeArchivedThreads({
      confirmed: false,
      targets: [target("one")],
      isStillArchived: () => true,
      remove,
    });
    expect(remove).not.toHaveBeenCalled();
    expect(result).toEqual({ removed: [], failed: [] });
  });
  it("continues sequentially after permission failures and exceptions, with truthful retry targets", async () => {
    const targets = [target("removed"), target("permission"), target("offline"), target("last")];
    let inFlight = 0;
    const order: string[] = [];
    const result = await purgeArchivedThreads({
      confirmed: true,
      targets,
      isStillArchived: () => true,
      remove: async (thread) => {
        expect(inFlight++).toBe(0);
        order.push(thread.id);
        await Promise.resolve();
        inFlight--;
        if (thread.id === "permission") return { success: false, message: "Permission denied" };
        if (thread.id === "offline") throw new Error("Computer unavailable");
        return { success: true };
      },
    });
    expect(order).toEqual(["removed", "permission", "offline", "last"]);
    expect(result.removed.map((thread) => thread.id)).toEqual(["removed", "last"]);
    expect(result.failed.map(({ target, message }) => [target.id, message])).toEqual([
      ["permission", "Permission denied"],
      ["offline", "Computer unavailable"],
    ]);
    const remove = vi.fn(async () => ({ success: true as const }));
    const retried = await purgeArchivedThreads({
      confirmed: true,
      targets: result.failed.map(({ target }) => target),
      isStillArchived: () => true,
      remove,
    });
    expect(retried.removed.map((thread) => thread.id)).toEqual(["permission", "offline"]);
    expect(remove).toHaveBeenCalledTimes(2);
  });
  it("rechecks archive eligibility and skips threads that became active", async () => {
    const remove = vi.fn(async () => ({ success: true as const }));
    const result = await purgeArchivedThreads({
      confirmed: true,
      targets: [target("active-now"), target("active", { archivedAt: null }), target("archived")],
      isStillArchived: (thread) => thread.id !== "active-now",
      remove,
    });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(result.removed.map((thread) => thread.id)).toEqual(["archived"]);
    expect(result.failed).toHaveLength(2);
  });
});
