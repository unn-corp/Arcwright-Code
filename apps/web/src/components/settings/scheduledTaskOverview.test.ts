import { describe, expect, it } from "vite-plus/test";
import { matchesTaskOverview } from "./scheduledTaskOverview";

const task = { title: "Check errors", prompt: "Review production failures", enabled: true };

describe("scheduled task overview search", () => {
  it("combines case-insensitive search terms across task and computer/project context", () => {
    expect(
      matchesTaskOverview(task, "  ERRORS laptop  billing ", "all", ["Laptop", "Billing"]),
    ).toBe(true);
    expect(matchesTaskOverview(task, "failures", "all", [])).toBe(true);
    expect(matchesTaskOverview(task, "other project", "all", ["Laptop", "Billing"])).toBe(false);
  });

  it("applies enabled and paused filters independently of search", () => {
    expect(matchesTaskOverview(task, "", "enabled", [])).toBe(true);
    expect(matchesTaskOverview(task, "", "paused", [])).toBe(false);
    expect(matchesTaskOverview({ ...task, enabled: false }, "errors", "paused", [])).toBe(true);
    expect(matchesTaskOverview({ ...task, enabled: false }, "", "enabled", [])).toBe(false);
    expect(matchesTaskOverview({ ...task, enabled: false }, "", "all", [])).toBe(true);
  });
});
