// Split on paragraph, then line, then word boundaries; hard-cut only as a last resort.
export function splitMessage(text: string, size: number): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  const minCut = Math.floor(size * 0.3); // don't produce tiny chunks just to hit a boundary
  while (rest.length > size) {
    const window = rest.slice(0, size + 1);
    let cut = -1;
    for (const sep of ["\n\n", "\n", " "]) {
      const i = window.lastIndexOf(sep, size);
      if (i >= minCut) {
        cut = i;
        break;
      }
    }
    if (cut < 0) {
      cut = size;
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut--; // don't split a surrogate pair
    }
    const chunk = rest.slice(0, cut).trimEnd();
    if (chunk) chunks.push(chunk);
    rest = rest.slice(cut).replace(/^[\n ]+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Minimal Markdown -> Telegram HTML for what models actually emit. Only matched pairs are
// converted, so a chunk split inside a code fence still yields valid HTML.
export function toTelegramHtml(text: string): string {
  const slots: string[] = [];
  const hold = (html: string) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = escapeHtml(text);
  s = s.replace(/```[\w+-]*\n?([\s\S]*?)```/g, (_, code: string) => hold(`<pre>${code.replace(/\n$/, "")}</pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_, code: string) => hold(`<code>${code}</code>`));
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => slots[Number(i)]!);
}
