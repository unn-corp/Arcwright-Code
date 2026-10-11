import { expect, it } from "vite-plus/test";
import { browserNetworkStatus } from "./browserConnectivity";

it("does not let an Android WebView offline hint suspend private-host retries", () => {
  expect(browserNetworkStatus({ onLine: false }, true)).toBe("unknown");
  expect(browserNetworkStatus({ onLine: true }, true)).toBe("online");
  // The VPN can remain reachable when WebView changes back to its offline hint.
  expect(browserNetworkStatus({ onLine: false }, true)).toBe("unknown");
});

it("preserves regular browser connectivity and missing-navigator behavior", () => {
  expect(browserNetworkStatus({ onLine: false }, false)).toBe("offline");
  expect(browserNetworkStatus({ onLine: true }, false)).toBe("online");
  expect(browserNetworkStatus(undefined, false)).toBe("unknown");
  expect(browserNetworkStatus(undefined, true)).toBe("unknown");
});
