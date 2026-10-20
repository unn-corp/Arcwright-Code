export interface SettingsSectionDestination {
  readonly element: HTMLElement;
  readonly label: string;
}

export function settingsSectionDestinations(content: HTMLElement): SettingsSectionDestination[] {
  return Array.from(content.querySelectorAll<HTMLElement>("[data-settings-section]"))
    .filter((element) => {
      if (element.closest('[hidden], [aria-hidden="true"]')) return false;
      return element.getClientRects().length > 0;
    })
    .flatMap((element) => {
      const label = element.dataset.settingsSection?.trim();
      return label ? [{ element, label }] : [];
    });
}

export function currentSettingsSection(
  sectionTops: readonly number[],
  viewportTop: number,
  atBottom: boolean,
  headingOffset = 32,
): number {
  if (sectionTops.length === 0) return -1;
  if (atBottom) return sectionTops.length - 1;
  let current = 0;
  for (let index = 0; index < sectionTops.length; index++) {
    if (sectionTops[index]! <= viewportTop + headingOffset) current = index;
  }
  return current;
}
