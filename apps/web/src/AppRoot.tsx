import { RouterProvider } from "@tanstack/react-router";

import { DesktopAgentNotificationCoordinator } from "./agentNotifications/DesktopAgentNotificationCoordinator";
import { AndroidBrowserHosts } from "./android/AndroidBrowserHosts";
import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

// Keep webviews outside the router but inside its atom registry so route changes preserve them.
export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
      <DesktopAgentNotificationCoordinator router={router} />
      <AndroidBrowserHosts />
      <ElectronBrowserHost />
      <QuitHoldOverlay />
    </AppAtomRegistryProvider>
  );
}
