import { act, useRef, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { SettingsSectionNavigation } from "./SettingsSectionNavigation";

vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipPopup: () => null,
  TooltipTrigger: ({
    render,
    children,
  }: {
    render: ReactElement<{ children?: ReactNode }>;
    children: ReactNode;
  }) => ({ ...render, props: { ...render.props, children } }),
}));

afterEach(() => vi.unstubAllGlobals());

it("jumps and focuses sections through ticks and the compact menu, then follows scrolling", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  const scrollTo = vi.fn();
  function Fixture() {
    const scroll = useRef<HTMLDivElement>(null);
    const content = useRef<HTMLDivElement>(null);
    return (
      <>
        <SettingsSectionNavigation scrollRef={scroll} contentRef={content} />
        <div
          ref={(element) => {
            scroll.current = element;
            if (element) {
              element.scrollTo = scrollTo;
              element.getBoundingClientRect = () => new DOMRect(0, 0, 500, 500);
              Object.defineProperty(element, "scrollTop", { value: 0, writable: true });
              Object.defineProperty(element, "clientHeight", { value: 500 });
              Object.defineProperty(element, "scrollHeight", { value: 1500 });
            }
          }}
        >
          <div ref={content}>
            {["Profile", "Performance"].map((label, index) => (
              <section
                key={label}
                data-settings-section={label}
                tabIndex={-1}
                ref={(element) => {
                  if (!element) return;
                  element.getClientRects = () =>
                    [new DOMRect(0, index * 800, 100, 100)] as unknown as DOMRectList;
                  element.getBoundingClientRect = () =>
                    new DOMRect(0, index * 800 - (scroll.current?.scrollTop ?? 0), 100, 100);
                }}
              >
                {label}
              </section>
            ))}
          </div>
        </div>
      </>
    );
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Fixture />));
    container.querySelector<HTMLElement>("[data-settings-section-menu]")!.getBoundingClientRect =
      () => new DOMRect();
    const tick = container.querySelector<HTMLButtonElement>('[aria-label="Go to Performance"]')!;
    await act(async () => tick.click());
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 776, behavior: "instant" });
    expect(document.activeElement?.textContent).toBe("Performance");
    expect(tick.getAttribute("aria-current")).toBe("location");
    const menu = container.querySelector("select")!;
    await act(async () => {
      menu.value = "0";
      menu.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(document.activeElement?.textContent).toBe("Profile");
    const beforeRepeat = scrollTo.mock.calls.length;
    await act(async () => {
      menu.value = "0";
      menu.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(scrollTo.mock.calls.length).toBe(beforeRepeat + 1);
    container.querySelector<HTMLElement>("[data-settings-section-menu]")!.getBoundingClientRect =
      () => new DOMRect(0, 8, 300, 28);
    await act(async () => {
      menu.value = "1";
      menu.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 752, behavior: "instant" });
    const scroll = container.querySelector<HTMLElement>("nav + div")!;
    await act(async () => {
      scroll.scrollTop = 900;
      scroll.dispatchEvent(new Event("scroll"));
      frames.splice(0).forEach((frame) => frame(0));
    });
    expect(tick.getAttribute("aria-current")).toBe("location");
    expect(menu.selectedOptions[0]?.textContent).toBe("Performance (current)");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
