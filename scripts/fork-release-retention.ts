// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalConsole:off processEnv:off globalTimers:off preferSchemaOverJson:off
/** Fork-owned storage policy. Published releases are the sole retained build copies. */
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { createGitHubApi, type RawRelease } from "./fork-release-github.ts";
import {
  compareForkVersions,
  forkVersionFromTag,
  parseForkVersion,
} from "./fork-release-policy.ts";

export const RETAINED_BUILDS_PER_CHANNEL = 5;
export const RETENTION_REPOSITORY = "unn-corp/Arcwright-Code";
export interface RetentionRun {
  readonly id: number;
  readonly status: string;
  readonly path: string;
}
export interface RetentionArtifact {
  readonly id: number;
  readonly name: string;
  readonly size_in_bytes: number;
  readonly workflow_run: { readonly id: number } | null;
}
export interface RetentionApi {
  readonly releases: () => Promise<ReadonlyArray<RawRelease>>;
  readonly activeRuns: () => Promise<ReadonlyArray<RetentionRun>>;
  readonly artifacts: () => Promise<ReadonlyArray<RetentionArtifact>>;
  readonly release: (id: number) => Promise<RawRelease>;
  readonly run: (id: number) => Promise<RetentionRun>;
  readonly deleteRelease: (id: number) => Promise<void>;
  readonly deleteArtifact: (id: number) => Promise<void>;
}

export function retainedReleaseIds(releases: ReadonlyArray<RawRelease>): ReadonlySet<number> {
  const keep = new Set<number>();
  for (const channel of ["nightly", "stable"] as const) {
    const candidates = releases
      .filter((release) => {
        const version = forkVersionFromTag(release.tag_name);
        return (
          !release.draft &&
          release.published_at !== null &&
          version !== null &&
          parseForkVersion(version)?.channel === channel
        );
      })
      .toSorted((a, b) =>
        compareForkVersions(forkVersionFromTag(b.tag_name)!, forkVersionFromTag(a.tag_name)!),
      );
    for (const release of candidates.slice(0, RETAINED_BUILDS_PER_CHANNEL)) keep.add(release.id);
  }
  return keep;
}

const isReleaseRun = (run: RetentionRun) =>
  /(?:^|\/)(fork-release|fork-baseline)\.yml(?:@.*)?$/.test(run.path);
const isOwnedRelease = (release: RawRelease) =>
  forkVersionFromTag(release.tag_name) !== null || release.tag_name === "fork-baseline";

/** A dry run is the default. Each destructive call rechecks state and never deletes Git tags or reservations. */
export async function applyForkRetention(
  api: RetentionApi,
  apply = false,
  progress?: (count: number) => void,
): Promise<{
  readonly keptTags: ReadonlyArray<string>;
  readonly removedTags: ReadonlyArray<string>;
  readonly removedArtifacts: number;
  readonly releaseBytes: number;
  readonly artifactBytes: number;
  readonly releasesDeferred: boolean;
  readonly failedArtifacts: ReadonlyArray<number>;
}> {
  const releases = await api.releases();
  const keep = retainedReleaseIds(releases);
  const active = await api.activeRuns();
  const releasesDeferred = active.some(isReleaseRun);
  const removedTags: string[] = [];
  let releaseBytes = 0,
    artifactBytes = 0,
    removedArtifacts = 0;
  const failedArtifacts: number[] = [];
  // The baseline can retire only after five numbered nightlies replace its validation/recovery role.
  const numbered = releases.filter((r) => keep.has(r.id) && r.prerelease).length;
  if (!releasesDeferred) {
    for (const release of releases) {
      if (
        !isOwnedRelease(release) ||
        keep.has(release.id) ||
        (release.tag_name === "fork-baseline" && numbered < 5)
      )
        continue;
      const fresh = await api.release(release.id);
      // A concurrent publication can only extend the set; recompute immediately before deletion.
      if (
        retainedReleaseIds(await api.releases()).has(fresh.id) ||
        (await api.activeRuns()).some(isReleaseRun)
      )
        continue;
      if (fresh.tag_name !== release.tag_name)
        throw new Error("Release identity changed during retention.");
      if (apply) await api.deleteRelease(fresh.id);
      removedTags.push(fresh.tag_name);
      releaseBytes += fresh.assets.reduce((total, asset) => total + asset.size, 0);
    }
  }
  const activeIds = new Set((await api.activeRuns()).map((run) => run.id));
  const completed = new Map<number, boolean>();
  for (const artifact of await api.artifacts()) {
    const runId = artifact.workflow_run?.id;
    if (runId === undefined || activeIds.has(runId)) continue;
    let done = completed.get(runId);
    if (done === undefined) {
      done = (await api.run(runId)).status === "completed";
      completed.set(runId, done);
    }
    if (!done) continue;
    if (apply) {
      try {
        await api.deleteArtifact(artifact.id);
      } catch {
        failedArtifacts.push(artifact.id);
        continue;
      }
    }
    removedArtifacts += 1;
    artifactBytes += artifact.size_in_bytes;
    if (removedArtifacts % 100 === 0) progress?.(removedArtifacts);
  }
  return {
    keptTags: releases.filter((r) => keep.has(r.id)).map((r) => r.tag_name),
    removedTags,
    removedArtifacts,
    releaseBytes,
    artifactBytes,
    releasesDeferred,
    failedArtifacts,
  };
}

export function createRetentionApi(
  token: string,
  repository: string,
  doFetch: typeof fetch = fetch,
): RetentionApi {
  if (repository !== RETENTION_REPOSITORY)
    throw new Error("Retention is restricted to the Arcwright fork repository.");
  const releaseApi = createGitHubApi({ token, repository, fetch: doFetch });
  const request = async (method: string, resource: string): Promise<Response> => {
    for (let attempt = 0; ; attempt += 1) {
      const response = await doFetch(`https://api.github.com/repos/${repository}${resource}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (response.ok || (method === "DELETE" && response.status === 404)) return response;
      if (attempt < 3 && (response.status >= 500 || response.status === 429)) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        continue;
      }
      throw new Error(`Retention ${method} ${resource} failed with HTTP ${response.status}.`);
    }
  };
  const paged = async <T>(resource: string, field: string): Promise<T[]> => {
    const rows: T[] = [];
    for (let page = 1; ; page += 1) {
      const response = await request(
        "GET",
        `${resource}${resource.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      const body = (await response.json()) as Record<string, T[]>;
      const batch = body[field]!;
      rows.push(...batch);
      if (batch.length < 100) return rows;
    }
  };
  return {
    releases: releaseApi.listReleases,
    release: releaseApi.getRelease,
    deleteRelease: releaseApi.deleteRelease,
    activeRuns: async () =>
      (
        await Promise.all(
          ["in_progress", "queued", "waiting", "pending", "requested"].map((status) =>
            paged<RetentionRun>(`/actions/runs?status=${status}`, "workflow_runs"),
          ),
        )
      ).flat(),
    artifacts: () => paged<RetentionArtifact>("/actions/artifacts", "artifacts"),
    run: async (id) => (await (await request("GET", `/actions/runs/${id}`)).json()) as RetentionRun,
    deleteArtifact: async (id) => {
      await request("DELETE", `/actions/artifacts/${id}`);
    },
  };
}

if (
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required.");
  const api = createRetentionApi(token, process.env.GITHUB_REPOSITORY ?? RETENTION_REPOSITORY);
  const result = await applyForkRetention(api, process.argv.includes("--apply"), (count) =>
    console.error(`Processed ${count} completed Actions artifacts.`),
  );
  console.log(JSON.stringify(result, null, 2));
  if (result.failedArtifacts.length > 0) process.exitCode = 1;
}
