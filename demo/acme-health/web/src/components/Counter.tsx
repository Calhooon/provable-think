import { useEffect, useState } from "react";
import { animate, useMotionValue } from "framer-motion";
import { cn } from "../lib/cn";
import { motion as motionTokens } from "../lib/tokens";

interface CounterProps {
  value: number;
  /** For accessibility only — not rendered. The container provides the visible label. */
  label: string;
  format?: (n: number) => string;
  className?: string;
}

export function Counter({ value, label, format, className }: CounterProps) {
  const motionValue = useMotionValue(value);
  const [display, setDisplay] = useState(value);

  useEffect(() => {
    const controls = animate(motionValue, value, {
      duration: motionTokens.pane,
      ease: motionTokens.ease,
      onUpdate: (latest) => setDisplay(latest),
    });
    return () => controls.stop();
  }, [value, motionValue]);

  const rendered = format
    ? format(display)
    : Math.round(display).toLocaleString();

  return (
    <span
      role="status"
      aria-label={label}
      className={cn("tabular-nums tracking-tight", className)}
    >
      {rendered}
    </span>
  );
}
