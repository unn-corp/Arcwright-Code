import { useEffect, useSyncExternalStore } from "react";
import { seedProfile } from "@t3tools/client-runtime/participants";
import { androidAuthStore } from "../../android/connectAuth";
import { persistClientSettingsUpdate } from "../../hooks/useSettings";

/** Native public metadata is optional and fenced independently of Clerk's browser provider. */
export function AndroidParticipantProfileSync() {
  const { phase, userId, sessionId, generation } = useSyncExternalStore(
    androidAuthStore.subscribe,
    androidAuthStore.getSnapshot,
  );
  useEffect(() => {
    const status = androidAuthStore.getSnapshot();
    if (
      status.phase !== phase ||
      status.userId !== userId ||
      status.sessionId !== sessionId ||
      status.generation !== generation
    )
      return;
    let canceled = false;
    const persist = async () => {
      if (status.phase === "signedOut") {
        await persistClientSettingsUpdate((current) =>
          !canceled && androidAuthStore.getSnapshot().phase === "signedOut"
            ? { ...current, activeParticipantProfile: "local" }
            : current,
        );
        return;
      }
      if (status.phase !== "signedIn" || !status.userId) return;
      const id = `account:${status.userId}`;
      // Select this principal immediately; do not mark the fallback initialized before metadata arrives.
      await persistClientSettingsUpdate((current) =>
        !canceled && androidAuthStore.isCurrentAccount(status)
          ? { ...current, activeParticipantProfile: id }
          : current,
      );
      if (canceled || !androidAuthStore.isCurrentAccount(status)) return;
      const profile = await androidAuthStore.getParticipantProfile(status);
      await persistClientSettingsUpdate((current) => {
        if (canceled || !androidAuthStore.isCurrentAccount(status)) return current;
        const existing = current.participantProfiles[id];
        return {
          ...current,
          activeParticipantProfile: id,
          participantProfiles: {
            ...current.participantProfiles,
            [id]: seedProfile(
              existing,
              {
                id,
                name: profile?.name ?? "You",
                photo: profile?.photo ?? null,
              },
              profile?.accounts ?? existing?.accounts ?? [],
            ),
          },
        };
      });
    };
    void persist().catch(() => console.error("Could not save participant profile"));
    return () => {
      canceled = true;
    };
  }, [phase, userId, sessionId, generation]);
  return null;
}
