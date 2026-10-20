export type ScheduledTaskFilter = "all" | "enabled" | "paused";

export function matchesTaskOverview(
  task: { readonly title: string; readonly prompt: string; readonly enabled: boolean },
  search: string,
  filter: ScheduledTaskFilter,
  context: readonly string[],
): boolean {
  if (filter === "enabled" && !task.enabled) return false;
  if (filter === "paused" && task.enabled) return false;
  const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const text = [task.title, task.prompt, ...context].join(" ").toLocaleLowerCase();
  return terms.every((term) => text.includes(term));
}
