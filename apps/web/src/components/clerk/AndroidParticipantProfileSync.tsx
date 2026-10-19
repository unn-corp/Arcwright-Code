import { useEffect, useSyncExternalStore } from "react";
import { syncAccountProfile } from "@t3tools/client-runtime/participants";
import { androidAuthStore } from "../../android/connectAuth";
import { persistClientSettingsUpdate } from "../../hooks/useSettings";
import { startParticipantProfileRefresh } from "./participantProfileRefresh";
import { serializeProfilePhoto } from "../../auth/profilePhoto";

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
            ? current.activeParticipantProfile === "local"
              ? current
              : { ...current, activeParticipantProfile: "local" }
            : current,
        );
        return;
      }
      if (status.phase !== "signedIn" || !status.userId) return;
      const id = `account:${status.userId}`;
      // Select this principal immediately; do not mark the fallback initialized before metadata arrives.
      await persistClientSettingsUpdate((current) =>
        !canceled && androidAuthStore.isCurrentAccount(status)
          ? current.activeParticipantProfile === id
            ? current
            : { ...current, activeParticipantProfile: id }
          : current,
      );
      if (canceled || !androidAuthStore.isCurrentAccount(status)) return;
      const profile = await androidAuthStore.getParticipantProfile(status);
      await persistClientSettingsUpdate((current) => {
        if (canceled || !androidAuthStore.isCurrentAccount(status)) return current;
        const existing = current.participantProfiles[id];
        const participant = { id, name: profile?.name ?? "You", photo: profile?.photo ?? null };
        const next = profile
          ? syncAccountProfile(existing, participant, profile.accounts)
          : (existing ?? { participant, initialized: false, accounts: [] });
        if (next === existing && current.activeParticipantProfile === id) return current;
        return {
          ...current,
          activeParticipantProfile: id,
          participantProfiles: {
            ...current.participantProfiles,
            [id]: next,
          },
        };
      });
    };
    let reading = false;
    const refresh = async () => {
      if (reading || canceled) return;
      reading = true;
      return await (async () => {
        await (status.userId ? serializeProfilePhoto(status.userId, persist) : persist());
      })().finally(() => {
        reading = false;
      });
    };
    void refresh().catch(() => console.error("Could not save participant profile"));
    const stopRefresh =
      status.phase === "signedIn" ? startParticipantProfileRefresh(refresh) : () => {};
    return () => {
      canceled = true;
      stopRefresh();
    };
  }, [phase, userId, sessionId, generation]);
  return null;
}
