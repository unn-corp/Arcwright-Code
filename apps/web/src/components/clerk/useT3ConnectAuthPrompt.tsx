import { useManagedAuth } from "../../auth/managedAuthContext";

export function useT3ConnectAuthPrompt() {
  const { openSignIn } = useManagedAuth();
  return { openAuthPrompt: openSignIn };
}
