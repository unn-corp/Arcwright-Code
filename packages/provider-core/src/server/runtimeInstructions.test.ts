import { describe, expect, it } from "vite-plus/test";
import { buildRuntimeInstructions } from "./runtimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it("directs generated workflow evidence into conversation storage", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).toContain("When t3_evidence_directory is available, call it");
    expect(instructions).toContain("write those files into the returned directory");
    expect(instructions).toContain("Save permanent deliverables in the project");
  });
});
