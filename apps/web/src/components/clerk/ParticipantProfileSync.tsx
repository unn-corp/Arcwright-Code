import { useClerk, useUser } from "@clerk/react";
import { useEffect } from "react";
import { syncAccountProfile } from "@t3tools/client-runtime/participants";
import { ParticipantPhoto } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { persistClientSettingsUpdate } from "../../hooks/useSettings";
import { startParticipantProfileRefresh } from "./participantProfileRefresh";
import { serializeProfilePhoto } from "../../auth/profilePhoto";

const isParticipantPhoto = Schema.is(ParticipantPhoto);

/** Only mounted beneath personal-account auth; provider API keys never supply a profile. */
export function ParticipantProfileSync() {
  const { isLoaded, user } = useUser();
  const clerk = useClerk();
  const sessionId = clerk.session?.id;
  useEffect(() => {
    if (!isLoaded) return;
    let canceled = false;
    if (!user) {
      void persistClientSettingsUpdate((current) =>
        !canceled && !clerk.user && current.activeParticipantProfile !== "local"
          ? { ...current, activeParticipantProfile: "local" }
          : current,
      ).catch(() => console.error("Could not switch participant profile"));
      return () => {
        canceled = true;
      };
    }
    const id = `account:${user.id}`;
    const currentAccount = () =>
      !canceled && clerk.user?.id === user.id && clerk.session?.id === sessionId;
    const persist = async (profile: typeof user) => {
      const accounts = profile.externalAccounts.map((account) => ({
        id: account.id,
        label: `${account.provider}: ${account.username || account.emailAddress || "Account"}`,
        photo: isParticipantPhoto(account.imageUrl) ? account.imageUrl : null,
      }));
      // Falling back to an external account image here would undo Use initials.
      const photo =
        profile.hasImage && isParticipantPhoto(profile.imageUrl) ? profile.imageUrl : null;
      await persistClientSettingsUpdate((current) => {
        if (!currentAccount() || profile.id !== user.id) return current;
        const existing = current.participantProfiles[id];
        const next = syncAccountProfile(
          existing,
          {
            id,
            name: (profile.fullName || profile.username || "You").slice(0, 100),
            photo,
          },
          accounts,
        );
        return next === existing && current.activeParticipantProfile === id
          ? current
          : {
              ...current,
              activeParticipantProfile: id,
              participantProfiles: { ...current.participantProfiles, [id]: next },
            };
      });
    };
    void serializeProfilePhoto(user.id, async () => {
      if (currentAccount() && clerk.user) await persist(clerk.user);
    }).catch(() => console.error("Could not save participant profile"));
    const stopRefresh = startParticipantProfileRefresh(() =>
      serializeProfilePhoto(user.id, async () => {
        if (!currentAccount()) return;
        const updated = await user.reload();
        if (currentAccount()) await persist(updated);
      }),
    );
    return () => {
      canceled = true;
      stopRefresh();
    };
  }, [clerk, isLoaded, sessionId, user]);
  return null;
}
