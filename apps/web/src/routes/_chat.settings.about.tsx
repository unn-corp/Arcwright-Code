import { supportsForkMaintenanceAdmission } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { AboutUpdatesSettingsPanel } from "../components/settings/SettingsPanels";
import { HostUpdateSettings } from "../components/settings/HostUpdateSettings";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";

function AboutSettingsPage() {
  const { environments } = useSettingsScope();
  return (
    <AboutUpdatesSettingsPanel>
      {environments.map((environment) => (
        <SettingsSection
          key={environment.environmentId}
          id={`host-updates-${environment.environmentId}`}
          title={`Updates for ${environment.label}`}
        >
          {environment.connection.phase === "connected" && environment.serverConfig ? (
            <HostUpdateSettings
              environmentId={environment.environmentId}
              label={environment.label}
              supported={supportsForkMaintenanceAdmission(
                environment.serverConfig.environment.capabilities.forkMaintenance,
              )}
            />
          ) : (
            <SettingsRow
              title="Computer disconnected"
              description="Reconnect this computer to view its update preferences and history."
            />
          )}
        </SettingsSection>
      ))}
    </AboutUpdatesSettingsPanel>
  );
}

export const Route = createFileRoute("/_chat/settings/about")({ component: AboutSettingsPage });
