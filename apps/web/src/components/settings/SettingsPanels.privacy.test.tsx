import { DEFAULT_CLIENT_SETTINGS, DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
  useLocation: <T,>({ select }: { select: (location: { hash: string; state: object }) => T }) =>
    select({ hash: "", state: {} }),
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => DEFAULT_UNIFIED_SETTINGS,
  useUpdateScopedSettings: () => vi.fn(),
  useScopedSettingsMixed: () => false,
  useScopedSettingsWriteAllowed: () => false,
  useClearProjectOverrides: () => vi.fn(),
  useClearScopedSettings: () => vi.fn(),
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { environmentIds: [] },
    environment: null,
    connectedEnvironments: [],
  }),
  useOptionalSettingsScope: () => null,
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: <T,>(select?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => T) =>
    select ? select(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS,
  useUpdateClientSettings: () => vi.fn(),
  usePrimarySettingsAvailable: () => false,
}));
vi.mock("./useScopedModelAvailability", () => ({ useScopedModelDisabledReason: () => null }));
// Mount the actual About row and Button; unrelated settings sections do not acquire live state.
vi.mock("./settingsLayout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./settingsLayout")>();
  return {
    ...actual,
    SettingsSection: (props: Parameters<typeof actual.SettingsSection>[0]) =>
      props.title === "About" ? <actual.SettingsSection {...props} /> : null,
  };
});
vi.mock("./ProjectDefaultsSettings", () => ({ ProjectDefaultsSettings: () => null }));
vi.mock("./PwaNotificationSettings", () => ({ PwaNotificationSettings: () => null }));
vi.mock("./PwaAppUpdateSettings", () => ({ PwaAppUpdateSettings: () => null }));
vi.mock("./RunLimitsSettings", () => ({ RunLimitsSettings: () => null }));
vi.mock("./AppUpdateSettings", () => ({ AppUpdateSettings: () => null }));
vi.mock("./ClientBuildIdentity", () => ({ ClientBuildIdentity: () => null }));

import { GeneralSettingsPanel } from "./SettingsPanels";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each(["owned", "legacy", "cloudless"])(
  "opens the selected %s privacy policy from Settings About",
  async (mode) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubEnv("VITE_CONNECT_MODE", mode);
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", `pk_test_${btoa("sample.accounts.dev$")}`);
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "arcwright-relay");
    vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "client_sample");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    vi.stubEnv("VITE_CONNECT_HOSTED_APP_URL", "https://selected.example.test");
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://appassets.androidplatform.net");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<GeneralSettingsPanel />));
      const policy = [...container.querySelectorAll("a")].find(
        (anchor) => anchor.textContent === "View policy",
      )!;
      const navigate = vi.fn();
      policy.addEventListener("click", (event) => {
        event.preventDefault();
        navigate(policy.href, policy.target);
      });
      await act(async () => policy.click());
      expect(navigate).toHaveBeenCalledWith(
        mode === "owned"
          ? "https://selected.example.test/privacy.html"
          : "https://t3.codes/privacy-policy",
        "_blank",
      );
      if (mode === "owned") {
        expect(container.textContent).toContain("account and connection information");
        expect(container.textContent).not.toContain("anonymous usage data");
      } else {
        expect(container.textContent).toContain("anonymous usage data");
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  },
);
