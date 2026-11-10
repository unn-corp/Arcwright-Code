import { describe, expect, it } from "vite-plus/test";
import {
  resolveLegacyPlanModeEnabled,
  resolvePendingTaskInteractionMode,
} from "./legacy-plan-mode";

describe("legacy Plan mode", () => {
  it("requires a loaded opt-in and respects provider support", () => {
    expect(resolveLegacyPlanModeEnabled({ loaded: false, preference: true })).toBe(false);
    expect(resolveLegacyPlanModeEnabled({ loaded: true, preference: true })).toBe(true);
    expect(
      resolvePendingTaskInteractionMode({ planModeEnabled: true, draftInteractionMode: "plan" }),
    ).toBe("plan");
    expect(
      resolvePendingTaskInteractionMode({ planModeEnabled: false, draftInteractionMode: "plan" }),
    ).toBe("default");
    expect(
      resolvePendingTaskInteractionMode({
        planModeEnabled: true,
        draftInteractionMode: "plan",
        provider: { showInteractionModeToggle: false },
      }),
    ).toBe("default");
  });
});
