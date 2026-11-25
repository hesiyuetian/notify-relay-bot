import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { channelUsername } from "../../src/telegram-email/channel.ts";

test("公开频道配置规范化，拒绝邀请链接、帖子链接和任意路径", () => {
  assert.equal(channelUsername(), "aoying999");
  for (const value of [" NewsFeed ", "@NewsFeed", "https://t.me/NewsFeed/", "https://t.me/s/NewsFeed"]) {
    assert.equal(channelUsername(value), "newsfeed");
  }
  for (const value of ["../newsfeed", "https://t.me/+invite", "https://example.org/newsfeed", "https://t.me/newsfeed/17"]) {
    assert.throws(() => channelUsername(value), /TELEGRAM_CHANNEL/);
  }
});

test("切换频道按各自进度继续发送，微信标题和链接使用所选频道", () => {
  const dir = mkdtempSync(join(tmpdir(), "channel-config-"));
  const main = fileURLToPath(new URL("../../src/telegram-email/main.ts", import.meta.url));
  const preload = join(dir, "preview.mjs");
  try {
    writeFileSync(preload, `
      globalThis.fetch = async (input, options) => {
        const url = new URL(input);
        if (url.host === "sctapi.ftqq.com") {
          console.log("TEST_SEND", options.body.get("title"), options.body.get("desp"));
          return Response.json({ code: 0 });
        }
        const channel = process.env.TEST_SOURCE;
        if (url.href !== "https://t.me/s/" + channel) throw new Error("Unexpected URL");
        const id = process.env.TEST_ID;
        return new Response('<section class="tgme_channel_history"><div class="tgme_widget_message" data-post="' +
          channel + '/' + id + '"><div class="tgme_widget_message_text">新帖</div>' +
          '<a class="tgme_widget_message_date"><time datetime="2026-11-25T00:00:00Z"></time></a></div></section>');
      };
    `);
    const check = (value: string, source: string, id: number) => execFileSync(process.execPath, ["--import", preload, main], {
      cwd: dir, encoding: "utf8",
      env: { TELEGRAM_CHANNEL: value, TEST_SOURCE: source, TEST_ID: String(id), SERVERCHAN_SENDKEY: "SCTtest" },
    });
    assert.doesNotMatch(check("", "aoying999", 134), /TEST_SEND/);
    assert.doesNotMatch(check("@NewsFeed", "newsfeed", 10), /TEST_SEND/);
    assert.match(check("https://t.me/s/newsfeed", "newsfeed", 11), /TEST_SEND [^\n]*@newsfeed[\s\S]+https:\/\/t.me\/newsfeed\/11/);
    assert.match(check("AOYING999", "aoying999", 135), /TEST_SEND [^\n]*熬鹰频道[\s\S]+aoying999\/135/);
    assert.doesNotMatch(check("newsfeed", "newsfeed", 11), /TEST_SEND/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
