import { useManagedAuth } from "../../auth/managedAuthContext";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogPanel } from "../ui/dialog";
import { ServerIcon, SmartphoneIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { createPortal } from "react-dom";

import { MobileClientsUserProfilePage } from "./MobileClientsUserProfilePage";
import { T3ConnectUserProfilePage } from "./T3ConnectUserProfilePage";

export const T3_CONNECT_ACCOUNT_PAGES = [
  {
    label: "Mobile clients",
    url: "mobile-clients",
    icon: <SmartphoneIcon className="size-4" />,
    content: <MobileClientsUserProfilePage />,
  },
  {
    label: "Arcwright Connect",
    url: "t3-connect",
    icon: <ServerIcon className="size-4" />,
    content: <T3ConnectUserProfilePage />,
  },
] as const;

type PortalTargets = Readonly<Record<string, HTMLDivElement | undefined>>;

/**
 * Opens the Clerk account modal on the Arcwright Connect page from outside the
 * UserButton. Clerk mounts custom pages into DOM nodes it owns, so the caller
 * must keep `portals` rendered for as long as the modal can be open.
 */
export function useT3ConnectAccountPage(): {
  readonly open: (() => void) | null;
  readonly portals: ReactNode;
} {
  const { isSignedIn, surface, openAccountPages } = useManagedAuth();
  const [nativeOpen, setNativeOpen] = useState(false);
  const [nativePage, setNativePage] = useState<string>("t3-connect");
  const [targets, setTargets] = useState<PortalTargets>({});

  const open = () => {
    if (surface === "android") {
      setNativePage("t3-connect");
      setNativeOpen(true);
      return;
    }
    const setTarget = (key: string, element: HTMLDivElement | undefined) =>
      setTargets((current) => ({ ...current, [key]: element }));
    openAccountPages?.(
      T3_CONNECT_ACCOUNT_PAGES.map((page) => ({
        label: page.label,
        url: page.url,
        mount: (element: HTMLDivElement) => setTarget(`content:${page.url}`, element),
        unmount: () => setTarget(`content:${page.url}`, undefined),
        mountIcon: (element: HTMLDivElement) => setTarget(`icon:${page.url}`, element),
        unmountIcon: () => setTarget(`icon:${page.url}`, undefined),
      })),
      "/t3-connect",
    );
  };

  const portals = T3_CONNECT_ACCOUNT_PAGES.flatMap((page) => {
    const content = targets[`content:${page.url}`];
    const icon = targets[`icon:${page.url}`];
    return [
      content ? createPortal(page.content, content, `content:${page.url}`) : null,
      icon ? createPortal(page.icon, icon, `icon:${page.url}`) : null,
    ];
  });

  const nativeDialog = (
    <Dialog open={nativeOpen && isSignedIn} onOpenChange={setNativeOpen}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Arcwright Connect account</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="mb-4 flex flex-wrap gap-2" aria-label="Account pages">
            {T3_CONNECT_ACCOUNT_PAGES.map((page) => (
              <Button
                key={page.url}
                variant={nativePage === page.url ? "secondary" : "ghost"}
                onClick={() => setNativePage(page.url)}
              >
                {page.label}
              </Button>
            ))}
          </div>
          {T3_CONNECT_ACCOUNT_PAGES.find((page) => page.url === nativePage)?.content}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
  return {
    open: isSignedIn ? open : null,
    portals: surface === "android" ? nativeDialog : portals,
  };
}
