import type { ResizableWidthHandlers } from "~/hooks/useResizableWidth";
import { cn } from "~/lib/utils";

interface Props {
  handlers: ResizableWidthHandlers;
  className?: string;
}

/* Widen the panel-edge grab target for touch without thickening its visible line. Keep touch-action:none so dragging does not become a browser pan that cancels the pointer sequence. */
export function RightPanelResizeHandle({ handlers, className }: Props) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      className={cn(
        "group absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize touch-none select-none",
        "pointer-coarse:before:-translate-x-1/2 pointer-coarse:before:absolute pointer-coarse:before:inset-y-0 pointer-coarse:before:left-1/2 pointer-coarse:before:w-11",
        className,
      )}
      {...handlers}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover:bg-border group-active:bg-primary/60"
      />
    </div>
  );
}
