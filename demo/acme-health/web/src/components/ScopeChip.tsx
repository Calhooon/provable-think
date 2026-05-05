import { cn } from "../lib/cn";

interface ScopeChipProps {
  tags: string[];
  className?: string;
}

// Neutral, consistent palette. Phase D refines per-tag color decisions.
const TAG_COLORS: Record<string, string> = {
  PHI: "bg-tamper/10 text-tamper border-tamper/30",
  treatment: "bg-accent/10 text-accent-dark border-accent/30",
  operations: "bg-scope/10 text-scope border-scope/30",
  "de-identified": "bg-confirmed/10 text-confirmed border-confirmed/30",
};

const FALLBACK = "bg-muted text-fg-secondary border-border";

export function ScopeChip({ tags, className }: ScopeChipProps) {
  if (tags.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {tags.map((tag) => (
        <span
          key={tag}
          className={cn(
            "inline-flex items-center px-1.5 py-0.5 rounded-md border text-[11px] font-medium font-mono",
            TAG_COLORS[tag] ?? FALLBACK,
          )}
        >
          {tag}
        </span>
      ))}
    </div>
  );
}
