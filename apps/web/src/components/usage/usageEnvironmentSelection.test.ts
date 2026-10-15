import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { currentUsageEnvironmentId } from "./usageEnvironmentSelection";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");

describe("current usage connection", () => {
  it("uses the desktop's local device even when a remote connection is active or selected", () => {
    expect(currentUsageEnvironmentId([remote, local], local, remote, new Set([remote]))).toBe(
      local,
    );
  });

  it("uses the phone's active connection rather than all saved devices", () => {
    expect(currentUsageEnvironmentId([remote, local], null, local, null)).toBe(local);
  });

  it("allows a phone to choose one connection explicitly", () => {
    expect(currentUsageEnvironmentId([remote, local], null, local, new Set([remote]))).toBe(remote);
  });

  it("handles first launch, a removed selection, and an empty catalog", () => {
    expect(currentUsageEnvironmentId([remote, local], null, null, null)).toBe(remote);
    expect(currentUsageEnvironmentId([local], null, remote, new Set([remote]))).toBe(local);
    expect(currentUsageEnvironmentId([], local, remote, null)).toBeNull();
  });
});
