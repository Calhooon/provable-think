import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";

export type BadgeVariant =
  | "default"
  | "confirmed"
  | "propagating"
  | "tamper"
  | "scope"
  | "accent";

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  children: ReactNode;
}

const VARIANTS: Record<BadgeVariant, string> = {
  default: "bg-muted text-fg-secondary border-border",
  confirmed: "bg-confirmed/10 text-confirmed border-confirmed/30",
  propagating: "bg-propagating/10 text-propagating border-propagating/30",
  tamper: "bg-tamper/10 text-tamper border-tamper/40",
  scope: "bg-scope/10 text-scope border-scope/30",
  accent: "bg-accent/10 text-accent-dark border-accent/30",
};

export function Badge({
  variant = "default",
  className,
  children,
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-medium",
        VARIANTS[variant],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
