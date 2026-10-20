import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Option from "effect/Option";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { AndroidNotificationCoordinator } from "./AndroidNotificationCoordinator";
import type { PreparedHttpAuthorization } from "@t3tools/client-runtime/connection";
import type { AndroidAuthStatus } from "./connectAuth";
import { notificationConfiguration } from "./notificationRegistration";

const fixture = vi.hoisted(() => {
  const account: AndroidAuthStatus = {
    protocol: 1,
    available: true,
    phase: "signedIn",
    generation: 1,
    userId: "native-user",
    sessionId: "native-session",
    error: null,
  };
  return {
    enabled: true,
    environmentEnabled: true,
    account,
    listeners: new Set<() => void>(),
    request: vi.fn(async (_action: string, _payload: unknown) => ({
      permission: "ready",
      background: true,
    })),
  };
});
let prepared: Option.Option<{
  httpBaseUrl: string;
  httpAuthorization: PreparedHttpAuthorization;
}>;
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: () => ({ enabled: fixture.enabled }),
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({
    isReady: true,
    environments: [{ environmentId: "env", entry: { enabled: fixture.environmentEnabled } }],
  }),
}));
vi.mock("../state/session", () => ({ usePreparedConnection: () => prepared }));
vi.mock("./notifications", () => ({
  supportsAndroidNotifications: () => true,
  androidNotificationRequest: fixture.request,
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
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  fixture.enabled = true;
  fixture.environmentEnabled = true;
  fixture.account = {
    ...fixture.account,
    phase: "signedIn",
    generation: 1,
    userId: "native-user",
    sessionId: "native-session",
  };
  fixture.request.mockClear();
  prepared = Option.some({
    httpBaseUrl: "https://host.test/",
    httpAuthorization: {
      _tag: "Dpop",
      accessToken: "web-only-access",
      expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
    },
  });
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render() {
  await act(async () => root.render(<AndroidNotificationCoordinator />));
}

describe("native managed notification registration", () => {
  it("waits for native configuration and sends only native account references for managed connections", async () => {
    let finish: (() => void) | undefined;
    fixture.request.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          finish = () => resolve({ permission: "ready", background: true });
        }),
    );
    await render();
    expect(fixture.request.mock.calls.map(([action]) => action)).toEqual(["configure"]);
    expect(notificationConfiguration.getSnapshot()).toBeNull();
    await act(async () => finish?.());
    const configuration = fixture.request.mock.calls[0]?.[1];
    expect(notificationConfiguration.getSnapshot()).toBe(
      (configuration as { configurationId: string }).configurationId,
    );
    const registration = fixture.request.mock.calls[1];
    expect(registration?.[0]).toBe("registerManaged");
    expect(registration?.[1]).toEqual({
      environmentId: "env",
      userId: "native-user",
      sessionId: "native-session",
      generation: 1,
      configurationId: expect.any(String),
      sequence: expect.any(Number),
    });
    expect(registration?.[1]).toHaveProperty(
      "configurationId",
      (configuration as { configurationId: string }).configurationId,
    );
    expect(JSON.stringify(fixture.request.mock.calls)).not.toMatch(/web-only|host\.test|proofKey/);
  });
  it("orders managed-to-direct-to-managed transitions and rebinds a switched native session", async () => {
    await render();
    prepared = Option.some({
      httpBaseUrl: "https://direct.test/",
      httpAuthorization: { _tag: "Bearer", token: "direct-pairing" },
    });
    await render();
    expect(fixture.request.mock.calls.at(-1)?.[0]).toBe("register");
    expect(fixture.request.mock.calls.at(-1)?.[1]).toMatchObject({
      token: "direct-pairing",
      httpBaseUrl: "https://direct.test/",
    });
    prepared = Option.some({
      httpBaseUrl: "https://host.test/",
      httpAuthorization: {
        _tag: "Dpop",
        accessToken: "web-only-access",
        expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
      },
    });
    await render();
    fixture.account = {
      ...fixture.account,
      userId: "other",
      sessionId: "other-session",
      generation: 2,
    };
    await act(async () => {
      for (const listener of fixture.listeners) listener();
    });
    const registrations = fixture.request.mock.calls.filter(([action]) =>
      action.startsWith("register"),
    );
    expect(registrations.map(([action]) => action)).toEqual([
      "registerManaged",
      "register",
      "registerManaged",
      "registerManaged",
    ]);
    const sequences = registrations.map(
      ([, payload]) => (payload as { sequence: number }).sequence,
    );
    expect(
      sequences.every((sequence, index) => index === 0 || sequence > sequences[index - 1]!),
    ).toBe(true);
    expect(registrations.at(-1)?.[1]).toMatchObject({
      userId: "other",
      sessionId: "other-session",
      generation: 2,
    });
    fixture.account = {
      ...fixture.account,
      phase: "signedOut",
      userId: null,
      sessionId: null,
      generation: 3,
    };
    await act(async () => {
      for (const listener of fixture.listeners) listener();
    });
    expect(
      fixture.request.mock.calls.filter(([action]) => action.startsWith("register")),
    ).toHaveLength(4);
  });
  it("removes disabled environments from configuration and stops registering them", async () => {
    await render();
    fixture.environmentEnabled = false;
    await render();
    expect(fixture.request.mock.calls.at(-1)).toEqual([
      "configure",
      { preferences: { enabled: true }, environmentIds: [], configurationId: expect.any(String) },
    ]);
    prepared = Option.none();
    await render();
    expect(
      fixture.request.mock.calls.filter(([action]) => action.startsWith("register")),
    ).toHaveLength(1);
  });
});
