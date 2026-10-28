import { UserButton } from "@clerk/react";
import { useManagedAuth } from "../../auth/managedAuthContext";
import { LogInIcon, SettingsIcon, UserRoundIcon, LogOutIcon } from "lucide-react";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Button } from "../ui/button";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuGroup, MenuGroupLabel } from "../ui/menu";
import { T3_CONNECT_ACCOUNT_PAGES, useT3ConnectAccountPage } from "./T3ConnectAccountPages";
import { useT3ConnectAuthPrompt } from "./useT3ConnectAuthPrompt";

export function T3ConnectSidebarSignIn() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredT3ConnectSidebarSignIn />;
}

export function T3ConnectSidebarAvatar() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredT3ConnectSidebarAvatar />;
}

function ConfiguredT3ConnectSidebarAvatar() {
  const { isLoaded, isSignedIn, surface } = useManagedAuth();

  if (!isLoaded || !isSignedIn) return null;

  if (surface === "android") return <AndroidAccountMenu />;

  return (
    <UserButton
      appearance={{
        elements: {
          avatarBox: "size-7",
          // Clerk's unlayered trigger reset (padding, radius, background) beats layered utilities.
          userButtonTrigger: "mb-1! rounded-lg! p-1! hover:bg-sidebar-row-hover!",
        },
      }}
    >
      {T3_CONNECT_ACCOUNT_PAGES.map((page) => (
        <UserButton.UserProfilePage
          key={page.url}
          label={page.label}
          labelIcon={page.icon}
          url={page.url}
        >
          {page.content}
        </UserButton.UserProfilePage>
      ))}
      <UserButton.MenuItems>
        <UserButton.Link href="/settings/general" label="Settings" labelIcon={<SettingsIcon />} />
      </UserButton.MenuItems>
    </UserButton>
  );
}

function ConfiguredT3ConnectSidebarSignIn() {
  const { isLoaded, isSignedIn, isSigningIn, isUnavailable, error, surface } = useManagedAuth();
  const { openAuthPrompt } = useT3ConnectAuthPrompt();

  if (isSignedIn || (!isLoaded && surface !== "android")) return null;

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={openAuthPrompt} disabled={isSigningIn || isUnavailable}>
            <LogInIcon />
            <span>
              {isUnavailable
                ? "Arcwright Connect account unavailable"
                : isSigningIn
                  ? "Finish sign-in in your browser…"
                  : !isLoaded && !error
                    ? "Connecting account…"
                    : "Sign in to Arcwright Connect"}
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      {surface === "browser" &&
      import.meta.env.VITE_CONNECT_MODE === "owned" &&
      window.location.origin === import.meta.env.VITE_HOSTED_APP_URL ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          <a href="/privacy.html" className="underline">
            Privacy
          </a>
          {" · "}
          <a href="/about.html" className="underline">
            About Arcwright Connect
          </a>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="px-3 py-2 text-xs text-muted-foreground">
          {error}
        </p>
      ) : null}
    </>
  );
}

function AndroidAccountMenu() {
  const { signOut, error } = useManagedAuth();
  const account = useT3ConnectAccountPage();
  return (
    <>
      <Menu>
        <MenuTrigger
          render={<Button variant="ghost" size="icon" aria-label="Arcwright Connect account" />}
        >
          <UserRoundIcon className="size-5" />
        </MenuTrigger>
        <MenuPopup>
          <MenuGroup>
            <MenuGroupLabel>Signed in to Arcwright Connect</MenuGroupLabel>
            <MenuItem onClick={() => account.open?.()}>
              <UserRoundIcon />
              Arcwright Connect account
            </MenuItem>
            <MenuItem
              onClick={() => {
                void signOut().catch(() => {});
              }}
            >
              <LogOutIcon />
              Sign out
            </MenuItem>
          </MenuGroup>
        </MenuPopup>
      </Menu>
      {error ? (
        <p role="status" className="px-3 text-xs text-muted-foreground">
          {error}
        </p>
      ) : null}
      {account.portals}
    </>
  );
}
