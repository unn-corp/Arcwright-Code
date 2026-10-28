import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ManagedAuthContext, type ManagedAuth } from "../../auth/managedAuthContext";
import { T3ConnectSidebarAvatar, T3ConnectSidebarSignIn } from "./T3ConnectSidebarSignIn";
import { useT3ConnectAccountPage } from "./T3ConnectAccountPages";
import type { CloudPublicConfig } from "../../cloud/publicConfig";

vi.mock("@clerk/react", () => ({
  UserButton: () => {
    throw new Error("Native UI must not mount a web Clerk UserButton");
  },
}));
vi.mock("../../cloud/publicConfig", () => ({
  hasCloudPublicConfig: () => true,
  resolveRelayTracingConfig: () => null,
  resolveCloudPublicConfig: (): CloudPublicConfig => ({
    connectMode: "cloudless",
    hostedAppUrl: null,
    clerkPublishableKey: null,
    clerkJwtTemplate: null,
    relayUrl: null,
    relayTracing: { tracesUrl: null, tracesDataset: null, tracesToken: null },
  }),
}));
vi.mock("./T3ConnectUserProfilePage", () => ({
  T3ConnectUserProfilePage: () => <p>Existing Connect account content</p>,
}));
vi.mock("./MobileClientsUserProfilePage", () => ({
  MobileClientsUserProfilePage: () => <p>Existing mobile-client account content</p>,
}));
// The sidebar primitive expects its layout provider; keep its children/actions intact for the account boundary test.
vi.mock("../ui/sidebar", () => ({
  SidebarMenu: "div",
  SidebarMenuItem: "div",
  SidebarMenuButton: "button",
}));

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});
function AccountPageEntry() {
  const account = useT3ConnectAccountPage();
  return (
    <>
      <button onClick={() => account.open?.()}>Open account page</button>
      {account.portals}
    </>
  );
}
async function render(auth: ManagedAuth) {
  if (!container) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () =>
    root!.render(
      <ManagedAuthContext value={auth}>
        <T3ConnectSidebarAvatar />
        <T3ConnectSidebarSignIn />
        <AccountPageEntry />
      </ManagedAuthContext>,
    ),
  );
}
function account(): ManagedAuth {
  return {
    surface: "android",
    isLoaded: true,
    isSignedIn: true,
    userId: "native-user",
    sessionId: "native-session",
    generation: 1,
    error: null,
    isSigningIn: false,
    getRelayToken: async () => null,
    openSignIn: vi.fn(),
    signOut: vi.fn(async () => {}),
    openAccountPages: null,
  };
}
describe("APK account UI without a web Clerk provider", () => {
  it("shows an unavailable native authority without offering sign-in retry", async () => {
    const auth = {
      ...account(),
      isLoaded: false,
      isSignedIn: false,
      userId: null,
      sessionId: null,
      isUnavailable: true,
      error: "Use your paired environments and contact your maintainer.",
    };
    await render(auth);
    expect(container!.textContent).toContain(auth.error);
    const button = Array.from(container!.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Arcwright Connect account unavailable"),
    )!;
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    expect(auth.openSignIn).not.toHaveBeenCalled();
  });
  it("opens the reused account pages in an app dialog and shows native sign-in after logout", async () => {
    const auth = account();
    await render(auth);
    expect(container!.querySelector('[aria-label="Arcwright Connect account"]')).not.toBeNull();
    const opener = Array.from(container!.querySelectorAll("button")).find(
      (button) => button.textContent === "Open account page",
    )!;
    await act(async () => opener.click());
    expect(document.body.textContent).toContain("Existing Connect account content");
    const mobile = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Mobile clients",
    )!;
    await act(async () => mobile.click());
    expect(document.body.textContent).toContain("Existing mobile-client account content");
    await act(async () =>
      (document.querySelector('[aria-label="Close"]') as HTMLButtonElement).click(),
    );
    await act(async () =>
      (
        container!.querySelector('[aria-label="Arcwright Connect account"]') as HTMLButtonElement
      ).click(),
    );
    expect(document.body.textContent).toContain("Signed in to Arcwright Connect");
    const logout = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
      (item) => item.textContent === "Sign out",
    ) as HTMLElement;
    await act(async () => logout.click());
    expect(auth.signOut).toHaveBeenCalledOnce();
    const signedOut = { ...auth, isSignedIn: false, userId: null, sessionId: null, generation: 2 };
    await render(signedOut);
    const signIn = Array.from(container!.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Sign in to Arcwright Connect"),
    )!;
    await act(async () => signIn.click());
    expect(auth.openSignIn).toHaveBeenCalledOnce();
  });
  it("renders readiness errors and a retry action without treating the account as signed out", async () => {
    const auth = {
      ...account(),
      isLoaded: false,
      isSignedIn: false,
      userId: null,
      sessionId: null,
      error: "Account network is unavailable",
    };
    await render(auth);
    expect(container!.textContent).toContain(auth.error);
    expect(container!.textContent).toContain("Sign in to Arcwright Connect");
  });
});
