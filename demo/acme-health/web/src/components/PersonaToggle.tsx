import * as Tabs from "@radix-ui/react-tabs";
import type { Persona } from "../types/agent-events";
import { cn } from "../lib/cn";

interface PersonaToggleProps {
  value: Persona;
  onChange: (persona: Persona) => void;
  className?: string;
}

const PERSONAS: Array<{ value: Persona; label: string; short: string }> = [
  { value: "compliance-officer", label: "Compliance Officer", short: "Compliance" },
  { value: "patient", label: "Patient", short: "Patient" },
  { value: "external-auditor", label: "External HIPAA Auditor", short: "Auditor" },
];

export function PersonaToggle({ value, onChange, className }: PersonaToggleProps) {
  return (
    <Tabs.Root
      value={value}
      onValueChange={(v) => onChange(v as Persona)}
      className={cn("w-full", className)}
    >
      <Tabs.List
        className={cn(
          "inline-flex w-full p-1 gap-1 rounded-lg bg-muted border border-border",
        )}
        aria-label="Persona"
      >
        {PERSONAS.map((p) => (
          <Tabs.Trigger
            key={p.value}
            value={p.value}
            className={cn(
              "flex-1 px-3 py-1.5 rounded-md text-xs font-medium",
              "text-fg-secondary hover:text-fg",
              "data-[state=active]:bg-surface data-[state=active]:text-fg",
              "data-[state=active]:shadow-sm transition-colors",
            )}
            title={p.label}
          >
            <span className="hidden xl:inline">{p.label}</span>
            <span className="xl:hidden">{p.short}</span>
          </Tabs.Trigger>
        ))}
      </Tabs.List>
    </Tabs.Root>
  );
}
