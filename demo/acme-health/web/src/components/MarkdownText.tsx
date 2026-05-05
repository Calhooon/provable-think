import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../lib/cn";

/**
 * Minimal markdown renderer scoped to the agent's chat output.
 * Inherits typography from the `.agent-prose` rules in `index.css`.
 *
 * Allowed surface: paragraphs, **bold**, *italic*, lists (ul/ol),
 * inline `code`, blockquote, hr, headings. Links render but always
 * open in a new tab + carry rel="noopener noreferrer". HTML is
 * disabled by react-markdown default.
 */
export function MarkdownText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <div className={cn("agent-prose text-fg", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent-dark underline underline-offset-2 hover:text-accent"
            >
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
