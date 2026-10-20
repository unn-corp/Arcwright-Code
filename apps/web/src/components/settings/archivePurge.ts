import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

export interface ArchivePurgeTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly id: ThreadId;
  readonly archivedAt: string | null;
}

export function selectArchivePurgeTargets<T extends ArchivePurgeTarget>(
  threads: ReadonlyArray<T>,
  scope: { environmentIds: ReadonlyArray<EnvironmentId>; projectKeys: ReadonlySet<string> | null },
): T[] {
  const environments = new Set(scope.environmentIds);
  return threads.filter(
    (thread) =>
      thread.archivedAt !== null &&
      environments.has(thread.environmentId) &&
      (scope.projectKeys === null ||
        scope.projectKeys.has(`${thread.environmentId}:${thread.projectId}`)),
  );
}

export interface ArchivePurgeFailure<T> {
  readonly target: T;
  readonly message: string;
}

export async function purgeArchivedThreads<T extends ArchivePurgeTarget>(options: {
  confirmed: boolean;
  targets: ReadonlyArray<T>;
  isStillArchived: (target: T) => boolean;
  remove: (target: T) => Promise<{ success: true } | { success: false; message: string }>;
}) {
  const removed: T[] = [];
  const failed: ArchivePurgeFailure<T>[] = [];
  if (!options.confirmed) return { removed, failed };
  // Keep the confirmed list fixed and bound concurrency to one. Recheck eligibility before each deletion.
  for (const target of options.targets) {
    if (target.archivedAt === null || !options.isStillArchived(target)) {
      failed.push({
        target,
        message: "No longer archived or unavailable. Refresh before retrying.",
      });
      continue;
    }
    try {
      const result = await options.remove(target);
      if (result.success) removed.push(target);
      else failed.push({ target, message: result.message });
    } catch (error) {
      failed.push({ target, message: error instanceof Error ? error.message : "Deletion failed." });
    }
  }
  return { removed, failed };
}
