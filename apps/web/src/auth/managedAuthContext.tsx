import { createContext, useContext } from "react";

export interface AccountModalPage {
  readonly label: string;
  readonly url: string;
  readonly mount: (element: HTMLDivElement) => void;
  readonly unmount: () => void;
  readonly mountIcon: (element: HTMLDivElement) => void;
  readonly unmountIcon: () => void;
}

/** App account capabilities; native and web sessions share the same relay lifecycle. */
export interface ManagedAuth {
  readonly surface: "browser" | "electron" | "android" | "cloudless";
  readonly isLoaded: boolean;
  readonly isSignedIn: boolean;
  readonly userId: string | null;
  readonly sessionId: string | null;
  readonly generation: string | number;
  readonly error: string | null;
  readonly isSigningIn: boolean;
  readonly isUnavailable?: boolean;
  readonly getRelayToken: (forceRefresh?: boolean) => Promise<string | null>;
  readonly openSignIn: () => void;
  readonly signOut: () => Promise<void>;
  readonly openAccountPages: ((pages: AccountModalPage[], startPath: string) => void) | null;
  /** Bounded raster thumbnail, or null to remove the account image. */
  readonly setProfilePhoto?: (photo: string | null) => Promise<string | null>;
}

const cloudless: ManagedAuth = {
  surface: "cloudless",
  isLoaded: false,
  isSignedIn: false,
  userId: null,
  sessionId: null,
  generation: 0,
  error: null,
  isSigningIn: false,
  getRelayToken: async () => null,
  openSignIn: () => {},
  signOut: async () => {},
  openAccountPages: null,
};
export const ManagedAuthContext = createContext<ManagedAuth>(cloudless);
export function useManagedAuth(): ManagedAuth {
  return useContext(ManagedAuthContext);
}
