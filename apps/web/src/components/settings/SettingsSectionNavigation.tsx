import { useEffect, useState, type RefObject } from "react";

import { cn } from "../../lib/utils";
import { observeResize } from "../../lib/observeResize";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  currentSettingsSection,
  settingsSectionDestinations,
  type SettingsSectionDestination,
} from "./settingsSectionNavigation";

function sectionTopOffset(scroll: HTMLElement): number {
  const menu = scroll.parentElement?.querySelector<HTMLElement>("[data-settings-section-menu]");
  const bounds = menu?.getBoundingClientRect();
  return bounds && bounds.height > 0
    ? Math.max(24, bounds.bottom - scroll.getBoundingClientRect().top + 12)
    : 24;
}

export function SettingsSectionNavigation({
  scrollRef,
  contentRef,
}: {
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly contentRef: RefObject<HTMLDivElement | null>;
}) {
  const [sections, setSections] = useState<SettingsSectionDestination[]>([]);
  const [active, setActive] = useState(0);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes settings DOM mutations, sizes and scroll position to maintain section-navigation targets
  useEffect(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!scroll || !content) return;
    let frame: number | null = null;
    const update = () => {
      frame = null;
      const next = settingsSectionDestinations(content);
      if (next.length === 0) next.push({ element: content, label: "Page overview" });
      setSections((previous) =>
        previous.length === next.length &&
        previous.every(
          (entry, index) =>
            entry.element === next[index]?.element && entry.label === next[index]?.label,
        )
          ? previous
          : next,
      );
      setActive(
        currentSettingsSection(
          next.map(({ element }) => element.getBoundingClientRect().top),
          scroll.getBoundingClientRect().top,
          scroll.scrollHeight > scroll.clientHeight + 1 &&
            scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2,
          sectionTopOffset(scroll) + 8,
        ),
      );
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(update);
    };
    const mutations = new MutationObserver(schedule);
    mutations.observe(content, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "hidden",
        "inert",
        "aria-hidden",
        "open",
        "data-state",
        "data-settings-section",
      ],
    });
    const stopResize = observeResize([content, scroll], schedule);
    scroll.addEventListener("scroll", schedule, { passive: true });
    update();
    return () => {
      mutations.disconnect();
      stopResize();
      scroll.removeEventListener("scroll", schedule);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [contentRef, scrollRef]);

  const jump = (index: number) => {
    const section = sections[index];
    const scroll = scrollRef.current;
    if (!section || !scroll) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    scroll.scrollTo({
      top:
        scroll.scrollTop +
        section.element.getBoundingClientRect().top -
        scroll.getBoundingClientRect().top -
        sectionTopOffset(scroll),
      behavior: reducedMotion ? "instant" : "smooth",
    });
    section.element.focus({ preventScroll: true });
    setActive(index);
  };

  return (
    <nav aria-label="Settings sections">
      <div
        data-settings-section-menu
        className="absolute inset-x-4 top-2 z-20 flex justify-end md:hidden"
      >
        <label className="flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground shadow-sm">
          <span>Jump to section</span>
          <select
            aria-label="Jump to section"
            className="max-w-40 bg-background text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            value=""
            disabled={sections.length === 0}
            onChange={(event) => jump(Number(event.target.value))}
          >
            <option value="" disabled>
              {sections[active]?.label ?? "Page overview"} (current)
            </option>
            {sections.map(({ label, element }, index) => (
              <option key={element.id || label} value={index}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="absolute top-1/2 left-0 z-20 hidden max-h-[75%] -translate-y-1/2 flex-col overflow-y-auto px-1 md:flex">
        {sections.map(({ label, element }, index) => (
          <Tooltip key={element.id || label}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={`Go to ${label}`}
                  aria-current={active === index ? "location" : undefined}
                  className="group flex min-h-6 w-7 shrink-0 items-center justify-start rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  onClick={() => jump(index)}
                />
              }
            >
              <span
                aria-hidden
                className={cn(
                  "h-0.5 w-2 rounded-full bg-muted-foreground/40 group-hover:w-4 group-hover:bg-foreground group-focus-visible:w-4",
                  active === index && "w-4 bg-foreground",
                )}
              />
            </TooltipTrigger>
            <TooltipPopup side="right">{label}</TooltipPopup>
          </Tooltip>
        ))}
      </div>
    </nav>
  );
}
