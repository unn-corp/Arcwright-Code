import { expect, it } from "@effect/vitest";
import {
  applyForkRetention,
  retainedReleaseIds,
  createRetentionApi,
  type RetentionApi,
} from "./fork-release-retention.ts";
import type { RawRelease } from "./fork-release-github.ts";

const release = (id: number, tag_name: string, draft = false): RawRelease => ({
  id,
  tag_name,
  draft,
  prerelease: tag_name.includes("nightly"),
  body: "",
  created_at: "2026-01-01",
  published_at: draft ? null : "2026-01-01",
  assets: [{ id: id * 10, name: "build", size: 1000 }],
});

it("keeps five per channel with numerical nightly ordering and does not treat drafts as retained builds", () => {
  const releases = [9, 10, 11, 12, 13, 14, 15].map((n) =>
    release(n, `fork-v1.0.1-nightly.20261012.${n}`),
  );
  releases.push(
    ...[1, 2, 3, 4, 5, 6].map((n) => release(100 + n, `fork-v1.0.${n}`)),
    release(300, "fork-v1.0.1-nightly.20261012.99", true),
  );
  expect([...retainedReleaseIds(releases)].sort((a, b) => a - b)).toEqual([
    11, 12, 13, 14, 15, 102, 103, 104, 105, 106,
  ]);
  expect(() => createRetentionApi("test", "upstream/t3code")).toThrow("restricted");
});

it("removes old release payloads and completed Actions duplicates while keeping running jobs and unrelated releases", async () => {
  const releases = [1, 2, 3, 4, 5, 6].map((n) => release(n, `fork-v1.0.1-nightly.20261012.${n}`));
  releases.push(release(7, "fork-baseline"), release(8, "unrelated-tag"));
  const deleted: string[] = [];
  const api: RetentionApi = {
    releases: async () => releases,
    activeRuns: async () => [{ id: 2, status: "in_progress", path: ".github/workflows/ci.yml" }],
    artifacts: async () => [
      { id: 10, name: "completed build copy", size_in_bytes: 500, workflow_run: { id: 1 } },
      { id: 20, name: "active build", size_in_bytes: 500, workflow_run: { id: 2 } },
    ],
    release: async (id) => releases.find((r) => r.id === id)!,
    run: async (id) => ({ id, status: "completed", path: "ci.yml" }),
    deleteRelease: async (id) => {
      deleted.push(`release:${id}`);
    },
    deleteArtifact: async (id) => {
      deleted.push(`artifact:${id}`);
    },
  };
  const preview = await applyForkRetention(api);
  expect(deleted).toEqual([]);
  expect(preview.removedTags).toEqual(["fork-v1.0.1-nightly.20261012.1", "fork-baseline"]);
  await applyForkRetention(api, true);
  expect(deleted).toEqual(["release:1", "release:7", "artifact:10"]);
});

it("defers release deletion during a pipeline that may need older predecessors", async () => {
  const releases = [1, 2, 3, 4, 5, 6].map((n) => release(n, `fork-v1.0.1-nightly.20261012.${n}`));
  const api: RetentionApi = {
    releases: async () => releases,
    activeRuns: async () => [
      { id: 1, status: "in_progress", path: ".github/workflows/fork-release.yml" },
    ],
    artifacts: async () => [],
    release: async () => {
      throw new Error("must not read a deletion candidate");
    },
    run: async () => {
      throw new Error("no artifacts");
    },
    deleteRelease: async () => {
      throw new Error("must not delete");
    },
    deleteArtifact: async () => {
      throw new Error("must not delete");
    },
  };
  expect(await applyForkRetention(api, true)).toMatchObject({
    releasesDeferred: true,
    removedTags: [],
  });
});
