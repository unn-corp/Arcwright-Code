import { randomUUID } from "../lib/utils";
import { useEffect } from "react";
import { persistClientSettingsUpdate } from "../hooks/useSettings";

export function ParticipantProfileBootstrap() {
  useEffect(() => {
    void persistClientSettingsUpdate((current) =>
      current.participantProfiles.local
        ? current
        : {
            ...current,
            participantProfiles: {
              ...current.participantProfiles,
              local: {
                participant: { id: `local:${randomUUID()}`, name: "You", photo: null },
                initialized: false,
                accounts: [],
              },
            },
          },
    ).catch(() => console.error("Could not save participant profile"));
  }, []);
  return null;
}
