// @effect-diagnostics nodeBuiltinImport:off - replay actual bridge messages through the native unit harness.
import * as NodeFS from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { AndroidNotificationCoordinator } from "./AndroidNotificationCoordinator";
import { AndroidDirectNotificationChoice } from "./AndroidDirectNotificationChoice";
import type { AndroidAuthStatus } from "./connectAuth";
import expectedReplay from "../../../android-pwa/app/src/test/resources/android-notification-requests.json?raw";
import { notificationConfiguration } from "./notificationRegistration";

const fixture = vi.hoisted(() => ({
  enabled: true,
  environmentEnabled: true,
  account: {
    protocol: 1,
    available: false,
    phase: "unavailable",
    generation: 0,
    userId: null,
    sessionId: null,
    error: null,
  } as AndroidAuthStatus,
  listeners: new Set<() => void>(),
}));
vi.mock("../env", () => ({ isAndroidPwa: true }));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: unknown) => unknown) =>
    select({ agentNotifications: { enabled: fixture.enabled } }),
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({
    isReady: true,
    environments: [{ environmentId: "env", entry: { enabled: fixture.environmentEnabled } }],
  }),
}));
vi.mock("../state/session", () => ({
  usePreparedConnection: () =>
    Option.some({
      httpBaseUrl: "https://saved-direct.test/",
      httpAuthorization: { _tag: "Bearer", token: "saved-pairing" },
    }),
}));
vi.mock("./connectAuth", () => ({
  androidAuthStore: {
    subscribe: (listener: () => void) => {
      fixture.listeners.add(listener);
      return () => fixture.listeners.delete(listener);
    },
    getSnapshot: () => fixture.account,
  },
}));

it("replays actual automatic messages and a real explicit notification-choice click through the bridge", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(42);
  const messages: unknown[] = [];
  const bridge = {
    onmessage: null as ((event: { data: string }) => void) | null,
    postMessage: (raw: string) => {
      const request = JSON.parse(raw) as { id: string };
      messages.push(request);
      bridge.onmessage?.({
        data: JSON.stringify({ id: request.id, result: { permission: "ready", background: true } }),
      });
    },
  };
  window.t3Notifications = bridge;
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = async () => {
    await act(async () =>
      root.render(
        <>
          <AndroidNotificationCoordinator />
          <AndroidDirectNotificationChoice environmentId={EnvironmentId.make("env")} />
        </>,
      ),
    );
  };
  try {
    await render();
    expect(messages.map((v) => (v as { action: string }).action)).toEqual([
      "configure",
      "register",
    ]);
    fixture.account = { ...fixture.account, available: true, phase: "signedOut", generation: 1 };
    await act(async () => {
      for (const listener of fixture.listeners) listener();
    });
    expect(messages.map((v) => (v as { action: string }).action)).toEqual([
      "configure",
      "register",
      "register",
    ]);
    const button = container.querySelector("button")!;
    expect(button.textContent).toContain("Use current paired route for phone alerts");
    await act(async () => button.click());
    expect((messages.at(-1) as { action: string }).action).toBe("selectDirect");
    fixture.environmentEnabled = false;
    await render();
    fixture.enabled = false;
    await render();
    const count = messages.length;
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    expect(messages).toHaveLength(count);
    fixture.environmentEnabled = true;
    fixture.enabled = true;
    await render();
    await act(async () => button.click());
    const path = process.env.T3_NATIVE_NOTIFICATION_REPLAY_PATH;
    if (path) NodeFS.writeFileSync(path, JSON.stringify(messages, null, 2) + "\n");
    const expected = JSON.parse(expectedReplay);
    expect(messages).toEqual(expected);
  } finally {
    await act(async () => root.unmount());
    expect(notificationConfiguration.getSnapshot()).toBeNull();
    delete window.t3Notifications;
    clock.mockRestore();
    container.remove();
  }
});

it("does not report selection success when native rejects a click raced by configuration change", async () => {
  fixture.enabled = true;
  fixture.environmentEnabled = true;
  let pending: { id: string; payload: { configurationId: string } } | null = null;
  const bridge = {
    onmessage: null as ((event: { data: string }) => void) | null,
    postMessage: (raw: string) => {
      const request = JSON.parse(raw) as {
        id: string;
        action: string;
        payload: { configurationId: string };
      };
      if (request.action === "selectDirect") pending = request;
      else
        bridge.onmessage?.({
          data: JSON.stringify({
            id: request.id,
            result: { permission: "ready", background: true },
          }),
        });
    },
  };
  window.t3Notifications = bridge;
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = async () => {
    await act(async () =>
      root.render(
        <>
          <AndroidNotificationCoordinator />
          <AndroidDirectNotificationChoice environmentId={EnvironmentId.make("env")} />
        </>,
      ),
    );
  };
  try {
    await render();
    await act(async () => container.querySelector("button")!.click());
    const selected = pending!;
    expect(selected).not.toBeNull();
    fixture.environmentEnabled = false;
    await render();
    expect(selected.payload.configurationId).not.toBe(notificationConfiguration.getSnapshot());
    await act(async () =>
      bridge.onmessage?.({
        data: JSON.stringify({ id: selected.id, error: "Could not update Android notifications." }),
      }),
    );
    expect(container.textContent).toContain("Could not select this route for phone alerts.");
    expect(container.textContent).not.toContain("Phone alerts use this paired route.");
  } finally {
    await act(async () => root.unmount());
    delete window.t3Notifications;
    container.remove();
  }
});
