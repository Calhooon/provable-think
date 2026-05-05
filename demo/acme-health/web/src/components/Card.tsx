import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../lib/cn";

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function Card({ className, children, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          "bg-surface border border-border rounded-xl p-4 shadow-sm",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    );
  },
);
