import type { KeybindingRow } from "./KeybindingsSettings.logic";

export type KeybindingFilter = "all" | "customized" | "conflicts";

export function filterKeybindingRows(rows: ReadonlyArray<KeybindingRow>, filter: KeybindingFilter) {
  return rows.filter(
    (row) =>
      filter === "all" ||
      (filter === "customized" ? row.source !== "Default" : row.conflicts.length > 0),
  );
}

export function summarizeKeybindingCondition(expression: string): string {
  const labels: Record<string, string> = {
    terminalFocus: "While the terminal is focused",
    "!terminalFocus": "While the terminal is not focused",
    terminalOpen: "While the terminal is open",
    isDesktop: "In the desktop app",
    isWeb: "In the browser",
    true: "Always",
    false: "Never",
  };
  return (
    labels[expression.trim()] ??
    (expression.trim() ? "Custom condition, expand When to inspect" : "Always")
  );
}
