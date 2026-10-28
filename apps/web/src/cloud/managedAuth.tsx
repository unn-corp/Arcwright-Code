import {
  createCloudAccountService,
  ManagedRelay,
  setManagedRelaySession,
} from "@t3tools/client-runtime/relay";
import {
  reportAtomCommandResult,
  runAtomCommand,
  settleAsyncResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { useEffect, useState, type ReactNode } from "react";
import { useManagedAuth, type ManagedAuth } from "../auth/managedAuthContext";
import { environmentCatalog } from "../connection/catalog";
import { runtime } from "../lib/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export function deactivateManagedRelayAuthentication(): void {
  setManagedRelaySession(appAtomRegistry, null);
}

export function activateManagedRelayAuthentication(
  accountId: string,
  readClerkToken: () => Promise<string | null>,
): void {
  setManagedRelaySession(appAtomRegistry, { accountId, readClerkToken });
}

type AccountResources = { readonly user: { readonly id: string } | null | undefined };

// Web, Electron and native Android publish the same public account state. Provider credentials
// never enter this source, and token reads stay fenced to the account session that requested them.
function managedAccountSource(initial: ManagedAuth) {
  let current = initial;
  const listeners = new Set<(resources: AccountResources) => void>();
  const snapshot = (): AccountResources => ({
    user: !current.isLoaded
      ? undefined
      : current.isSignedIn && current.userId
        ? { id: current.userId }
        : null,
  });
  return {
    addListener(listener: (resources: AccountResources) => void) {
      listeners.add(listener);
      listener(snapshot());
      return () => {
        listeners.delete(listener);
      };
    },
    update(auth: ManagedAuth) {
      current = auth;
      for (const listener of listeners) listener(snapshot());
    },
    async readToken(accountId: string) {
      const captured = current;
      if (!captured.isSignedIn || captured.userId !== accountId) return null;
      const token = await captured.getRelayToken();
      return current.isSignedIn &&
        current.userId === accountId &&
        current.sessionId === captured.sessionId &&
        current.generation === captured.generation
        ? token
        : null;
    },
  };
}

const managedRelayAccountService = createCloudAccountService<
  ReturnType<typeof managedAccountSource>
>({
  deactivate: deactivateManagedRelayAuthentication,
  detach: deactivateManagedRelayAuthentication,
  cleanUp: async () => {
    // PWA push credentials are installation-scoped and survive account cleanup.
    const results = await Promise.all([
      runAtomCommand(appAtomRegistry, environmentCatalog.removeRelayEnvironments, undefined, {
        reportFailure: false,
        reportDefect: false,
      }),
      settleAsyncResult(() =>
        runtime.runPromiseExit(
          ManagedRelay.ManagedRelayClient.pipe(Effect.flatMap((client) => client.resetTokenCache)),
        ),
      ),
    ]);
    for (const result of results)
      reportAtomCommandResult(result, { label: "cloud account cleanup" });
  },
  activate: ({ source, accountId }) =>
    activateManagedRelayAuthentication(accountId, () => source.readToken(accountId)),
});

export function ManagedRelayAuthProvider({ children }: { readonly children: ReactNode }) {
  const auth = useManagedAuth();
  const [source] = useState(() => managedAccountSource(auth));
  // Updates the external account source after the auth provider commits a new session snapshot.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes committed native or web account snapshots to the external relay account source
  useEffect(() => source.update(auth), [auth, source]);
  // The source's lifetime matches the native/web managed-auth provider.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- attaches the relay account service for this provider lifetime and releases its credential reader on unmount
  useEffect(() => managedRelayAccountService.attach(source), [source]);
  return children;
}
