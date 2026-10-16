import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts";
import type { ManagedAuth } from "../../auth/managedAuthContext";

const state = vi.hoisted(() => ({
  settings: null as ClientSettings | null,
  auth: null as ManagedAuth | null,
  setProfilePhoto: vi.fn(),
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: () => state.settings!,
  persistClientSettingsUpdate: async (update: (settings: ClientSettings) => ClientSettings) => {
    state.settings = update(state.settings!);
    return state.settings;
  },
}));
vi.mock("../../auth/managedAuthContext", () => ({ useManagedAuth: () => state.auth! }));
vi.mock("../chat/ParticipantChip", () => ({ ParticipantChip: () => null }));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsRow: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../ui/input", () => ({ Input: (props: object) => <input {...props} /> }));
import { ParticipantProfileSettings } from "./ParticipantProfileSettings";

let renderer: ReactTestRenderer | undefined;
const thumbnail = "data:image/webp;base64,AA==";
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.settings = {
    ...DEFAULT_CLIENT_SETTINGS,
    activeParticipantProfile: "account:alice",
    participantProfiles: {
      "account:alice": {
        participant: {
          id: "account:alice",
          name: "Chosen name",
          photo: "https://example.test/old.png",
        },
        initialized: true,
        accounts: [],
        photoSource: "account",
      },
    },
  };
  state.setProfilePhoto.mockReset().mockResolvedValue("https://example.test/uploaded.png");
  state.auth = {
    surface: "android",
    isLoaded: true,
    isSignedIn: true,
    userId: "alice",
    sessionId: "session-a",
    generation: 1,
    error: null,
    isSigningIn: false,
    getRelayToken: async () => null,
    openSignIn: () => {},
    signOut: async () => {},
    openAccountPages: null,
    setProfilePhoto: state.setProfilePhoto,
  };
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn().mockResolvedValue({ width: 96, height: 96, close: vi.fn() }),
  );
  vi.stubGlobal("document", {
    createElement: () => ({
      getContext: () => ({ drawImage: vi.fn() }),
      toDataURL: () => thumbnail,
    }),
  });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
async function mount() {
  await act(async () => {
    renderer = create(<ParticipantProfileSettings />);
  });
}
async function upload() {
  await act(async () =>
    renderer!.root
      .findByProps({ "aria-label": "Upload profile photo" })
      .props.onChange({ currentTarget: { value: "", files: [{ type: "image/png", size: 100 }] } }),
  );
}

it("uploads to the account and stores its canonical photo, retaining the custom chat name", async () => {
  await mount();
  await upload();
  expect(state.setProfilePhoto).toHaveBeenCalledWith(thumbnail);
  expect(state.settings!.participantProfiles["account:alice"]).toMatchObject({
    photoSource: "account",
    participant: { name: "Chosen name", photo: "https://example.test/uploaded.png" },
  });
});
it("removes the account image for Use initials and preserves it when the upload fails", async () => {
  await mount();
  state.setProfilePhoto.mockResolvedValueOnce(null);
  await act(async () =>
    renderer!.root
      .findAllByType("button")
      .find((button) => button.children.includes("Use initials"))!
      .props.onClick(),
  );
  expect(state.setProfilePhoto).toHaveBeenCalledWith(null);
  expect(state.settings!.participantProfiles["account:alice"]?.participant.photo).toBeNull();
  state.setProfilePhoto.mockRejectedValueOnce(new Error("Upload failed"));
  await upload();
  expect(state.settings!.participantProfiles["account:alice"]?.participant.photo).toBeNull();
  expect(renderer!.root.findByProps({ role: "alert" }).children).toContain("Upload failed");
});
it("does not apply an old account upload after the client switches accounts", async () => {
  let finish!: (photo: string) => void;
  state.setProfilePhoto.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  await mount();
  let uploadPromise!: Promise<void>;
  await act(async () => {
    uploadPromise = renderer!.root
      .findByProps({ "aria-label": "Upload profile photo" })
      .props.onChange({ currentTarget: { value: "", files: [{ type: "image/png", size: 100 }] } });
  });
  state.auth = { ...state.auth!, userId: "bob", sessionId: "session-b", generation: 2 };
  state.settings = { ...state.settings!, activeParticipantProfile: "account:bob" };
  await act(async () => {
    renderer!.update(<ParticipantProfileSettings />);
  });
  await act(async () => {
    finish("https://example.test/alice-new.png");
    await uploadPromise;
  });
  expect(state.settings.participantProfiles["account:alice"]?.participant.photo).toBe(
    "https://example.test/old.png",
  );
  expect(state.settings.participantProfiles["account:bob"]).toBeUndefined();
});
it("keeps unsigned local profile uploads on the device", async () => {
  state.settings = { ...state.settings!, activeParticipantProfile: "local" };
  state.auth = { ...state.auth!, isSignedIn: false, userId: null, sessionId: null };
  await mount();
  await upload();
  expect(state.setProfilePhoto).not.toHaveBeenCalled();
  expect(state.settings.participantProfiles.local).toMatchObject({
    photoSource: "custom",
    participant: { photo: thumbnail },
  });
});
