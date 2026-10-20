import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: () => DEFAULT_UNIFIED_SETTINGS,
  useUpdatePrimarySettings: () => vi.fn(),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ to, hash, children }: { to: string; hash: string; children: ReactNode }) => (
    <a href={`${to}#${hash}`}>{children}</a>
  ),
}));
vi.mock("./settingsLayout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settingsLayout")>()),
  SettingsPageContainer: ({ children }: { children: ReactNode }) => children,
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) =>
    title === "Background services" ? <section>{children}</section> : null,
  SettingsRow: ({ control }: { control: ReactNode }) => control,
}));
import { AutomationSettingsPanel } from "./AutomationSettings";

it("links background services to their sole editing locations", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<AutomationSettingsPanel />));
    expect([...container.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
      "/settings/providers#provider-update-checks",
      "/settings/general#background-activity",
    ]);
    expect(container.querySelector('input, button, [role="switch"], select')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
