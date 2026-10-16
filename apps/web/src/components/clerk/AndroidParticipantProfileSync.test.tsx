import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts";
import type { AndroidAuthStatus, AndroidParticipantProfile } from "../../android/connectAuth";

const state = vi.hoisted(() => ({
  status: null as AndroidAuthStatus | null,
  listeners: new Set<() => void>(),
  settings: null as ClientSettings | null,
  readProfile: (_status: AndroidAuthStatus): Promise<AndroidParticipantProfile | null> =>
    Promise.resolve(null),
  pendingWrites: null as Array<(settings: ClientSettings) => ClientSettings> | null,
  refresh: null as (() => Promise<void>) | null,
}));
vi.mock("./participantProfileRefresh", () => ({
  startParticipantProfileRefresh: (refresh: () => Promise<void>) => {
    state.refresh = refresh;
    return () => {
      state.refresh = null;
    };
  },
}));
vi.mock("../../android/connectAuth", () => ({
  androidAuthStore: {
    subscribe: (listener: () => void) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    getSnapshot: () => state.status!,
    isCurrentAccount: (captured: AndroidAuthStatus) =>
      state.status!.phase === "signedIn" &&
      captured.generation === state.status!.generation &&
      captured.userId === state.status!.userId &&
      captured.sessionId === state.status!.sessionId,
    getParticipantProfile: (captured: AndroidAuthStatus) => state.readProfile(captured),
  },
}));
vi.mock("../../hooks/useSettings", () => ({
  persistClientSettingsUpdate: async (update: (settings: ClientSettings) => ClientSettings) => {
    if (state.pendingWrites) state.pendingWrites.push(update);
    else state.settings = update(state.settings!);
    return state.settings;
  },
}));
import { AndroidParticipantProfileSync } from "./AndroidParticipantProfileSync";
let renderer: ReactTestRenderer | undefined;
const signedIn = (userId: string, generation: number): AndroidAuthStatus => ({
  protocol: 1,
  available: true,
  phase: "signedIn",
  userId,
  sessionId: `session-${userId}`,
  generation,
  error: null,
});
async function transition(status: AndroidAuthStatus) {
  await act(async () => {
    state.status = status;
    for (const listener of state.listeners) listener();
  });
}
async function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderer = create(<AndroidParticipantProfileSync />);
  });
}
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.listeners.clear();
  state.pendingWrites = null;
  vi.unstubAllGlobals();
});
it("seeds native personal metadata, preserves manual edits, and switches accounts and sign-out", async () => {
  state.settings = DEFAULT_CLIENT_SETTINGS;
  state.status = signedIn("alice", 1);
  state.readProfile = async (status) => ({
    name: status.userId === "alice" ? "Alice" : "Bob",
    photo: "https://example.test/avatar.png",
    accounts: [{ id: "google", label: "Google: Alice", photo: null }],
  });
  await mount();
  expect(state.settings!.participantProfiles["account:alice"]!.participant).toEqual({
    id: "account:alice",
    name: "Alice",
    photo: "https://example.test/avatar.png",
  });
  const first = state.settings!.participantProfiles["account:alice"]!;
  state.settings = {
    ...state.settings!,
    participantProfiles: {
      ...state.settings!.participantProfiles,
      "account:alice": {
        ...first,
        photoSource: "custom",
        participant: { ...first.participant, name: "My name", photo: null },
      },
    },
  };
  await transition(signedIn("bob", 2));
  expect(state.settings!.activeParticipantProfile).toBe("account:bob");
  await transition(signedIn("alice", 3));
  expect(state.settings!.participantProfiles["account:alice"]!.participant).toMatchObject({
    name: "My name",
    photo: null,
  });
  await transition({ ...signedIn("alice", 4), phase: "signedOut", userId: null, sessionId: null });
  expect(state.settings!.activeParticipantProfile).toBe("local");
  expect(state.settings!.participantProfiles["account:alice"]!.participant.name).toBe("My name");
});
it("refreshes native account photos and removal across clients without repeated identical writes", async () => {
  state.settings = DEFAULT_CLIENT_SETTINGS;
  state.status = signedIn("alice", 1);
  state.readProfile = async () => ({
    name: "Alice",
    photo: "https://example.test/first.png",
    accounts: [],
  });
  await mount();
  state.readProfile = async () => ({
    name: "Alice",
    photo: "https://example.test/replaced.png",
    accounts: [],
  });
  await act(async () => state.refresh!());
  expect(state.settings!.participantProfiles["account:alice"]?.participant.photo).toBe(
    "https://example.test/replaced.png",
  );
  state.readProfile = async () => ({
    name: "Alice",
    photo: null,
    accounts: [{ id: "google", label: "Google", photo: "https://example.test/google.png" }],
  });
  await act(async () => state.refresh!());
  expect(state.settings!.participantProfiles["account:alice"]?.participant.photo).toBeNull();
  const unchanged = state.settings;
  await act(async () => state.refresh!());
  expect(state.settings).toBe(unchanged);
});
it("cannot seed or activate an old account from a delayed native profile or queued persistence callback", async () => {
  state.settings = DEFAULT_CLIENT_SETTINGS;
  state.status = signedIn("alice", 1);
  let complete: (value: AndroidParticipantProfile) => void = () => {
    throw new Error("Profile read did not start");
  };
  state.readProfile = () =>
    new Promise((resolve) => {
      complete = resolve;
    });
  await mount();
  expect(state.settings!.activeParticipantProfile).toBe("account:alice");
  state.readProfile = async () => ({ name: "Bob", photo: null, accounts: [] });
  await transition(signedIn("bob", 2));
  state.pendingWrites = [];
  await act(async () => complete({ name: "Old Alice", photo: null, accounts: [] }));
  for (const update of state.pendingWrites) state.settings = update(state.settings!);
  state.pendingWrites = null;
  expect(state.settings!.activeParticipantProfile).toBe("account:bob");
  expect(state.settings!.participantProfiles["account:alice"]).toBeUndefined();
  expect(state.settings!.participantProfiles["account:bob"]!.participant.name).toBe("Bob");
});
it("retains manual native profiles when an older bridge has no public profile capability", async () => {
  state.settings = {
    ...DEFAULT_CLIENT_SETTINGS,
    participantProfiles: {
      ...DEFAULT_CLIENT_SETTINGS.participantProfiles,
      "account:alice": {
        initialized: true,
        participant: { id: "account:alice", name: "Manual Alice", photo: null },
        accounts: [{ id: "kept", label: "Saved account", photo: null }],
      },
    },
  };
  state.status = signedIn("alice", 1);
  state.readProfile = async () => null;
  await mount();
  expect(state.settings!.participantProfiles["account:alice"]!.participant.name).toBe(
    "Manual Alice",
  );
  expect(state.settings!.participantProfiles["account:alice"]!.accounts).toHaveLength(1);
  await transition(signedIn("bob", 2));
  expect(state.settings!.participantProfiles["account:bob"]!.participant).toEqual({
    id: "account:bob",
    name: "You",
    photo: null,
  });
});
