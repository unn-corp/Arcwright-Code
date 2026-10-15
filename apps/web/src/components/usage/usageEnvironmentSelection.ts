import type { EnvironmentId } from "@t3tools/contracts";

/** Keep a disconnected current device selected; never switch to another host to hide a failure. */
export function currentUsageEnvironmentId(
  environmentIds: readonly EnvironmentId[],
  primary: EnvironmentId | null,
  active: EnvironmentId | null,
  selected: ReadonlySet<EnvironmentId> | null,
): EnvironmentId | null {
  if (primary !== null && environmentIds.includes(primary)) return primary;
  for (const id of selected ?? []) {
    if (environmentIds.includes(id)) return id;
  }
  if (active !== null && environmentIds.includes(active)) return active;
  return environmentIds[0] ?? null;
}
