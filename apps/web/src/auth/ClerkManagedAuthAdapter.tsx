import { useAuth, useClerk } from "@clerk/react";
import { useCallback, useMemo, useRef, type ReactNode } from "react";
import { resolveRelayClerkTokenOptions } from "../cloud/publicConfig";
import { resolveClerkSignInProps } from "../components/clerk/authRedirect";
import { isElectron } from "../env";
import { ManagedAuthContext, type AccountModalPage } from "./managedAuthContext";

/** Only mounted inside the selected browser/Electron ClerkProvider. */
export function ClerkManagedAuthAdapter({ children }: { readonly children: ReactNode }) {
  const { getToken, isLoaded, isSignedIn, userId, sessionId } = useAuth({
    treatPendingAsSignedOut: false,
  });
  const clerk = useClerk();
  const generation = sessionId ?? userId ?? "signedOut";
  const logoutFence = useRef<string | null>(null);
  const getRelayToken = useCallback(
    async (forceRefresh = true) => {
      const captured = generation;
      const current = () =>
        clerk.session?.id === sessionId &&
        clerk.user?.id === userId &&
        logoutFence.current !== captured;
      if (!isSignedIn || !sessionId || !userId || !current()) return null;
      const token = await getToken({ ...resolveRelayClerkTokenOptions(), skipCache: forceRefresh });
      return current() ? token : null;
    },
    [clerk, generation, getToken, isSignedIn, sessionId, userId],
  );
  const value = useMemo(
    () => ({
      surface: isElectron ? ("electron" as const) : ("browser" as const),
      isLoaded,
      isSignedIn: Boolean(isSignedIn),
      userId: userId ?? null,
      sessionId: sessionId ?? null,
      generation,
      error: null,
      isSigningIn: false,
      getRelayToken,
      openSignIn: () => clerk.openSignIn(resolveClerkSignInProps(window.location.href, isElectron)),
      signOut: async () => {
        logoutFence.current = generation;
        await clerk.signOut();
      },
      openAccountPages: (pages: AccountModalPage[], startPath: string) =>
        clerk.openUserProfile({
          __experimental_startPath: startPath,
          customPages: pages,
        }),
    }),
    [clerk, generation, getRelayToken, isLoaded, isSignedIn, sessionId, userId],
  );
  return <ManagedAuthContext value={value}>{children}</ManagedAuthContext>;
}
