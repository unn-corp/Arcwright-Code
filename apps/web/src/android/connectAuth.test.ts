import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createAndroidAuthStore, type AndroidAuthStatus } from "./connectAuth";

const stores: ReturnType<typeof createAndroidAuthStore>[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.useRealTimers();
});
function fixture() {
  const messages: { id: string; action: string; forceRefresh?: boolean }[] = [];
  const bridge = {
    onmessage: null as ((event: { data: string }) => void) | null,
    postMessage: (raw: string) => {
      messages.push(JSON.parse(raw));
    },
  };
  const store = createAndroidAuthStore(() => bridge);
  stores.push(store);
  const emit = (data: unknown) => bridge.onmessage?.({ data: JSON.stringify(data) });
  const status: AndroidAuthStatus = {
    protocol: 1,
    available: true,
    phase: "signedIn",
    generation: 1,
    userId: "user_1",
    sessionId: "session_1",
    error: null,
  };
  store.start();
  emit({ id: messages[0]!.id, result: status });
  return { store, bridge, messages, emit, status };
}
describe("native managed auth store", () => {
  it("reads bounded public profile metadata without changing strict protocol-1 status", async () => {
    const { store, messages, emit, status } = fixture();
    const promise = store.getParticipantProfile();
    const request = messages.at(-1)!;
    expect(request.action).toBe("getParticipantProfile");
    const profile = {
      name: "Alice",
      photo: "https://example.test/alice.png",
      accounts: [{ id: "google", label: "Google: Alice", photo: null }],
    };
    emit({ id: request.id, result: { ...status, profile } });
    await expect(promise).resolves.toEqual(profile);
    expect(store.getSnapshot()).toEqual(status);
  });
  it("drops a delayed profile from a replaced session and rejects a stale reader before dispatch", async () => {
    const { store, messages, emit, status } = fixture();
    const promise = store.getParticipantProfile();
    const request = messages.at(-1)!;
    emit({ event: { ...status, generation: 2, sessionId: "new-session" } });
    emit({
      id: request.id,
      result: { ...status, profile: { name: "Old Alice", photo: null, accounts: [] } },
    });
    await expect(promise).resolves.toBeNull();
    const count = messages.length;
    await expect(store.getParticipantProfile(status)).resolves.toBeNull();
    expect(messages).toHaveLength(count);
  });
  it("keeps account auth when optional metadata is unavailable or malformed", async () => {
    const { store, messages, emit, status } = fixture();
    const unavailable = store.getParticipantProfile();
    emit({ id: messages.at(-1)!.id, error: "Unsupported account action" });
    await expect(unavailable).resolves.toBeNull();
    const malformed = store.getParticipantProfile();
    emit({
      id: messages.at(-1)!.id,
      result: { ...status, profile: { name: "Alice", photo: "javascript:unsafe", accounts: [] } },
    });
    await expect(malformed).resolves.toBeNull();
    expect(store.getSnapshot()).toEqual(status);
  });
  it("exposes observable native account state and only requests the fixed token capability", async () => {
    const { store, messages, emit, status } = fixture();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const promise = store.getRelayToken(true);
    const request = messages.at(-1)!;
    expect(request).toEqual({ id: request.id, action: "getRelayToken", forceRefresh: true });
    emit({
      id: request.id,
      result: {
        token: "short-lived-relay-jwt",
        generation: status.generation,
        userId: status.userId,
        sessionId: status.sessionId,
      },
    });
    await expect(promise).resolves.toBe("short-lived-relay-jwt");
    emit({ event: { ...status, error: "Network temporarily unavailable" } });
    expect(store.getSnapshot().phase).toBe("signedIn");
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });
  it("discards token renewal from the previous account after logout or account replacement", async () => {
    const { store, messages, emit, status } = fixture();
    const promise = store.getRelayToken();
    const request = messages.at(-1)!;
    emit({
      event: { ...status, phase: "signedOut", generation: 2, userId: null, sessionId: null },
    });
    emit({
      id: request.id,
      result: {
        token: "stale",
        generation: status.generation,
        userId: status.userId,
        sessionId: status.sessionId,
      },
    });
    await expect(promise).resolves.toBeNull();
    emit({ event: status });
    expect(store.getSnapshot().generation).toBe(2);
  });
  it("rejects a reader retained by the previous account or session before it can request a token", async () => {
    const { store, messages, emit, status } = fixture();
    emit({ event: { ...status, generation: 2, sessionId: "replacement-session" } });
    const count = messages.length;
    await expect(store.getRelayToken(false, status)).resolves.toBeNull();
    expect(messages).toHaveLength(count);
  });
  it("ignores malformed/foreign replies and bounds unresolved calls", async () => {
    vi.useFakeTimers();
    const { store, messages, emit } = fixture();
    const promise = store.getRelayToken();
    const request = messages.at(-1)!;
    emit({ id: "unrelated", result: "credential" });
    emit({ event: { phase: "signedOut" } });
    expect(store.getSnapshot().phase).toBe("signedIn");
    const rejected = expect(promise).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(15001);
    await rejected;
    emit({ id: request.id, result: { token: "late" } });
    expect(store.getSnapshot().phase).toBe("signedIn");
  });
  it("reports missing bridge as readiness failure and never signed out", () => {
    const store = createAndroidAuthStore(() => undefined);
    stores.push(store);
    store.start();
    expect(store.getSnapshot().phase).toBe("error");
    expect(store.getSnapshot().userId).toBeNull();
  });
});
