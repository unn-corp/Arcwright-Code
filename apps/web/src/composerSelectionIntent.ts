import {
  parseScopedThreadKey,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { DraftId, useComposerDraftStore, type ComposerThreadTarget } from "./composerDraftStore";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { environmentThreadShells } from "./state/threads";
import type { Thread } from "./types";

/** Stable across streaming/status updates, but changes when a client selects or starts a turn. */
export function composerModelSelectionBase(
  thread: Pick<Thread, "environmentId" | "id" | "modelSelection" | "latestRun">,
): string {
  const selection = thread.modelSelection;
  return JSON.stringify([
    thread.environmentId,
    thread.id,
    selection.instanceId,
    selection.model,
    [...(selection.options ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
    thread.latestRun?.runId ?? null,
    thread.latestRun?.startedAt ?? null,
  ]);
}

/** Watch pending intent across route changes, without keeping every composer mounted. */
export function installComposerSelectionIntentSync(): () => void {
  const watching = new Map<string, { threadKey: string; stop: () => void }>();
  let reconciling = false;
  let reconcileAgain = false;

  const inspect = (draftKey: string, target: ComposerThreadTarget, thread: Thread | null) => {
    // Missing/loading shells cannot establish that a saved choice is stale.
    if (!thread) return;
    const state = useComposerDraftStore.getState();
    const draft = state.draftsByThreadKey[draftKey];
    if (
      draft?.modelSelectionExplicit &&
      draft.modelSelectionBase !== undefined &&
      draft.modelSelectionBase !== composerModelSelectionBase(thread)
    ) {
      state.clearModelSelectionIntent(target, draft.modelSelectionBase);
    }
  };

  const reconcile = () => {
    if (reconciling) {
      reconcileAgain = true;
      return;
    }
    reconciling = true;
    do {
      reconcileAgain = false;
      const state = useComposerDraftStore.getState();
      const pending = new Map<
        string,
        { threadRef: ScopedThreadRef; target: ComposerThreadTarget }
      >();
      for (const [draftKey, draft] of Object.entries(state.draftsByThreadKey)) {
        if (!draft.modelSelectionExplicit || draft.modelSelectionBase === undefined) continue;
        const scopedRef = parseScopedThreadKey(draftKey);
        const session = state.draftThreadsByThreadKey[draftKey];
        const threadRef =
          scopedRef ?? (session ? scopeThreadRef(session.environmentId, session.threadId) : null);
        if (threadRef) {
          pending.set(draftKey, { threadRef, target: scopedRef ?? DraftId.make(draftKey) });
        }
      }
      for (const [draftKey, subscription] of watching) {
        const next = pending.get(draftKey);
        if (!next || scopedThreadKey(next.threadRef) !== subscription.threadKey) {
          watching.delete(draftKey);
          subscription.stop();
        }
      }
      for (const [draftKey, { threadRef, target }] of pending) {
        const atom = environmentThreadShells.threadShellAtom(threadRef);
        if (!watching.has(draftKey)) {
          watching.set(draftKey, {
            threadKey: scopedThreadKey(threadRef),
            stop: appAtomRegistry.subscribe(atom, (thread) => inspect(draftKey, target, thread)),
          });
        }
        inspect(draftKey, target, appAtomRegistry.get(atom));
      }
    } while (reconcileAgain);
    reconciling = false;
  };

  const stopStore = useComposerDraftStore.subscribe(reconcile);
  reconcile();
  return () => {
    stopStore();
    for (const subscription of watching.values()) subscription.stop();
    watching.clear();
  };
}
