import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Turn } from "../test/helpers/fake-llm.ts";
import { startEigen, waitFor } from "./harness.ts";

let eigen: Awaited<ReturnType<typeof startEigen>> | undefined;
afterEach(async () => {
  await eigen?.stop();
  eigen = undefined;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = (name: string, args: Record<string, unknown>): Turn => ({ calls: [{ name, args }] });
const replied = (text: string) => () => eigen!.tg.sent().some((t) => t.includes(text));

describe("eigen over Telegram (built server, fake Telegram, fake model)", () => {
  it("answers the allowed user", async () => {
    eigen = await startEigen([{ text: "Hi from the fake model" }]);
    eigen.tg.say("hello");
    await waitFor(replied("Hi from the fake model"));
  });

  it("ignores strangers and group chats completely", async () => {
    eigen = await startEigen([{ text: "should never be sent" }]);
    eigen.tg.say("hello", 999);
    eigen.tg.say("hello", 7, -100123, "supergroup");
    await sleep(4000);
    expect(eigen.llm.requests).toHaveLength(0);
    expect(eigen.tg.calls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
  });

  it("uses tools on the user's behalf", async () => {
    eigen = await startEigen([call("write", { path: "hello.txt", content: "from telegram" }), { text: "saved it" }]);
    eigen.tg.say("save a note");
    await waitFor(replied("saved it"));
    expect(existsSync(join(eigen.p.sandboxDir, "hello.txt"))).toBe(true);
  });
});

describe("approvals over Telegram", () => {
  it("shows Approve/Deny buttons for a risky command and only runs it once approved", async () => {
    eigen = await startEigen([call("bash", { description: "wipe", command: "rm -rf victim" }), { text: "wiped" }]);
    mkdirSync(join(eigen.p.sandboxDir, "victim"), { recursive: true });
    eigen.tg.say("clean up");

    await waitFor(() => JSON.stringify(eigen!.tg.calls).includes("inline_keyboard\":[["));
    const keyboard = eigen.tg.calls.map((c) => c.body.reply_markup?.inline_keyboard).find((k) => k?.length);
    const buttons = keyboard.flat() as Array<{ text: string; callback_data: string }>;
    expect(existsSync(join(eigen.p.sandboxDir, "victim"))).toBe(true);

    const approve = buttons.find((b) => /approve/i.test(b.text))!;
    eigen.tg.press(approve.callback_data);
    await waitFor(replied("wiped"));
    expect(existsSync(join(eigen.p.sandboxDir, "victim"))).toBe(false);
  });
});
