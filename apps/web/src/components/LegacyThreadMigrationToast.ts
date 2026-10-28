import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryServerLegacyThreadMigrationAtom } from "../state/server";
import { legacyThreadMigrationNotice } from "./LegacyThreadMigrationToast.logic";
import { toastManager } from "./ui/toast";

type MigrationToastId = ReturnType<typeof toastManager.add>;

/** A loading toast for as long as the primary server reports a legacy thread migration running. */
export function startLegacyThreadMigrationToast(): () => void {
  let toastId: MigrationToastId | null = null;

  const unsubscribe = appAtomRegistry.subscribe(
    primaryServerLegacyThreadMigrationAtom,
    (migration) => {
      const notice = legacyThreadMigrationNotice(migration);
      if (notice) {
        if (toastId === null) toastId = toastManager.add(notice);
        else toastManager.update(toastId, notice);
      } else if (toastId !== null) {
        toastManager.close(toastId);
        toastId = null;
      }
    },
    { immediate: true },
  );

  return () => {
    unsubscribe();
    if (toastId !== null) toastManager.close(toastId);
  };
}
