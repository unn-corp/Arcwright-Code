import { act, type ReactNode, type ReactElement, cloneElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { MessageId, ThreadId, DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
const state = vi.hoisted(() => ({ settings: null as typeof DEFAULT_CLIENT_SETTINGS | null }));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    select(state.settings ?? DEFAULT_CLIENT_SETTINGS),
  persistClientSettingsUpdate: async (
    update: (settings: typeof DEFAULT_CLIENT_SETTINGS) => typeof DEFAULT_CLIENT_SETTINGS,
  ) => {
    state.settings = update(state.settings ?? DEFAULT_CLIENT_SETTINGS);
    return state.settings;
  },
}));
vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
  PopoverPopup: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactElement }) => cloneElement(render),
  TooltipPopup: () => null,
}));
import { ParticipantChip } from "./ParticipantChip";
import { ComposerMessageReply } from "./MessageReplies";
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
  state.settings = null;
});
it("shows the default human label once without a duplicate initials badge", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderer = create(
      <ParticipantChip
        participant={{ kind: "human", id: "legacy-user", name: "You", photo: null }}
      />,
    );
  });
  const chip = renderer!.root.findByProps({ "data-participant-kind": "User" });
  expect(chip.findAll((node) => node.children.includes("YO"))).toHaveLength(0);
  expect(chip.findAll((node) => node.children.includes("You"))).toHaveLength(1);
});

it("falls back after a broken photo and retries a replacement", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const participant = {
    kind: "human" as const,
    id: "alice",
    name: "Alice Smith",
    photo: "https://example.com/broken.png",
  };
  await act(async () => {
    renderer = create(<ParticipantChip participant={participant} />);
  });
  await act(async () => renderer!.root.findByType("img").props.onError());
  expect(renderer!.root.findAllByType("img")).toHaveLength(0);
  expect(JSON.stringify(renderer!.toJSON())).toContain("AS");
  await act(async () =>
    renderer!.update(
      <ParticipantChip
        participant={{ ...participant, photo: "https://example.com/replaced.png" }}
      />,
    ),
  );
  expect(renderer!.root.findByType("img").props.src).toBe("https://example.com/replaced.png");
});
it("avatar stacks keep names and models accessible", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderer = create(
      <ParticipantChip
        variant="avatar"
        participant={{ kind: "agent", id: "child", name: "Reviewer", model: "gpt-6" }}
      />,
    );
  });
  expect(renderer!.root.findByProps({ "data-participant-id": "child" }).props["aria-label"]).toBe(
    "Reviewer, GPT-6",
  );
});

it("saves a color for one agent and restores its automatic color", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const participant = { kind: "agent" as const, id: "reviewer", name: "Reviewer", model: "gpt-6" };
  await act(async () => {
    renderer = create(<ParticipantChip participant={participant} />);
  });
  await act(async () =>
    renderer!.root
      .findByProps({ "aria-label": "Agent color" })
      .props.onChange({ target: { value: "#aabbcc" } }),
  );
  expect(state.settings?.agentColorOverrides).toEqual({ reviewer: "#aabbcc" });
  await act(async () => renderer!.update(<ParticipantChip participant={participant} />));
  expect(renderer!.root.findByProps({ "aria-label": "Agent color" }).props.value).toBe("#aabbcc");
  const reset = renderer!.root
    .findAllByType("button")
    .find((button) => button.children.includes("Use automatic color"))!;
  await act(async () => reset.props.onClick());
  expect(state.settings?.agentColorOverrides).toEqual({});
  await act(async () => renderer!.update(<ParticipantChip participant={participant} />));
  expect(renderer!.root.findByProps({ "aria-label": "Agent color" }).props.value).not.toBe(
    "#aabbcc",
  );
});

it("updates existing chat and reply chips when the saved profile changes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const recorded = {
    kind: "human" as const,
    id: "account:alice",
    name: "Old Name",
    photo: "https://example.com/old.png",
  };
  const profile = { id: recorded.id, name: "Alice Updated", photo: "data:image/webp;base64,AA==" };
  state.settings = {
    ...DEFAULT_CLIENT_SETTINGS,
    activeParticipantProfile: recorded.id,
    participantProfiles: {
      [recorded.id]: { participant: profile, initialized: true, accounts: [] },
    },
  };
  await act(async () => {
    renderer = create(
      <>
        <ParticipantChip participant={recorded} />
        <ParticipantChip participant={recorded} variant="compact" />
        <ParticipantChip
          participant={{ kind: "human", id: "legacy-user", name: "You", photo: null }}
        />
      </>,
    );
  });
  expect(renderer!.root.findAllByType("img").map((image) => image.props.src)).toEqual([
    profile.photo,
    profile.photo,
    profile.photo,
  ]);
  expect(JSON.stringify(renderer!.toJSON())).not.toContain("Old Name");
  state.settings = {
    ...state.settings!,
    participantProfiles: {
      [recorded.id]: {
        participant: { ...profile, name: "Alice Again", photo: null },
        initialized: true,
        accounts: [],
      },
    },
  };
  await act(async () =>
    renderer!.update(
      <>
        <ParticipantChip participant={recorded} />
        <ParticipantChip participant={recorded} variant="compact" />
        <ParticipantChip
          participant={{ kind: "human", id: "legacy-user", name: "You", photo: null }}
        />
      </>,
    ),
  );
  expect(renderer!.root.findAllByType("img")).toHaveLength(0);
  expect(JSON.stringify(renderer!.toJSON())).toContain("Alice Again");
  expect(JSON.stringify(renderer!.toJSON())).not.toContain("Alice Updated");
});

it("refreshes the composer reply name without changing the stored reply target", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const author = { id: "account:alice", name: "Old Alice", photo: null };
  const target = {
    threadId: ThreadId.make("chat"),
    messageId: MessageId.make("question"),
    role: "user" as const,
    text: "Question",
    author,
  };
  state.settings = {
    ...DEFAULT_CLIENT_SETTINGS,
    activeParticipantProfile: author.id,
    participantProfiles: {
      [author.id]: {
        participant: { ...author, name: "Current Alice" },
        initialized: true,
        accounts: [],
      },
    },
  };
  await act(async () => {
    renderer = create(<ComposerMessageReply target={target} onCancel={() => {}} />);
  });
  expect(JSON.stringify(renderer!.toJSON())).toContain("Current Alice");
  expect(JSON.stringify(renderer!.toJSON())).not.toContain("Old Alice");
  expect(target.author.name).toBe("Old Alice");
});
