import { forwardRef, type ReactNode } from "react";
import { cn } from "../lib/cn";

interface PaneProps {
  title: string;
  badge?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export const Pane = forwardRef<HTMLDivElement, PaneProps>(function Pane(
  { title, badge, children, className },
  ref,
) {
  return (
    <section
      ref={ref}
      className={cn(
        "bg-surface border border-border rounded-xl flex flex-col min-h-[480px] lg:min-h-[640px] overflow-hidden",
        className,
      )}
    >
      <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border">
        <h2 className="text-sm font-semibold text-fg tracking-tight">{title}</h2>
        {badge ? <div className="shrink-0">{badge}</div> : null}
      </header>
      <div className="flex-1 overflow-y-auto p-4">{children}</div>
    </section>
  );
});
