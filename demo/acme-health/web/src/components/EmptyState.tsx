import type { ReactNode } from "react";
import { cn } from "../lib/cn";

interface EmptyStateProps {
  title?: string;
  description?: string;
  icon?: ReactNode;
  className?: string;
}

export function EmptyState({
  title = "No events yet",
  description = "Type a question to start.",
  icon,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center gap-2 py-10 px-4",
        "text-fg-muted",
        className,
      )}
    >
      {icon ? <div className="opacity-60">{icon}</div> : null}
      <p className="text-sm font-medium text-fg-secondary">{title}</p>
      <p className="text-xs text-fg-muted max-w-[28ch]">{description}</p>
    </div>
  );
}
