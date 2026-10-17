import { createFileRoute } from "@tanstack/react-router";

import { AutomationSettingsPanel } from "../components/settings/AutomationSettings";

function SettingsAutomationRoute() {
  return <AutomationSettingsPanel />;
}

export const Route = createFileRoute("/settings/automation")({
  component: SettingsAutomationRoute,
});
