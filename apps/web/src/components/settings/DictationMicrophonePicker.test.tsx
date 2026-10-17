import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { DictationMicrophonePicker } from "./DictationMicrophonePicker";

const { hold, release, toast } = vi.hoisted(() => ({
  hold: vi.fn(),
  release: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("../../state/updateInteraction", () => ({ beginClientUpdateUpload: hold }));
vi.mock("../ui/toast", () => ({ toastManager: { add: toast } }));
vi.mock("../ui/button", () => ({
  Button: (props: React.ComponentProps<"button">) => <button {...props} />,
}));
vi.mock("../ui/select", () => ({
  Select: () => null,
  SelectItem: () => null,
  SelectPopup: () => null,
  SelectTrigger: () => null,
  SelectValue: () => null,
}));
let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it("holds native installation until a pending microphone detection releases its stream, even after unmount", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let grant!: (stream: MediaStream) => void;
  const stop = vi.fn();
  const getUserMedia = vi.fn(
    () =>
      new Promise<MediaStream>((resolve) => {
        grant = resolve;
      }),
  );
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia,
      enumerateDevices: vi.fn().mockResolvedValue([]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  hold.mockImplementation(async () => release);
  await act(async () => {
    renderer = create(<DictationMicrophonePicker value="" onValueChange={() => {}} />);
  });
  await act(async () => {
    renderer!.root.findByType("button").props.onClick();
  });
  expect(hold).toHaveBeenCalledOnce();
  expect(getUserMedia).toHaveBeenCalledOnce();
  expect(release).not.toHaveBeenCalled();
  act(() => renderer!.unmount());
  await act(async () => {
    grant({ getTracks: () => [{ stop }] } as unknown as MediaStream);
  });
  expect(stop).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();
  expect(stop.mock.invocationCallOrder[0]).toBeLessThan(release.mock.invocationCallOrder[0]!);
});

it("does not request microphone permission when native installation has denied admission", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const getUserMedia = vi.fn();
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia,
      enumerateDevices: vi.fn().mockResolvedValue([]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  hold.mockRejectedValueOnce(new Error("An update is being installed."));
  await act(async () => {
    renderer = create(<DictationMicrophonePicker value="" onValueChange={() => {}} />);
  });
  await act(async () => {
    await renderer!.root.findByType("button").props.onClick();
  });
  expect(getUserMedia).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({ description: "An update is being installed." }),
  );
});
