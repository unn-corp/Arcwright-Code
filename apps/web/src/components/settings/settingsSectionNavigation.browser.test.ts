import { describe, expect, it } from "vite-plus/test";

import { currentSettingsSection, settingsSectionDestinations } from "./settingsSectionNavigation";

describe("settings section navigation", () => {
  it("tracks the last reached heading, including short pages and the bottom of long pages", () => {
    expect(currentSettingsSection([], 0, false)).toBe(-1);
    expect(currentSettingsSection([60], 0, false)).toBe(0);
    expect(currentSettingsSection([-300, 20, 500], 0, false)).toBe(1);
    expect(currentSettingsSection([-300, 100, 500], 0, true)).toBe(2);
    expect(currentSettingsSection([100, 400], 0, false)).toBe(0);
  });

  it("keeps visible read-only sections and excludes hidden destinations", () => {
    const content = document.createElement("div");
    content.innerHTML = `
      <section data-settings-section="Profile"></section>
      <div hidden><section data-settings-section="Hidden"></section></div>
      <div aria-hidden="true"><section data-settings-section="Unavailable"></section></div>
      <div inert><section data-settings-section="Read-only shortcuts"></section></div>
      <section data-settings-section=""></section>
      <section data-settings-section="Performance"></section>
      <section data-settings-section="Collapsed child"></section>`;
    for (const element of content.querySelectorAll<HTMLElement>("section")) {
      element.getClientRects = () => [new DOMRect(0, 0, 10, 10)] as unknown as DOMRectList;
    }
    content.lastElementChild!.getClientRects = () => [] as unknown as DOMRectList;
    expect(settingsSectionDestinations(content).map(({ label }) => label)).toEqual([
      "Profile",
      "Read-only shortcuts",
      "Performance",
    ]);
  });
});
