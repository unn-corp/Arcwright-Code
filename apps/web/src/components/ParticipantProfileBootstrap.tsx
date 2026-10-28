import { randomUUID } from "../lib/utils";
import { useEffect } from "react";
import { persistClientSettingsUpdate } from "../hooks/useSettings";

export function ParticipantProfileBootstrap() {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- initializes the persisted local participant identity once this app shell is mounted
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
