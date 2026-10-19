"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";

import { cn } from "~/lib/utils";

const cardPadding = {
  default: "p-6",
  xs: "p-3 sm:p-4",
  sm: "p-4",
  md: "p-5",
  compact: "p-4 sm:p-5",
  flush: "p-0",
} as const;
type CardSize = keyof typeof cardPadding;

const cardSpacing = {
  2: "space-y-2",
  3: "space-y-3",
  4: "space-y-4",
  5: "space-y-5",
} as const;

function Card({
  className,
  render,
  variant = "default",
  ...props
}: useRender.ComponentProps<"div"> & { variant?: "default" | "warning" }) {
  const defaultProps = {
    className: cn(
      "relative flex flex-col rounded-2xl border bg-card not-dark:bg-clip-padding text-card-foreground shadow-xs/5 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
      variant === "warning" && "border-warning/35",
      className,
    ),
    "data-slot": "card",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
}

function CardFrame({ className, render, ...props }: useRender.ComponentProps<"div">) {
  const defaultProps = {
    className: cn(
      "[--clip-top:-1rem] [--clip-bottom:-1rem] *:data-[slot=card]:first:[--clip-top:1px] *:data-[slot=card]:last:[--clip-bottom:1px] flex flex-col relative rounded-2xl border bg-card before:bg-muted/72 not-dark:bg-clip-padding text-card-foreground shadow-xs/5 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)] *:data-[slot=card]:-m-px *:not-last:data-[slot=card]:rounded-b-xl *:not-last:data-[slot=card]:before:rounded-b-[calc(var(--radius-xl)-1px)] *:not-first:data-[slot=card]:rounded-t-xl *:not-first:data-[slot=card]:before:rounded-t-[calc(var(--radius-xl)-1px)] *:data-[slot=card]:[clip-path:inset(var(--clip-top)_1px_var(--clip-bottom)_1px_round_calc(var(--radius-2xl)-1px))] *:data-[slot=card]:shadow-none *:data-[slot=card]:before:hidden *:data-[slot=card]:bg-clip-padding",
      className,
    ),
    "data-slot": "card-frame",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
}

function CardFrameHeader({ className, render, ...props }: useRender.ComponentProps<"div">) {
  const defaultProps = {
    className: cn("relative flex flex-col px-6 py-4", className),
    "data-slot": "card-frame-header",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
}

function CardFrameTitle({ className, render, ...props }: useRender.ComponentProps<"div">) {
  const defaultProps = {
    className: cn("font-semibold text-sm", className),
    "data-slot": "card-frame-title",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
}

function CardFrameDescription({ className, render, ...props }: useRender.ComponentProps<"div">) {
  const defaultProps = {
    className: cn("text-muted-foreground text-sm", className),
    "data-slot": "card-frame-description",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
}

function CardFrameFooter({ className, render, ...props }: useRender.ComponentProps<"div">) {
  const defaultProps = {
    className: cn("px-6 py-4", className),
    "data-slot": "card-frame-footer",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
}

function CardHeader({
  className,
  render,
  size = "default",
  variant = "default",
  gap,
  ...props
}: useRender.ComponentProps<"div"> & {
  size?: CardSize;
  variant?: "default" | "divided";
  gap?: 3;
}) {
  const defaultProps = {
    className: cn(
      "grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 in-[[data-slot=card]:has(>[data-slot=card-panel])]:pb-4 has-data-[slot=card-action]:grid-cols-[1fr_auto]",
      cardPadding[size],
      variant === "divided" && "border-b border-border/60",
      gap === 3 && "gap-3",
      className,
    ),
    "data-slot": "card-header",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
}

function CardTitle({
  className,
  render,
  size = "default",
  ...props
}: useRender.ComponentProps<"div"> & { size?: "default" | "sm" }) {
  const defaultProps = {
    className: cn("font-semibold leading-none", size === "sm" ? "text-base" : "text-lg", className),
    "data-slot": "card-title",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
}

function CardDescription({
  className,
  render,
  truncate = false,
  ...props
}: useRender.ComponentProps<"div"> & { truncate?: boolean }) {
  const defaultProps = {
    className: cn("text-muted-foreground text-sm", truncate && "truncate", className),
    "data-slot": "card-description",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
}

function CardAction({ className, render, ...props }: useRender.ComponentProps<"div">) {
  const defaultProps = {
    className: cn(
      "col-start-2 row-span-2 row-start-1 self-start justify-self-end inline-flex",
      className,
    ),
    "data-slot": "card-action",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
}

function CardPanel({
  className,
  render,
  size = "default",
  variant = "default",
  spacing,
  gap,
  tone = "default",
  ...props
}: useRender.ComponentProps<"div"> & {
  size?: CardSize;
  variant?: "default" | "divided";
  spacing?: keyof typeof cardSpacing;
  gap?: 2;
  tone?: "default" | "muted" | "caption";
}) {
  const defaultProps = {
    className: cn(
      "flex-1 in-[[data-slot=card]:has(>[data-slot=card-header]:not(.border-b))]:pt-0 in-[[data-slot=card]:has(>[data-slot=card-footer]:not(.border-t))]:pb-0",
      cardPadding[size],
      variant === "divided" && "border-t border-border/60",
      spacing !== undefined && cardSpacing[spacing],
      gap === 2 && "gap-2",
      tone === "muted" && "text-sm text-muted-foreground",
      tone === "caption" && "text-xs text-muted-foreground",
      className,
    ),
    "data-slot": "card-panel",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
}

function CardFooter({ className, render, ...props }: useRender.ComponentProps<"div">) {
  const defaultProps = {
    className: cn(
      "flex items-center p-6 in-[[data-slot=card]:has(>[data-slot=card-panel])]:pt-4",
      className,
    ),
    "data-slot": "card-footer",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
}

export {
  Card,
  CardFrame,
  CardFrameHeader,
  CardFrameTitle,
  CardFrameDescription,
  CardFrameFooter,
  CardAction,
  CardDescription,
  CardFooter,
  CardHeader,
  CardPanel,
  CardPanel as CardContent,
  CardTitle,
};
