// These fixtures exercise React state and mocked native bridges in jsdom. Real browser
// regressions keep their separate *.browser.test project and Playwright provider.
export const WEB_DOM_TEST_FILES = [
  "src/android/AndroidNotificationBridgeReplay.test.tsx",
  "src/android/AndroidNotificationCoordinator.test.tsx",
  "src/android/browser.test.ts",
  "src/android/browserRuntime.test.ts",
  "src/android/notifications.test.ts",
  "src/android/updates.test.ts",
  "src/components/chat/ComposerAttachmentStrip.test.tsx",
  "src/components/chat/ComposerSurface.voice.test.tsx",
  "src/components/chat/MessageReplies.test.tsx",
  "src/components/chat/MessagesTimeline.test.tsx",
  "src/components/chat/SubagentActivity.test.tsx",
  "src/components/chat/TimelineParticipants.test.tsx",
  "src/components/clerk/T3ConnectNativeAccount.test.tsx",
  "src/components/organizations/OrganizationArchitectConversation.test.tsx",
  "src/components/organizations/OrganizationDesigner.test.tsx",
  "src/components/organizations/OrganizationEmployeeDialog.test.tsx",
  "src/components/organizations/OrganizationGraphView.dom.test.tsx",
  "src/components/organizations/OrganizationsPage.test.tsx",
  "src/components/preview/PreviewAnnotationEditor.test.tsx",
  "src/components/settings/AutomationSettings.test.tsx",
  "src/components/settings/BackgroundActivitySettings.test.tsx",
  "src/components/settings/ForkUpdateControls.test.tsx",
  "src/components/settings/PairingQrScanner.test.tsx",
  "src/components/settings/SettingsPanels.privacy.test.tsx",
  "src/components/sidebar/CollapsedThreadStatusIndicators.test.tsx",
  "src/components/ui/sidebar.test.tsx",
];

export const DESKTOP_DOM_TEST_FILES = [
  "src/preview/AnnotationPageFallback.test.ts",
  "src/preview/PickPreload.snapshot.test.ts",
];

// Release suites load the root config from each package directory; direct focused
// commands load it from the repository root. Keep both discovery paths equivalent.
export const ROOT_DOM_TEST_FILES = [
  ...WEB_DOM_TEST_FILES.flatMap((file) => [file, `apps/web/${file}`]),
  ...DESKTOP_DOM_TEST_FILES.flatMap((file) => [file, `apps/desktop/${file}`]),
];
