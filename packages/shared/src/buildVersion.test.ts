import { describe, expect, it } from "vite-plus/test";
import {
  formatBuildVersion,
  formatCompactBuildVersion,
  includedUpstreamVersion,
} from "./buildVersion.ts";

describe("build version presentation", () => {
  it("keeps the included upstream version separate from the Arcwright nightly counter", () => {
    const build = { version: "1.0.1-nightly.20261007.35", upstreamVersion: "0.0.45" };
    expect(formatBuildVersion(build)).toBe("0.0.45 · Arcwright build 35 · Nightly");
    expect(build.version).toBe("1.0.1-nightly.20261007.35");
  });
  it("presents legacy hosts without putting the fork suffix on the T3 version", () => {
    expect(formatBuildVersion({ version: "0.0.45-fork.4" })).toBe(
      "0.0.45 · Arcwright build 4 · Legacy",
    );
  });
  it("does not invent upstream provenance for a historical independent release", () => {
    const build = { version: "1.0.1-nightly.20261006.31" };
    expect(includedUpstreamVersion(build)).toBeNull();
    expect(formatBuildVersion(build)).toBe("Arcwright build 31 · Nightly");
  });
  it("uses a separate stable build number", () => {
    expect(
      formatBuildVersion({ version: "1.0.1", upstreamVersion: "0.0.45", forkBuildNumber: 36 }),
    ).toBe("0.0.45 · Arcwright build 36 · Stable");
  });
  it("identifies a local nightly preview instead of presenting it as stable", () => {
    expect(
      formatBuildVersion({ version: "1.0.1-preview.20261012.1", upstreamVersion: "0.0.49" }),
    ).toBe("0.0.49 · Arcwright build 1 · Local Nightly");
  });
  it("puts the nightly channel and counter before the upstream version in compact labels", () => {
    expect(
      formatCompactBuildVersion({
        version: "1.0.1-nightly.20261011.85",
        upstreamVersion: "0.0.49",
      }),
    ).toBe("Nightly 85 · T3 0.0.49");
    expect(
      formatCompactBuildVersion({ version: "1.0.1-preview.20261012.1", upstreamVersion: "0.0.49" }),
    ).toBe("Local Nightly 1 · T3 0.0.49");
  });
  it("keeps local preview counters separate from published fork counters", () => {
    const local = {
      version: "1.0.1-preview.20261012.2",
      upstreamVersion: "0.0.49",
      forkBuildNumber: 85,
    };
    expect(formatCompactBuildVersion(local)).toBe("Local Nightly 2 · T3 0.0.49");
    expect(formatBuildVersion(local)).toBe("0.0.49 · Arcwright build 2 · Local Nightly");
  });
  it("does not invent upstream provenance or nightly counters for compact labels", () => {
    expect(formatCompactBuildVersion({ version: "1.0.1-nightly.20261011.85" })).toBe("Nightly 85");
    expect(formatCompactBuildVersion({ version: "dev" })).toBe("dev");
    expect(formatCompactBuildVersion({ version: "0.0.45" })).toBe("0.0.45");
    expect(formatCompactBuildVersion({ version: "1.0.1", forkBuildNumber: 36 })).toBe(
      "Arcwright build 36",
    );
  });
  it("leaves unknown and upstream-only identities intact", () => {
    expect(formatBuildVersion({ version: "dev" })).toBe("dev");
    expect(formatBuildVersion({ version: "0.0.45" })).toBe("0.0.45");
  });
});
