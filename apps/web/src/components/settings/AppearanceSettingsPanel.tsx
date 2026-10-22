import type { CSSProperties } from "react";
import { useState } from "react";
import { useLocation } from "@tanstack/react-router";
import { Button } from "../ui/button";
import {
  DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE,
  DEFAULT_UNIFIED_SETTINGS,
  type ChatWidth,
  type EnvironmentIdentificationMode,
  MAX_APPEARANCE_CONTRAST,
  MAX_GLASS_OPACITY,
  MAX_PANEL_ANIMATION_DURATION_MS,
  MIN_APPEARANCE_CONTRAST,
  MIN_GLASS_OPACITY,
  MIN_PANEL_ANIMATION_DURATION_MS,
} from "@t3tools/contracts/settings";
import {
  resolveEnvironmentIdentificationPillLabel,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { useCustomThemes } from "../../hooks/useCustomThemes";
import { useTheme } from "../../hooks/useTheme";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { ThemeLibrary } from "./ThemeSettings";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting, SETTINGS_SEARCH_ITEMS } from "./settingsSearch";
import { PanelAnimationsPreview } from "./PanelAnimationsPreview";
import { TypographySection } from "./TypographySettings";

const ENVIRONMENT_IDENTIFICATION_LABELS: Record<EnvironmentIdentificationMode, string> = {
  artwork: "Artwork",
  pill: "Version pill",
  none: "None",
};

const CHAT_WIDTH_LABELS: Record<ChatWidth, string> = {
  comfortable: "Comfortable",
  wide: "Wide",
  full: "Full",
};

const APPEARANCE_OVERVIEW_TARGET_IDS = new Set<string>([
  "appearance-interface",
  "motion",
  "typography",
  ...SETTINGS_SEARCH_ITEMS.filter(
    (item) =>
      item.to === "/settings/appearance" && item.id !== "theme" && item.id !== "color-scheme",
  ).map((item) => item.id),
]);

export function AppearanceSettingsPanel() {
  const {
    appearanceMode,
    refreshTheme,
    resolvedTheme,
    setAppearanceMode,
    setTheme,
    setThemeHalf,
    theme,
    themeHalves,
  } = useTheme();
  const customThemes = useCustomThemes();
  const [isImportThemeOpen, setIsImportThemeOpen] = useState(false);
  const [themeLibraryOpen, setThemeLibraryOpen] = useState(false);
  const searchTargetId = useLocation({ select: (location) => location.hash.replace(/^#/, "") });
  const [previousSearchTargetId, setPreviousSearchTargetId] = useState(searchTargetId);
  if (previousSearchTargetId !== searchTargetId) {
    setPreviousSearchTargetId(searchTargetId);
    if (themeLibraryOpen && APPEARANCE_OVERVIEW_TARGET_IDS.has(searchTargetId)) {
      setThemeLibraryOpen(false);
    }
  }
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const environmentStageLabel = useEnvironmentStageLabel();
  const showEnvironmentIdentification =
    resolveEnvironmentIdentificationPillLabel(environmentStageLabel) !== null;
  const glassOpacityRatio =
    (settings.glassOpacity - MIN_GLASS_OPACITY) / (MAX_GLASS_OPACITY - MIN_GLASS_OPACITY);
  const glassOpacitySliderStyle = {
    "--settings-slider-progress": `${glassOpacityRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - glassOpacityRatio}rem`,
  } as CSSProperties;
  const appearanceContrastRatio =
    (settings.appearanceContrast - MIN_APPEARANCE_CONTRAST) /
    (MAX_APPEARANCE_CONTRAST - MIN_APPEARANCE_CONTRAST);
  const appearanceContrastSliderStyle = {
    "--settings-slider-progress": `${appearanceContrastRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - appearanceContrastRatio}rem`,
  } as CSSProperties;
  const panelAnimationDurationRatio =
    (settings.panelAnimationDurationMs - MIN_PANEL_ANIMATION_DURATION_MS) /
    (MAX_PANEL_ANIMATION_DURATION_MS - MIN_PANEL_ANIMATION_DURATION_MS);
  const panelAnimationDurationSliderStyle = {
    "--settings-slider-progress": `${panelAnimationDurationRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - panelAnimationDurationRatio}rem`,
  } as CSSProperties;

  return (
    <SettingsPageContainer>
      {themeLibraryOpen ? (
        <Button variant="outline" size="sm" onClick={() => setThemeLibraryOpen(false)}>
          Back to Appearance
        </Button>
      ) : null}
      <SettingsSection id="appearance" title={themeLibraryOpen ? "Theme library" : "Themes"}>
        <div id={searchableSetting("theme").id}>
          <ThemeLibrary
            compact={!themeLibraryOpen}
            onManage={() => setThemeLibraryOpen(true)}
            appearanceMode={appearanceMode}
            customThemes={customThemes}
            initialAppearance={resolvedTheme}
            refreshTheme={refreshTheme}
            isImportOpen={isImportThemeOpen}
            setAppearanceMode={setAppearanceMode}
            setTheme={setTheme}
            setThemeHalf={setThemeHalf}
            theme={theme}
            themeHalves={themeHalves}
            onImportOpenChange={setIsImportThemeOpen}
          />
        </div>
      </SettingsSection>

      {!themeLibraryOpen ? (
        <>
          <SettingsSection id="appearance-interface" title="Interface">
            <SettingsRow
              {...searchableSetting("standard-thread-feed")}
              description="Use the original T3 chat feed for standard threads. Organization conversations keep their current layout. Saved on this device."
              resetAction={
                settings.standardThreadFeed !== DEFAULT_UNIFIED_SETTINGS.standardThreadFeed ? (
                  <SettingResetButton
                    label="Upstream chat feed"
                    onClick={() =>
                      updateSettings({
                        standardThreadFeed: DEFAULT_UNIFIED_SETTINGS.standardThreadFeed,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  aria-label="Upstream chat feed"
                  checked={settings.standardThreadFeed === "upstream"}
                  onCheckedChange={(enabled) =>
                    updateSettings({ standardThreadFeed: enabled ? "upstream" : "arcwright" })
                  }
                />
              }
            />

            <SettingsRow
              {...searchableSetting("assistant-message-bubbles")}
              description="Display AI replies in rounded chat bubbles when using the Arcwright feed."
              resetAction={
                settings.assistantMessageBubbles !==
                DEFAULT_UNIFIED_SETTINGS.assistantMessageBubbles ? (
                  <SettingResetButton
                    label="AI message bubbles"
                    onClick={() =>
                      updateSettings({
                        assistantMessageBubbles: DEFAULT_UNIFIED_SETTINGS.assistantMessageBubbles,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  aria-label="AI message bubbles"
                  disabled={settings.standardThreadFeed === "upstream"}
                  checked={settings.assistantMessageBubbles}
                  onCheckedChange={(assistantMessageBubbles) =>
                    updateSettings({ assistantMessageBubbles })
                  }
                />
              }
            />

            <SettingsRow
              {...searchableSetting("setting-appearance-contrast")}
              description="Adjust the contrast of colors and borders across the interface."
              resetAction={
                settings.appearanceContrast !== DEFAULT_UNIFIED_SETTINGS.appearanceContrast ? (
                  <SettingResetButton
                    label="contrast"
                    onClick={() =>
                      updateSettings({
                        appearanceContrast: DEFAULT_UNIFIED_SETTINGS.appearanceContrast,
                      })
                    }
                  />
                ) : null
              }
              control={
                <div className="flex w-full items-center gap-3 sm:w-52">
                  <output
                    className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                    htmlFor="appearance-contrast"
                  >
                    {settings.appearanceContrast}%
                  </output>
                  <input
                    aria-label="Contrast"
                    className="settings-slider min-w-0 flex-1"
                    id="appearance-contrast"
                    max={MAX_APPEARANCE_CONTRAST}
                    min={MIN_APPEARANCE_CONTRAST}
                    onChange={(event) => {
                      const appearanceContrast = Number(event.currentTarget.value);
                      if (
                        Number.isInteger(appearanceContrast) &&
                        appearanceContrast >= MIN_APPEARANCE_CONTRAST &&
                        appearanceContrast <= MAX_APPEARANCE_CONTRAST
                      ) {
                        updateSettings({ appearanceContrast });
                      }
                    }}
                    step={5}
                    style={appearanceContrastSliderStyle}
                    type="range"
                    value={settings.appearanceContrast}
                  />
                </div>
              }
            />

            <SettingsRow
              {...searchableSetting("setting-glass-opacity")}
              description="Higher values make menus, dialogs, and the composer more solid."
              resetAction={
                settings.glassOpacity !== DEFAULT_UNIFIED_SETTINGS.glassOpacity ? (
                  <SettingResetButton
                    label="glass opacity"
                    onClick={() =>
                      updateSettings({ glassOpacity: DEFAULT_UNIFIED_SETTINGS.glassOpacity })
                    }
                  />
                ) : null
              }
              control={
                <div className="flex w-full items-center gap-3 sm:w-52">
                  <output
                    className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                    htmlFor="glass-opacity"
                  >
                    {settings.glassOpacity}%
                  </output>
                  <input
                    aria-label="Glass opacity"
                    className="settings-slider min-w-0 flex-1"
                    id="glass-opacity"
                    max={MAX_GLASS_OPACITY}
                    min={MIN_GLASS_OPACITY}
                    onChange={(event) => {
                      const glassOpacity = Number(event.currentTarget.value);
                      if (
                        Number.isInteger(glassOpacity) &&
                        glassOpacity >= MIN_GLASS_OPACITY &&
                        glassOpacity <= MAX_GLASS_OPACITY
                      ) {
                        updateSettings({ glassOpacity });
                      }
                    }}
                    step={5}
                    style={glassOpacitySliderStyle}
                    type="range"
                    value={settings.glassOpacity}
                  />
                </div>
              }
            />

            {showEnvironmentIdentification ? (
              <SettingsRow
                {...searchableSetting("environment-identification")}
                description="Choose how Dev and Nightly environments are identified."
                resetAction={
                  settings.environmentIdentificationMode !==
                  DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE ? (
                    <SettingResetButton
                      label="environment identification"
                      onClick={() =>
                        updateSettings({
                          environmentIdentificationMode: DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE,
                        })
                      }
                    />
                  ) : null
                }
                control={
                  <Select
                    value={settings.environmentIdentificationMode}
                    onValueChange={(value) => {
                      if (value === "artwork" || value === "pill" || value === "none") {
                        updateSettings({ environmentIdentificationMode: value });
                      }
                    }}
                  >
                    <SelectTrigger
                      size="sm"
                      className="w-full sm:w-40"
                      aria-label="Environment identification"
                    >
                      <SelectValue>
                        {ENVIRONMENT_IDENTIFICATION_LABELS[settings.environmentIdentificationMode]}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      {Object.entries(ENVIRONMENT_IDENTIFICATION_LABELS).map(([value, label]) => (
                        <SelectItem hideIndicator key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                }
              />
            ) : null}

            <SettingsRow
              {...searchableSetting("diff-color-scheme")}
              description="Choose colors for additions and deletions, including change counts."
              resetAction={
                settings.diffColorScheme !== DEFAULT_UNIFIED_SETTINGS.diffColorScheme ? (
                  <SettingResetButton
                    label="diff colors"
                    onClick={() =>
                      updateSettings({ diffColorScheme: DEFAULT_UNIFIED_SETTINGS.diffColorScheme })
                    }
                  />
                ) : null
              }
              control={
                <div className="w-full sm:w-40">
                  <Select
                    value={settings.diffColorScheme}
                    onValueChange={(value) => {
                      if (value === "red-green" || value === "blue-orange")
                        updateSettings({ diffColorScheme: value });
                    }}
                  >
                    <SelectTrigger size="sm" className="w-full min-w-0" aria-label="Diff colors">
                      <span
                        aria-hidden="true"
                        className={
                          settings.diffColorScheme === "blue-orange"
                            ? "flex shrink-0 flex-row-reverse gap-1"
                            : "flex shrink-0 gap-1"
                        }
                      >
                        <span className="size-2 rounded-full bg-diff-deletion" />
                        <span className="size-2 rounded-full bg-diff-addition" />
                      </span>
                      <SelectValue>
                        {settings.diffColorScheme === "blue-orange"
                          ? "Blue & orange"
                          : "Red & green"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      <SelectItem value="red-green">Red & green (default)</SelectItem>
                      <SelectItem value="blue-orange">Blue & orange</SelectItem>
                    </SelectPopup>
                  </Select>
                </div>
              }
            />

            <SettingsRow
              {...searchableSetting("chat-width")}
              description="Set how wide messages and the composer can grow on large screens."
              resetAction={
                settings.chatWidth !== DEFAULT_UNIFIED_SETTINGS.chatWidth ? (
                  <SettingResetButton
                    label="chat width"
                    onClick={() =>
                      updateSettings({ chatWidth: DEFAULT_UNIFIED_SETTINGS.chatWidth })
                    }
                  />
                ) : null
              }
              control={
                <div className="w-full sm:w-40">
                  <Select
                    value={settings.chatWidth}
                    onValueChange={(value) => {
                      if (value === "comfortable" || value === "wide" || value === "full")
                        updateSettings({ chatWidth: value });
                    }}
                  >
                    <SelectTrigger size="sm" className="w-full min-w-0" aria-label="Chat width">
                      <SelectValue>{CHAT_WIDTH_LABELS[settings.chatWidth]}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      <SelectItem value="comfortable">Comfortable (default)</SelectItem>
                      <SelectItem value="wide">Wide</SelectItem>
                      <SelectItem value="full">Full</SelectItem>
                    </SelectPopup>
                  </Select>
                </div>
              }
            />
            <SettingsRow
              {...searchableSetting("math-rendering")}
              description="Typeset LaTeX math, such as $x^2$ or \[x^2\], in messages and Markdown previews. The composer keeps TeX source editable."
              resetAction={
                settings.mathRenderingEnabled !== DEFAULT_UNIFIED_SETTINGS.mathRenderingEnabled ? (
                  <SettingResetButton
                    label="math rendering"
                    onClick={() =>
                      updateSettings({
                        mathRenderingEnabled: DEFAULT_UNIFIED_SETTINGS.mathRenderingEnabled,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  checked={settings.mathRenderingEnabled}
                  onCheckedChange={(checked) =>
                    updateSettings({ mathRenderingEnabled: Boolean(checked) })
                  }
                  aria-label="Render math"
                />
              }
            />
          </SettingsSection>

          <SettingsSection id="motion" title="Motion">
            <SettingsRow
              {...searchableSetting("panel-animations")}
              description="Set how fast panels open and close."
              control={
                <div className="grid w-full grid-cols-[5rem_minmax(0,1fr)] items-center gap-3 sm:w-auto sm:grid-cols-[7rem_13rem] sm:gap-4">
                  <PanelAnimationsPreview durationMs={settings.panelAnimationDurationMs} />
                  <div className="flex w-full items-center gap-3">
                    <output
                      className="min-w-16 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                      htmlFor="panel-animation-duration"
                    >
                      {settings.panelAnimationDurationMs} ms
                    </output>
                    <input
                      aria-label="Panel animation duration"
                      className="settings-slider min-w-0 flex-1"
                      id="panel-animation-duration"
                      max={MAX_PANEL_ANIMATION_DURATION_MS}
                      min={MIN_PANEL_ANIMATION_DURATION_MS}
                      onChange={(event) => {
                        const panelAnimationDurationMs = Number(event.currentTarget.value);
                        if (
                          Number.isInteger(panelAnimationDurationMs) &&
                          panelAnimationDurationMs >= MIN_PANEL_ANIMATION_DURATION_MS &&
                          panelAnimationDurationMs <= MAX_PANEL_ANIMATION_DURATION_MS
                        ) {
                          updateSettings({ panelAnimationDurationMs });
                        }
                      }}
                      step={25}
                      style={panelAnimationDurationSliderStyle}
                      type="range"
                      value={settings.panelAnimationDurationMs}
                    />
                  </div>
                </div>
              }
              resetAction={
                settings.panelAnimationDurationMs !==
                DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs ? (
                  <SettingResetButton
                    label="panel animations"
                    onClick={() =>
                      updateSettings({
                        panelAnimationDurationMs: DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs,
                      })
                    }
                  />
                ) : null
              }
            />
          </SettingsSection>

          <TypographySection />
        </>
      ) : null}
    </SettingsPageContainer>
  );
}
