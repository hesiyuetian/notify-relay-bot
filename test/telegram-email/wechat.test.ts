import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { forward, type Recipient } from "../../src/telegram-email/forward.ts";
import { sendWeChat } from "../../src/telegram-email/wechat.ts";
import type { Post } from "../../src/telegram-email/channel.ts";

const post = (id: number): Post => ({ channel: "aoying999", id, date: "2026-11-25T10:00:00Z", text: "加仓 · 测试" });

test("微信测试只使用方糖服务号，检查 HTTP 和业务返回码", async (t) => {
  const responses = [
    Response.json({ code: 0, data: { errno: 0 } }),
    Response.json({ code: 0, data: { errno: 123, error: "SCTprivate" } }),
    new Response("SCTprivate", { status: 429 }),
    new Response("<html>SCTprivate</html>"),
  ];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(url, "https://sctapi.ftqq.com/SCTprivate.send");
    assert.equal(options.method, "POST");
    const form = options.body as URLSearchParams;
    assert.equal(form.get("channel"), "9");
    assert.match(form.get("title")!, /^\[测试\].*加仓/);
    assert.match(form.get("desp")!, /https:\/\/t.me\/aoying999\/3/);
    return responses.shift();
  });
  const send = () => sendWeChat("SCTprivate", post(3), true);
  await send();
  await assert.rejects(send, { message: "Server酱 123" });
  await assert.rejects(send, { message: "Server酱 HTTP 429" });
  await assert.rejects(send, { message: "Server酱 响应异常" });
});

test("新增微信从当前帖订阅，遇到日额度限制时邮箱继续，下次额度恢复后补发", async (t) => {
  const db = new DatabaseSync(":memory:");
  const email: number[] = [], wechat: number[] = [];
  const mailbox: Recipient = { to: "a@example.test", deliver: async (p) => { email.push(p.id); } };
  let now = Date.parse("2026-11-25T07:00:00Z");
  t.mock.method(Date, "now", () => now);
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    attempts++;
    return Response.json(attempts === 1 ? { code: 42, message: "超过每日额度" } : { code: 0 });
  });
  const wx: Recipient = { to: "wechat", label: "个人微信", deliver: async (p) => {
    await sendWeChat("SCTtest", p);
    wechat.push(p.id);
  } };
  const page = (...ids: number[]) => async () => ({ posts: ids.map(post) });
  try {
    await forward(db, [mailbox], page(1));
    await forward(db, [mailbox, wx], page(1, 2));
    await assert.rejects(forward(db, [mailbox, wx], page(2, 3)), /个人微信.*#3/);
    await forward(db, [mailbox, wx], page(3, 4));
    assert.equal(attempts, 1);
    assert.deepEqual(email, [2, 3, 4]);
    now = Date.parse("2026-11-25T16:00:01Z");
    await forward(db, [mailbox, wx], page(2, 3, 4));
    await forward(db, [mailbox, wx], page(2, 3, 4));
    assert.deepEqual(wechat, [3, 4]);
    assert.deepEqual(email, [2, 3, 4]);
  } finally {
    db.close();
  }
});
