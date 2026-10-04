import { createHash } from "node:crypto";

/**
 * Telegram allows 64 bytes of callback data per button. The adapter sends `chat:{"a":"tool_approve:<toolCallId>"}`, which is 26 bytes plus the id,
 * so an id over 38 characters (`call-<uuid>` from some providers is 41) makes the whole approval card fail to post. These ids are shortened on the
 * way out and restored when the button is tapped.
 */
const MAX_ID = 38;
const UUID_CALL = /^call-([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i;
const PACKED_UUID = /^~([0-9a-f]{32})$/i;
const HASHED = /^~~[0-9a-f]{20}$/;
const ACTION = /^(tool_(?:approve|deny)):(.+)$/;

const hashed = new Map<string, string>();

export function shortenToolCallId(id: string) {
  if (id.length <= MAX_ID) return id;
  const uuid = UUID_CALL.exec(id);
  if (uuid) return `~${uuid.slice(1).join("")}`;
  const short = `~~${createHash("sha1").update(id).digest("hex").slice(0, 20)}`;
  hashed.set(short, id);
  return short;
}

export function restoreToolCallId(id: string) {
  if (HASHED.test(id)) return hashed.get(id) ?? id;
  const hex = PACKED_UUID.exec(id)?.[1];
  return hex ? `call-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` : id;
}

const mapAction = (actionId: string, f: (id: string) => string) => {
  const m = ACTION.exec(actionId);
  return m ? `${m[1]}:${f(m[2]!)}` : actionId;
};

export const shortenActionId = (actionId: string) => mapAction(actionId, shortenToolCallId);
export const restoreActionId = (actionId: string) => mapAction(actionId, restoreToolCallId);

/** Rewrites the id of every button in a card (plain strings and other values pass through untouched). */
export function shortenCardActions<T>(value: T): T {
  if (Array.isArray(value)) return value.map(shortenCardActions) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const o = value as Record<string, unknown>;
    const mapped = Object.fromEntries(Object.entries(o).map(([k, v]) => [k, shortenCardActions(v)]));
    return (o.type === "button" && typeof o.id === "string" ? { ...mapped, id: shortenActionId(o.id) } : mapped) as T;
  }
  return value;
}

type Poster = {
  postMessage: (threadId: string, message: unknown, ...rest: unknown[]) => Promise<unknown>;
  editMessage: (threadId: string, messageId: string, message: unknown, ...rest: unknown[]) => Promise<unknown>;
};

/** Makes the adapter shorten approve/deny button ids whenever it posts or edits a card. Returns the same adapter. */
export function shortenApprovalButtons<A extends object>(adapter: A): A {
  const a = adapter as unknown as Poster;
  const post = a.postMessage.bind(a);
  const edit = a.editMessage.bind(a);
  a.postMessage = (threadId, message, ...rest) => post(threadId, shortenCardActions(message), ...rest);
  a.editMessage = (threadId, messageId, message, ...rest) => edit(threadId, messageId, shortenCardActions(message), ...rest);
  return adapter;
}
