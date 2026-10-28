import { PrimarySettingsBoundary } from "../components/settings/SettingsScopeContext";
import { createFileRoute } from "@tanstack/react-router";

import { AutomationSettingsPanel } from "../components/settings/AutomationSettings";

function SettingsAutomationRoute() {
  return (
    <PrimarySettingsBoundary>
      <AutomationSettingsPanel />
    </PrimarySettingsBoundary>
  );
}

export const Route = createFileRoute("/_chat/settings/automation")({
  component: SettingsAutomationRoute,
});
