import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { formatPost, parsePage, since, type Post } from "../../src/telegram-email/channel.ts";
import { forward } from "../../src/telegram-email/forward.ts";

const post = (id: number): Post => ({ channel: "aoying999", id, date: "2026-11-24T12:00:00Z", text: `帖子 #${id}` });
const page = (ids: number[], before?: number) => ({ posts: ids.map(post), before });

test("公开预览正文保留换行和字面标签，邮件附北京时间和原帖", () => {
  const markup = `<section class="tgme_channel_history"><a data-before="7"></a>
    <div class="tgme_widget_message" data-post="aoying999/7">
      <div class="tgme_widget_message_text"><b>【熬鹰币安实盘】</b><br><br><b>减仓 · A&amp;B</b><br>&lt;script&gt;</div>
      <a class="tgme_widget_message_date"><time datetime="2026-11-24T12:00:00Z"></time></a>
    </div></section>`;
  const parsed = parsePage(markup, "aoying999");
  assert.equal(parsed.before, 7);
  assert.equal(parsed.posts[0].text, "【熬鹰币安实盘】\n\n减仓 · A&B\n<script>");
  const mail = formatPost(parsed.posts[0]);
  assert.match(mail.subject, /减仓 · A&B/);
  assert.match(mail.html, /&lt;script&gt;/);
  assert.match(mail.text, /20:00:00[\s\S]+https:\/\/t.me\/aoying999\/7/);
  assert.throws(() => parsePage("<html></html>", "aoying999"));
});

test("首次建立基线，跨页去重，部分失败重跑时按各自进度发送", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const sentA: number[] = [], sentB: number[] = [];
    let fail = true;
    const recipients = [
      { to: "a@example.test", deliver: async (p: Post) => { sentA.push(p.id); } },
      { to: "b@example.test", deliver: async (p: Post) => {
        if (fail && p.id === 12) throw new Error("SMTP");
        sentB.push(p.id);
      } },
    ];
    await forward(db, recipients, async () => page([9, 10]));
    assert.deepEqual([sentA, sentB], [[], []]);
    const fetchNew = async (before?: number) => before ? page([10, 11, 12, 13]) : page([13, 14], 13);
    await assert.rejects(forward(db, recipients, fetchNew), /收件人 2，帖子 #12/);
    assert.deepEqual(sentB, [11]);
    fail = false;
    await forward(db, recipients, fetchNew);
    await forward(db, recipients, fetchNew);
    assert.deepEqual(sentA, [11, 12, 13, 14]);
    assert.deepEqual(sentB, sentA);
  } finally {
    db.close();
  }
});

test("回溯失败保留原进度，分页停滞能结束任务", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const sent: number[] = [];
    const recipients = [{ to: "test@example.test", deliver: async (p: Post) => { sent.push(p.id); } }];
    await forward(db, recipients, async () => page([2]));
    await assert.rejects(forward(db, recipients, async () => page([10, 11], 10)), /无法回溯/);
    await forward(db, recipients, async () => page([3, 4]));
    assert.deepEqual(sent, [3, 4]);
    await assert.rejects(since(page([20]), 4, async () => page([])), /无法回溯/);
  } finally {
    db.close();
  }
});
