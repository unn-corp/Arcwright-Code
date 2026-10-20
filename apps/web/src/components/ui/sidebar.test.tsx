import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

import { resolveSidebarState } from "./sidebarState";
import { Sidebar, SidebarProvider, useSidebar } from "./sidebar";

vi.mock("~/hooks/useMediaQuery", () => ({ useMediaQuery: () => true }));

it("keeps navigation reachable when the mobile sheet is mounted but closed", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function Navigation() {
    const { openMobile, mobileSheetVisible, toggleSidebar } = useSidebar();
    return (
      <button hidden={openMobile || mobileSheetVisible} onClick={toggleSidebar}>
        Open navigation
      </button>
    );
  }
  function CloseNavigation() {
    const { setOpenMobile } = useSidebar();
    return <button onClick={() => setOpenMobile(false)}>Close navigation</button>;
  }
  try {
    await act(async () =>
      root.render(
        <SidebarProvider>
          <Sidebar>
            <CloseNavigation />
          </Sidebar>
          <Navigation />
        </SidebarProvider>,
      ),
    );
    expect(document.querySelector('[data-mobile="true"]')).not.toBeNull();
    const trigger = container.querySelector("button")!;
    expect(trigger.hidden).toBe(false);
    await act(async () => trigger.click());
    expect(trigger.hidden).toBe(true);
    const close = document.querySelector<HTMLButtonElement>('[data-mobile="true"] button')!;
    await act(async () => close.click());
    await act(async () => {
      await vi.waitFor(() => expect(trigger.hidden).toBe(false));
    });
    expect(document.querySelector('[data-mobile="true"]')).not.toBeNull();
    await act(async () => trigger.click());
    expect(trigger.hidden).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    Reflect.deleteProperty(Element.prototype, "getAnimations");
    vi.unstubAllGlobals();
  }
});

describe("responsive sidebar state", () => {
  it("uses mobile sheet visibility for the shared responsive state", () => {
    expect(resolveSidebarState({ isMobile: true, open: true, openMobile: false })).toBe(
      "collapsed",
    );
    expect(resolveSidebarState({ isMobile: true, open: false, openMobile: true })).toBe("expanded");
    expect(resolveSidebarState({ isMobile: false, open: true, openMobile: false })).toBe(
      "expanded",
    );
  });
});
