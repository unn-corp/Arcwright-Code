import { describe, expect, it } from "vite-plus/test";
import {
  buildKeybindingRows,
  filterKeybindingRows as filterRowsByQuery,
} from "./KeybindingsSettings.logic";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { filterKeybindingRows, summarizeKeybindingCondition } from "./KeybindingsExperience.logic";

describe("shortcut browsing", () => {
  it("composes text search with custom and conflict filters without mutating assignments", () => {
    const rows = filterRowsByQuery(buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS), "terminal");
    const customized = rows.map((row, index) =>
      index === 0 ? { ...row, source: "Custom" as const, conflicts: ["other shortcut"] } : row,
    );
    expect(filterKeybindingRows(customized, "all")).toEqual(customized);
    expect(filterKeybindingRows(customized, "customized")).toEqual([customized[0]]);
    expect(filterKeybindingRows(customized, "conflicts")).toEqual([customized[0]]);
    expect(filterKeybindingRows([], "conflicts")).toEqual([]);
    expect(rows.every((row) => row.source === "Default")).toBe(true);
  });
  it("describes simple conditions and keeps custom expressions inspectable", () => {
    expect(summarizeKeybindingCondition("terminalFocus")).toBe("While the terminal is focused");
    expect(summarizeKeybindingCondition("!terminalFocus")).toBe(
      "While the terminal is not focused",
    );
    expect(summarizeKeybindingCondition("")).toBe("Always");
    expect(summarizeKeybindingCondition("terminalFocus && unknownFlag")).toContain("expand When");
  });
});
