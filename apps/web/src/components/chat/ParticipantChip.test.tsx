import { act, type ReactNode, type ReactElement, cloneElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
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
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
  state.settings = null;
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
