import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The shared card surface treatment (rounded paper + whisper of shadow).
 * Single source of truth — `Card` (div) and `CardList` (ul) both build on
 * it, so every surface stays in sync.
 */
const cardSurface =
  "rounded-md border border-border bg-card shadow-[0_1px_2px_0_rgb(0_0_0/0.04)]";

/**
 * Card — the shared surface primitive. The design system's warm-editorial
 * cards are rounded (--radius) with a paper surface and a whisper of shadow;
 * the pages historically hand-rolled `border border-border bg-card` divs
 * that skipped the radius. This is the single place the surface treatment
 * lives: panels, stat tiles, list cards.
 *
 * Composition: <Card><CardHeader><CardTitle/><CardDescription/></CardHeader>
 * <CardContent>…</CardContent><CardFooter/></Card>. For a simple tile, use
 * <Card className="p-4">…</Card> (the primitive passes className through).
 */
const Card = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn(cardSurface, className)} {...props} />
));
Card.displayName = "Card";

/**
 * CardList — the card surface for a list of rows: renders a `<ul>` (list
 * semantics kept — a div Card would make the `<li>`s invalid) with the
 * same surface treatment, the row dividers, and clipped corners so the
 * last row's border doesn't poke out of the radius.
 */
const CardList = React.forwardRef<
  HTMLUListElement,
  React.HTMLAttributes<HTMLUListElement>
>(({ className, ...props }, ref) => (
  <ul
    ref={ref}
    className={cn(
      "divide-y divide-border overflow-hidden",
      cardSurface,
      className,
    )}
    {...props}
  />
));
CardList.displayName = "CardList";

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex flex-col gap-1.5 p-6 pb-4", className)}
    {...props}
  />
));
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h3
    ref={ref}
    className={cn(
      "font-display text-lg leading-tight tracking-[-0.01em]",
      className,
    )}
    {...props}
  />
));
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    className={cn("text-xs leading-relaxed text-muted-foreground", className)}
    {...props}
  />
));
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />
));
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex items-center p-6 pt-0", className)}
    {...props}
  />
));
CardFooter.displayName = "CardFooter";

export {
  Card,
  CardList,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
};
