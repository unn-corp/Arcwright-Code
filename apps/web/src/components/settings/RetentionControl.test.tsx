import { act, type ReactNode, useState } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { RetentionControl } from "./RetentionControl";

vi.mock("../ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: ReactNode;
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectValue: () => null,
  SelectPopup: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));
vi.mock("../ui/number-field", () => ({
  NumberField: ({
    value,
    onValueCommitted,
    children,
  }: {
    value: number;
    onValueCommitted: (value: number | null) => void;
    children: ReactNode;
  }) => (
    <div>
      <input
        value={value}
        onChange={(event) =>
          onValueCommitted(event.target.value === "" ? null : Number(event.target.value))
        }
        readOnly
      />
      {children}
    </div>
  ),
  NumberFieldGroup: ({ children }: { children: ReactNode }) => <>{children}</>,
  NumberFieldInput: () => null,
  NumberFieldDecrement: () => null,
  NumberFieldIncrement: () => null,
}));

let renderer: ReactTestRenderer;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

function Retention({ initial, minimum = 1 }: { initial: number | null; minimum?: number }) {
  const [value, setValue] = useState(initial);
  return <RetentionControl label="Worktrees" value={value} minimum={minimum} onChange={setValue} />;
}

async function changeMode(value: string) {
  await act(() => renderer.root.findByType("select").props.onChange({ target: { value } }));
}
async function commitDays(value: string) {
  await act(() => renderer.root.findByType("input").props.onChange({ target: { value } }));
}

describe("retention policy editing", () => {
  it("shows days only for deletion and preserves the existing eight-day enable default", async () => {
    await act(() => {
      renderer = create(<Retention initial={null} />);
    });
    expect(renderer.root.findAllByType("input")).toHaveLength(0);
    await changeMode("delete");
    expect(renderer.root.findByType("input").props.value).toBe(8);
    await commitDays("31");
    expect(renderer.root.findByType("input").props.value).toBe(31);
    await changeMode("keep");
    expect(renderer.root.findAllByType("input")).toHaveLength(0);
  });

  it("keeps a saved duration and validates edits without replacing it on an empty commit", async () => {
    await act(() => {
      renderer = create(<Retention initial={42} />);
    });
    expect(renderer.root.findByType("input").props.value).toBe(42);
    await commitDays("");
    expect(renderer.root.findByType("input").props.value).toBe(42);
    await commitDays("-1");
    expect(renderer.root.findByType("input").props.value).toBe(1);
    await commitDays("4000");
    expect(renderer.root.findByType("input").props.value).toBe(3650);
  });

  it("allows zero days for settled worktrees", async () => {
    await act(() => {
      renderer = create(<Retention initial={0} minimum={0} />);
    });
    expect(renderer.root.findByType("input").props.value).toBe(0);
    await commitDays("-2");
    expect(renderer.root.findByType("input").props.value).toBe(0);
  });
});
