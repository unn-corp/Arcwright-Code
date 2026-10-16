import { expect, it, vi } from "vite-plus/test";
import {
  notifyLocalEnvironmentTopologyChanged,
  subscribeLocalEnvironmentTopology,
} from "./topologyEvents.ts";

it("coalesces a backend transition burst and releases closed-window subscriptions", async () => {
  const first = vi.fn();
  const second = vi.fn();
  const removeFirst = subscribeLocalEnvironmentTopology(first);
  const removeSecond = subscribeLocalEnvironmentTopology(second);
  try {
    notifyLocalEnvironmentTopologyChanged();
    notifyLocalEnvironmentTopologyChanged();
    expect(first).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    notifyLocalEnvironmentTopologyChanged();
    removeFirst();
    await Promise.resolve();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
  } finally {
    removeFirst();
    removeSecond();
  }
});
