import { useState, useSyncExternalStore } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import {
  getDocumentActivity,
  subscribeDocumentActivity,
  subscribeDocumentReturn,
} from "~/lib/documentActivity";

const POLL_INTERVAL_MS = 1_500;
const CHECK_FAILED_MESSAGE = "Could not check permissions. We'll try again automatically.";

interface PermissionSnapshot<Id extends string> {
  readonly status: Record<Id, boolean>;
  readonly error: string | null;
  readonly fresh: boolean;
}

/** Poll only while subscribed and visible; a return invalidates grants until its check settles. */
export function createPermissionPoller<Id extends string>(
  check: (signal?: AbortSignal) => Promise<Record<Id, boolean>>,
  initialStatus: Record<Id, boolean>,
) {
  let snapshot: PermissionSnapshot<Id> = { status: initialStatus, error: null, fresh: false };
  return {
    getSnapshot: () => snapshot,
    subscribe(onChange: () => void): () => void {
      const controller = new AbortController();
      let disposed = false;
      let checking = false;
      let pending = false;
      let previous: Record<Id, boolean> | undefined;
      let delay = POLL_INTERVAL_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cancelTimer = () => {
        clearTimeout(timer);
        timer = undefined;
      };
      const publish = (next: PermissionSnapshot<Id>) => {
        if (disposed) return;
        snapshot = next;
        onChange();
      };
      const invalidate = () => {
        if (snapshot.fresh) publish({ ...snapshot, fresh: false });
      };
      const schedule = () => {
        cancelTimer();
        if (!disposed && getDocumentActivity().visible)
          timer = setTimeout(() => void refresh(), delay);
      };
      const refresh = async () => {
        cancelTimer();
        if (disposed || !getDocumentActivity().visible) return;
        if (checking) {
          pending = true;
          return;
        }
        checking = true;
        try {
          const next = await check(controller.signal);
          if (!disposed && !pending && getDocumentActivity().visible) {
            const stable =
              previous !== undefined &&
              Object.keys(next).length === Object.keys(previous).length &&
              (Object.keys(next) as Id[]).every((id) => previous?.[id] === next[id]);
            delay = stable ? Math.min(delay * 2, 15_000) : POLL_INTERVAL_MS;
            previous = next;
            if (!stable || !snapshot.fresh || snapshot.error !== null)
              publish({ status: next, error: null, fresh: true });
          }
        } catch {
          delay = POLL_INTERVAL_MS;
          previous = undefined;
          if (!disposed)
            publish({ status: snapshot.status, error: CHECK_FAILED_MESSAGE, fresh: false });
        } finally {
          checking = false;
          if (!disposed && pending) {
            pending = false;
            void refresh();
          } else schedule();
        }
      };
      const refreshImmediately = () => {
        delay = POLL_INTERVAL_MS;
        previous = undefined;
        invalidate();
        void refresh();
      };
      invalidate();
      void refresh();
      const stopReturn = subscribeDocumentReturn(refreshImmediately);
      const stopActivity = subscribeDocumentActivity(() => {
        if (!getDocumentActivity().visible) {
          cancelTimer();
          invalidate();
        }
      });
      return () => {
        disposed = true;
        controller.abort();
        cancelTimer();
        stopReturn();
        stopActivity();
        snapshot = { ...snapshot, fresh: false };
      };
    },
  };
}

const noopSubscribe = () => () => {};

export function usePermissionStatus<Id extends string>(
  check: (signal?: AbortSignal) => Promise<Record<Id, boolean>>,
  initialStatus: Record<Id, boolean>,
  enabled = true,
) {
  const checkLatest = useStableCallback(check);
  const [poller] = useState(() => createPermissionPoller(checkLatest, initialStatus));
  const { status, error, fresh } = useSyncExternalStore(
    enabled ? poller.subscribe : noopSubscribe,
    poller.getSnapshot,
  );
  return {
    status,
    error,
    isReady: (required: readonly Id[]) =>
      enabled &&
      fresh &&
      getDocumentActivity().visible &&
      error === null &&
      required.every((id) => status[id]),
  };
}
