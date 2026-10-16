import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts";
const state = vi.hoisted(() => ({
  user: null as null | {
    id: string;
    fullName: string;
    username: string;
    hasImage: boolean;
    imageUrl: string;
    externalAccounts: {
      id: string;
      provider: string;
      username: string;
      emailAddress: string;
      imageUrl: string;
    }[];
  },
  settings: null as ClientSettings | null,
  refresh: null as (() => Promise<void>) | null,
}));
vi.mock("@clerk/react", () => ({
  useUser: () => ({
    isLoaded: true,
    user: state.user ? { ...state.user, reload: async () => state.user } : null,
  }),
  useClerk: () => ({
    get user() {
      return state.user;
    },
    get session() {
      return state.user ? { id: `session-${state.user.id}` } : null;
    },
  }),
}));
vi.mock("./participantProfileRefresh", () => ({
  startParticipantProfileRefresh: (refresh: () => Promise<void>) => {
    state.refresh = refresh;
    return () => {
      state.refresh = null;
    };
  },
}));
vi.mock("../../hooks/useSettings", () => ({
  persistClientSettingsUpdate: async (update: (settings: ClientSettings) => ClientSettings) => {
    state.settings = update(state.settings!);
    return state.settings;
  },
}));
import { ParticipantProfileSync } from "./ParticipantProfileSync";
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
  state.user = null;
});
it("seeds personal sign-in, preserves edits and separates accounts and sign-out", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.settings = DEFAULT_CLIENT_SETTINGS;
  state.user = {
    id: "alice",
    fullName: "Alice",
    username: "alice",
    hasImage: true,
    imageUrl: "https://example.com/alice.png",
    externalAccounts: [
      {
        id: "github",
        provider: "github",
        username: "alice",
        emailAddress: "",
        imageUrl: "https://example.com/alice.png",
      },
    ],
  };
  await act(async () => {
    renderer = create(<ParticipantProfileSync />);
  });
  expect(state.settings.participantProfiles["account:alice"]?.participant.photo).toBe(
    "https://example.com/alice.png",
  );
  const first = state.settings.participantProfiles["account:alice"]!;
  state.settings = {
    ...state.settings,
    participantProfiles: {
      ...state.settings.participantProfiles,
      "account:alice": {
        ...first,
        photoSource: "custom",
        participant: { ...first.participant, name: "My name", photo: null },
      },
    },
  };
  state.user = {
    ...state.user,
    imageUrl: "https://example.com/google.png",
    externalAccounts: [
      ...state.user.externalAccounts,
      {
        id: "google",
        provider: "google",
        username: "",
        emailAddress: "alice@example.com",
        imageUrl: "https://example.com/google.png",
      },
    ],
  };
  await act(async () => renderer!.update(<ParticipantProfileSync />));
  expect(state.settings.participantProfiles["account:alice"]?.participant).toMatchObject({
    name: "My name",
    photo: null,
  });
  expect(state.settings.participantProfiles["account:alice"]?.accounts).toHaveLength(2);
  state.user = {
    ...state.user,
    id: "bob",
    fullName: "Bob",
    imageUrl: "https://example.com/bob.png",
    externalAccounts: [],
  };
  await act(async () => renderer!.update(<ParticipantProfileSync />));
  expect(state.settings.activeParticipantProfile).toBe("account:bob");
  expect(state.settings.participantProfiles["account:bob"]?.participant.name).toBe("Bob");
  state.user = null;
  await act(async () => renderer!.update(<ParticipantProfileSync />));
  expect(state.settings.activeParticipantProfile).toBe("local");
  expect(state.settings.participantProfiles["account:alice"]?.participant.name).toBe("My name");
});
it("refreshes the canonical photo on another client while retaining its chosen name and explicit account initials", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.settings = DEFAULT_CLIENT_SETTINGS;
  state.user = {
    id: "alice",
    fullName: "Alice",
    username: "alice",
    hasImage: true,
    imageUrl: "https://example.com/first.png",
    externalAccounts: [],
  };
  await act(async () => {
    renderer = create(<ParticipantProfileSync />);
  });
  const first = state.settings.participantProfiles["account:alice"]!;
  state.settings = {
    ...state.settings,
    participantProfiles: {
      "account:alice": { ...first, participant: { ...first.participant, name: "Chosen name" } },
    },
  };
  state.user = { ...state.user, imageUrl: "https://example.com/updated.png" };
  await act(async () => state.refresh!());
  expect(state.settings.participantProfiles["account:alice"]?.participant).toMatchObject({
    name: "Chosen name",
    photo: "https://example.com/updated.png",
  });
  state.user = {
    ...state.user,
    hasImage: false,
    externalAccounts: [
      {
        id: "google",
        provider: "google",
        username: "alice",
        emailAddress: "",
        imageUrl: "https://example.com/google.png",
      },
    ],
  };
  await act(async () => state.refresh!());
  expect(state.settings.participantProfiles["account:alice"]?.participant.photo).toBeNull();
  const unchanged = state.settings;
  await act(async () => state.refresh!());
  expect(state.settings).toBe(unchanged);
});
