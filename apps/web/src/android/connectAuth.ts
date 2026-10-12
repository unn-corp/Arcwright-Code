// oxlint-disable unicorn/prefer-add-event-listener, unicorn/require-post-message-target-origin -- Android WebMessage listener exposes onmessage/postMessage without DOM event or targetOrigin APIs.
/** Restricted native auth RPC. Session/device/refresh credentials never cross this boundary. */
export interface AndroidAuthStatus {
  readonly protocol: 1;
  readonly available: boolean;
  readonly phase: "initializing" | "signedOut" | "signedIn" | "signingIn" | "error" | "unavailable";
  readonly generation: number;
  readonly userId: string | null;
  readonly sessionId: string | null;
  readonly error: string | null;
}
interface AuthBridge {
  postMessage(message: string): void;
  onmessage: ((event: { readonly data: string }) => void) | null;
}
declare global {
  interface Window {
    t3ConnectAuth?: AuthBridge;
  }
}
const initialStatus: AndroidAuthStatus = {
  protocol: 1,
  available: true,
  phase: "initializing",
  generation: 0,
  userId: null,
  sessionId: null,
  error: null,
};
const phases = new Set([
  "initializing",
  "signedOut",
  "signedIn",
  "signingIn",
  "error",
  "unavailable",
]);
export function isAndroidAuthStatus(value: unknown): value is AndroidAuthStatus {
  if (typeof value !== "object" || value === null) return false;
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).some(
      (key) =>
        !["protocol", "available", "phase", "generation", "userId", "sessionId", "error"].includes(
          key,
        ),
    )
  )
    return false;
  return (
    data.protocol === 1 &&
    typeof data.available === "boolean" &&
    typeof data.phase === "string" &&
    phases.has(data.phase) &&
    typeof data.generation === "number" &&
    Number.isSafeInteger(data.generation) &&
    data.generation >= 0 &&
    (data.userId === null || typeof data.userId === "string") &&
    (data.sessionId === null || typeof data.sessionId === "string") &&
    (data.error === null || typeof data.error === "string") &&
    (data.phase !== "signedIn" ||
      (typeof data.userId === "string" && typeof data.sessionId === "string"))
  );
}

export function createAndroidAuthStore(readBridge: () => AuthBridge | undefined) {
  let snapshot = initialStatus;
  const listeners = new Set<() => void>();
  let attached: AuthBridge | undefined;
  let sequence = 0;
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const update = (value: unknown) => {
    if (!isAndroidAuthStatus(value) || value.generation < snapshot.generation) return;
    if (JSON.stringify(value) === JSON.stringify(snapshot)) return;
    snapshot = value;
    for (const listener of listeners) listener();
  };
  const fail = () => {
    snapshot = {
      ...snapshot,
      phase: snapshot.userId ? "signedIn" : "error",
      error: "Account connection is unavailable. Please try again.",
    };
    for (const listener of listeners) listener();
  };
  const request = (
    action: "status" | "subscribe" | "signIn" | "getRelayToken" | "signOut",
    forceRefresh?: boolean,
  ): Promise<unknown> => {
    const bridge = readBridge();
    if (!bridge) {
      fail();
      return Promise.reject(new Error("Native account sign-in is unavailable."));
    }
    if (attached !== bridge) {
      attached = bridge;
      bridge.onmessage = ({ data }) => {
        if (attached !== bridge || data.length > 65536) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          return;
        }
        if (typeof parsed !== "object" || parsed === null) return;
        const message = parsed as Record<string, unknown>;
        if ("event" in message) {
          update(message.event);
          return;
        }
        if (typeof message.id !== "string") return;
        const call = pending.get(message.id);
        if (!call) return;
        pending.delete(message.id);
        clearTimeout(call.timer);
        if (typeof message.error === "string") call.reject(new Error(message.error));
        else {
          update(message.result);
          call.resolve(message.result);
        }
      };
    }
    const id = `auth_${++sequence}`;
    return new Promise((resolve, reject) => {
      if (pending.size >= 32) {
        reject(new Error("Too many account requests."));
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Account request timed out. Please try again."));
      }, 15_000);
      pending.set(id, { resolve, reject, timer });
      try {
        bridge.postMessage(
          JSON.stringify({ id, action, ...(forceRefresh === undefined ? {} : { forceRefresh }) }),
        );
      } catch {
        pending.delete(id);
        clearTimeout(timer);
        fail();
        reject(new Error("Native account connection failed."));
      }
    });
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start: () => {
      void request("subscribe").catch(fail);
    },
    signIn: () => {
      void request("signIn").catch(fail);
    },
    signOut: async () => {
      try {
        await request("signOut");
      } catch (error) {
        fail();
        throw error;
      }
    },
    getRelayToken: async (forceRefresh = false, captured = snapshot): Promise<string | null> => {
      if (
        snapshot.generation !== captured.generation ||
        snapshot.userId !== captured.userId ||
        snapshot.sessionId !== captured.sessionId
      )
        return null;
      if (captured.phase !== "signedIn") throw new Error("Account session is not ready.");
      const result = await request("getRelayToken", forceRefresh);
      if (typeof result !== "object" || result === null)
        throw new Error("Invalid account token response.");
      const data = result as Record<string, unknown>;
      if (
        snapshot.generation !== captured.generation ||
        snapshot.userId !== captured.userId ||
        snapshot.sessionId !== captured.sessionId ||
        data.generation !== captured.generation ||
        data.userId !== captured.userId ||
        data.sessionId !== captured.sessionId
      )
        return null;
      if (typeof data.token !== "string" || data.token.length > 32768)
        throw new Error("Invalid account token response.");
      return data.token;
    },
    dispose: () => {
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject(new Error("Account connection closed."));
      }
      pending.clear();
      if (attached) attached.onmessage = null;
      attached = undefined;
      listeners.clear();
    },
  };
}
export const androidAuthStore = createAndroidAuthStore(() =>
  typeof window === "undefined" ? undefined : window.t3ConnectAuth,
);
