import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { androidAuthStore } from "../../android/connectAuth";
import { ManagedAuthContext } from "../../auth/managedAuthContext";
import { ManagedRelayAuthProvider } from "../../cloud/managedAuth";
import { AndroidParticipantProfileSync } from "./AndroidParticipantProfileSync";

/** APK sessions live in the Android SDK, independent of this WebView and its lifetime. */
export default function AndroidManagedAuthShell({
  children,
}: {
  readonly publishableKey: string;
  readonly children: ReactNode;
}) {
  const status = useSyncExternalStore(androidAuthStore.subscribe, androidAuthStore.getSnapshot);
  useEffect(() => {
    androidAuthStore.start();
  }, []);
  const value = {
    surface: "android" as const,
    isLoaded:
      status.phase === "signedIn" || status.phase === "signedOut" || status.phase === "signingIn",
    isSignedIn: status.phase === "signedIn",
    userId: status.userId,
    sessionId: status.sessionId,
    generation: status.generation,
    error: status.error,
    isSigningIn: status.phase === "signingIn",
    isUnavailable: !status.available,
    getRelayToken: (forceRefresh = false) => androidAuthStore.getRelayToken(forceRefresh, status),
    setProfilePhoto: (photo: string | null) => androidAuthStore.setProfilePhoto(photo, status),
    openSignIn: androidAuthStore.signIn,
    signOut: androidAuthStore.signOut,
    openAccountPages: null,
  };
  return (
    <ManagedAuthContext value={value}>
      <AndroidParticipantProfileSync />
      <ManagedRelayAuthProvider>{children}</ManagedRelayAuthProvider>
    </ManagedAuthContext>
  );
}
