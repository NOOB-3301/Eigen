"use client";
import { memo, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/cn";

/** Copies `text`; reports success for a moment. The Clipboard API needs a secure context, which a loopback origin is. */
export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={done ? "Copied" : label}
      title={done ? "Copied" : label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
      className={cn("grid size-7 place-items-center rounded-md text-ink-3 transition-colors hover:bg-raised hover:text-ink", className)}
    >
      {done ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
    </button>
  );
}

const textOf = (node: ReactNode): string =>
  typeof node === "string" || typeof node === "number"
    ? String(node)
    : Array.isArray(node)
      ? node.map(textOf).join("")
      : node && typeof node === "object" && "props" in node
        ? textOf((node.props as { children?: ReactNode }).children)
        : "";

/**
 * react-markdown builds React elements from the syntax tree and drops raw HTML (no rehype-raw), so model output can never inject markup.
 * Links open in a new tab without the opener; only http(s) and mailto survive react-markdown's default URL filter.
 */
const COMPONENTS: Components = {
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent">
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5 marker:text-ink-3">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5 marker:text-ink-3">{children}</ol>,
  h1: ({ children }) => <h3 className="mt-3 mb-1.5 text-[15px] font-semibold text-ink">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-3 mb-1.5 text-[14.5px] font-semibold text-ink">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-3 mb-1 text-[14px] font-semibold text-ink">{children}</h4>,
  blockquote: ({ children }) => <blockquote className="my-2 border-l-2 border-line-strong pl-3 text-ink-2">{children}</blockquote>,
  hr: () => <hr className="my-3 border-line" />,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded-lg border border-line">
      <table className="w-full border-collapse text-[12.5px] [&_tr:last-child>td]:border-b-0">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b border-line bg-raised px-2.5 py-1.5 text-left font-medium">{children}</th>,
  td: ({ children }) => <td className="border-b border-line px-2.5 py-1.5 align-top">{children}</td>,
  // Fenced blocks arrive as <pre><code class="language-x">; inline code has no <pre> parent.
  pre: ({ children }) => {
    const code = textOf(children).replace(/\n$/, "");
    const lang = /language-([\w+-]+)/.exec(String((children as { props?: { className?: string } } | undefined)?.props?.className ?? ""))?.[1];
    return (
      <div className="group/code my-2 overflow-hidden rounded-lg border border-line bg-sunken">
        <div className="flex h-7 items-center justify-between border-b border-line pr-0.5 pl-3">
          <span className="font-mono text-[11px] text-ink-3">{lang ?? "text"}</span>
          <CopyButton text={code} label="Copy code" className="size-6" />
        </div>
        <pre className="overflow-x-auto px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-ink">{children}</pre>
      </div>
    );
  },
  code: ({ children, className }) =>
    className ? <code className={className}>{children}</code> : <code className="rounded bg-sunken px-1 py-px font-mono text-[0.9em] text-ink">{children}</code>,
};

/** Memoized per text: while a reply streams only its last part re-parses. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="text-[14px] leading-relaxed break-words text-ink">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
