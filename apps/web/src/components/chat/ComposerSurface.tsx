import type { ComponentProps, ReactNode } from "react";

import { cn } from "~/lib/utils";
import type { VoiceInputPhase } from "./OpenWhisprVoiceInput";

const voicePhaseClasses = {
  idle: "",
  recording: "chat-voice-recording-active",
  transcribing: "chat-voice-transcribing-active",
  success: "chat-voice-success-active",
  "no-audio": "chat-voice-no-audio-active",
} as const satisfies Record<VoiceInputPhase, string>;

/** Share the phase across the input, attached surfaces, and portalled drawers. */
function VoiceRoot({
  phase,
  className,
  ...props
}: ComponentProps<"div"> & { phase: VoiceInputPhase }) {
  return (
    <div
      data-composer-voice-phase={phase}
      className={cn("chat-composer-voice-root", voicePhaseClasses[phase], className)}
      {...props}
    />
  );
}

/** One glass backdrop until a top attachment needs the composer to cover its overlap. */
function Shell({
  contextStrip = false,
  notice,
  className,
  ...props
}: ComponentProps<"div"> & { contextStrip?: boolean; notice?: ReactNode }) {
  return (
    <>
      <div
        data-slot="composer-shell"
        data-with-context={contextStrip || undefined}
        data-context-row={contextStrip || undefined}
        className={cn(
          "@container/composer-surface group/composer-surface relative isolate mx-auto w-full max-w-(--chat-content-max-width)",
          "[--chat-composer-drawer-inset:1.375rem] [--chat-composer-glass-surface:var(--card)] [--chat-composer-outline:rgb(0_0_0/8%)]",
          "dark:[--chat-composer-glass-surface:var(--surface-raised)] dark:[--chat-composer-highlight:rgb(255_255_255/3%)] dark:[--chat-composer-outline:color-mix(in_srgb,var(--color-white)_5%,transparent)]",
          "[html[data-theme-id]_&]:[--chat-composer-glass-surface:var(--app-theme-surface-raised)] [html[data-theme-id]_&]:[--chat-composer-outline:var(--app-theme-toolbar-border)]",
          "dark:[html[data-theme-id]:not([data-theme-id=t3-chat])_&]:[--chat-composer-highlight:color-mix(in_srgb,var(--app-theme-input)_12%,transparent)] dark:[html[data-theme-id]:not([data-theme-id=t3-chat])_&]:[--chat-composer-outline:color-mix(in_srgb,var(--app-theme-input)_30%,var(--background))]",
          "dark:[html[data-theme-id=t3-chat]_&]:[--chat-composer-highlight:color-mix(in_srgb,#432d48_12%,transparent)] dark:[html[data-theme-id=t3-chat]_&]:[--chat-composer-outline:#241e28]",
          "before:pointer-events-none before:absolute before:inset-0 before:z-0 before:rounded-3xl before:bg-(--chat-composer-glass-surface)/(--glass-opacity) before:backdrop-blur-(--glass-blur) before:backdrop-saturate-(--glass-saturation)",
          "not-supports-[((backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px)))]:before:bg-(--chat-composer-glass-surface)",
          "has-data-[composer-banner-surface=attached]:before:hidden data-model-strip-transition:before:hidden",
          contextStrip && [
            "[--chat-composer-context-extension:2.25rem] sm:[--chat-composer-context-extension:2rem]",
            // Keep one continuous backdrop around the fixed-pixel corners and rem-sized strip inset.
            "supports-[clip-path:shape(from_0_0,line_to_1px_1px)]:before:rounded-none",
            "before:[clip-path:shape(from_0_22px,curve_to_22px_0_with_0_9.85px/9.85px_0,line_to_calc(100%-22px)_0,curve_to_100%_22px_with_calc(100%-9.85px)_0/100%_9.85px,line_to_100%_calc(100%-var(--chat-composer-context-extension)-var(--chat-composer-drawer-inset)),curve_to_calc(100%-var(--chat-composer-drawer-inset))_calc(100%-var(--chat-composer-context-extension))_with_100%_calc(100%-var(--chat-composer-context-extension)-var(--chat-composer-drawer-inset)*0.4477)/calc(100%-var(--chat-composer-drawer-inset)*0.4477)_calc(100%-var(--chat-composer-context-extension)),line_to_calc(100%-var(--chat-composer-drawer-inset))_calc(100%-16px),curve_to_calc(100%-var(--chat-composer-drawer-inset)-16px)_100%_with_calc(100%-var(--chat-composer-drawer-inset))_calc(100%-7.16px)/calc(100%-var(--chat-composer-drawer-inset)-7.16px)_100%,line_to_calc(var(--chat-composer-drawer-inset)+16px)_100%,curve_to_var(--chat-composer-drawer-inset)_calc(100%-16px)_with_calc(var(--chat-composer-drawer-inset)+7.16px)_100%/var(--chat-composer-drawer-inset)_calc(100%-7.16px),line_to_var(--chat-composer-drawer-inset)_calc(100%-var(--chat-composer-context-extension)),curve_to_0_calc(100%-var(--chat-composer-context-extension)-var(--chat-composer-drawer-inset))_with_calc(var(--chat-composer-drawer-inset)*0.4477)_calc(100%-var(--chat-composer-context-extension))/0_calc(100%-var(--chat-composer-context-extension)-var(--chat-composer-drawer-inset)*0.4477),line_to_0_22px,close)]",
            "not-supports-[clip-path:shape(from_0_0,line_to_1px_1px)]:before:bottom-(--chat-composer-context-extension)",
          ],
          className,
        )}
        {...props}
      />
      {/* Notices must not enlarge the glass or paint behind its backdrop. */}
      {notice}
    </>
  );
}

const outlineClasses =
  "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:border after:border-(--chat-composer-outline) dark:after:inset-shadow-2xs dark:after:inset-shadow-(color:--chat-composer-highlight)";

function Host({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-host"
      className={cn(
        "relative z-10 w-full rounded-2xl shadow-composer after:z-1 dark:shadow-none",
        "group-data-context-row/composer-surface:before:pointer-events-none group-data-context-row/composer-surface:before:absolute group-data-context-row/composer-surface:before:inset-0 group-data-context-row/composer-surface:before:-z-1 group-data-context-row/composer-surface:before:rounded-2xl group-data-context-row/composer-surface:before:bg-(--chat-composer-glass-surface)/(--glass-opacity) group-data-context-row/composer-surface:before:backdrop-blur-(--glass-blur) group-data-context-row/composer-surface:before:backdrop-saturate-(--glass-saturation)",
        outlineClasses,
        "group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-none group-has-data-[composer-banner-surface=attached]/composer-surface:before:hidden group-has-data-[composer-banner-surface=attached]/composer-surface:after:hidden",
        className,
      )}
      {...props}
    />
  );
}

function Main({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-chat-composer-main-surface="true"
      className={cn(
        "chat-composer-voice-halo-surface group relative z-10 rounded-2xl p-px",
        // The host also wraps shoulder tabs, so its backdrop would extend above the input.
        "group-data-model-strip-transition/composer-surface:bg-(--chat-composer-glass-surface)/(--glass-opacity) group-data-model-strip-transition/composer-surface:backdrop-blur-(--glass-blur) group-data-model-strip-transition/composer-surface:backdrop-saturate-(--glass-saturation)",
        outlineClasses,
        "after:z-20 after:hidden group-has-data-[composer-banner-surface=attached]/composer-surface:after:block",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:bg-(--chat-composer-glass-surface)/(--glass-opacity) group-has-data-[composer-banner-surface=attached]/composer-surface:backdrop-blur-(--glass-blur) group-has-data-[composer-banner-surface=attached]/composer-surface:backdrop-saturate-(--glass-saturation)",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-composer dark:group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-none",
        "not-supports-[((backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px)))]:group-has-data-[composer-banner-surface=attached]/composer-surface:bg-(--chat-composer-glass-surface)",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:**:data-[chat-composer-mobile-collapsed=true]:min-h-[calc(1rem+1px)]",
        className,
      )}
      {...props}
    />
  );
}

/** A plain row under the card (environment, worktree, branch) with no surface of its own. */
function ContextStrip({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-context-strip"
      className={cn(
        "group/composer-context relative flex w-full items-center gap-2 overflow-x-clip px-2 pt-2 text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export const ComposerSurface = { VoiceRoot, Shell, Host, Main, ContextStrip };
