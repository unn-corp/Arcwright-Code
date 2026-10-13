import { useUser } from "@clerk/react";
import { useEffect } from "react";
import { seedProfile } from "@t3tools/client-runtime/participants";
import { ParticipantPhoto } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { persistClientSettingsUpdate } from "../../hooks/useSettings";

const isParticipantPhoto = Schema.is(ParticipantPhoto);

/** Only mounted beneath a personal-account auth provider; provider API keys never seed a profile. */
export function ParticipantProfileSync() {
  const { isLoaded, user } = useUser();
  useEffect(() => {
    if (!isLoaded) return;
    if (!user) {
      void persistClientSettingsUpdate((current) => ({
        ...current,
        activeParticipantProfile: "local",
      })).catch(() => console.error("Could not switch participant profile"));
      return;
    }
    const id = `account:${user.id}`;
    const accounts = user.externalAccounts.map((account) => ({
      id: account.id,
      label: `${account.provider}: ${account.username || account.emailAddress || "Account"}`,
      photo: isParticipantPhoto(account.imageUrl) ? account.imageUrl : null,
    }));
    const photo =
      (user.hasImage && isParticipantPhoto(user.imageUrl) ? user.imageUrl : null) ??
      accounts.find((account) => account.photo)?.photo ??
      null;
    void persistClientSettingsUpdate((current) => ({
      ...current,
      activeParticipantProfile: id,
      participantProfiles: {
        ...current.participantProfiles,
        [id]: seedProfile(
          current.participantProfiles[id],
          {
            id,
            name: (user.fullName || user.username || "You").slice(0, 100),
            photo,
          },
          accounts,
        ),
      },
    })).catch(() => console.error("Could not save participant profile"));
  }, [isLoaded, user]);
  return null;
}
