import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { channelUsername } from "../../src/telegram-relay/channel.ts";

test("公开频道配置规范化，拒绝邀请链接、帖子链接和任意路径", () => {
  assert.equal(channelUsername(), "aoying999");
  for (const value of [" NewsFeed ", "@NewsFeed", "https://t.me/NewsFeed/", "https://t.me/s/NewsFeed"]) {
    assert.equal(channelUsername(value), "newsfeed");
  }
  for (const value of ["../newsfeed", "https://t.me/+invite", "https://example.org/newsfeed", "https://t.me/newsfeed/17"]) {
    assert.throws(() => channelUsername(value), /TELEGRAM_CHANNEL/);
  }
});

test("切换频道时微信与飞书按各自进度发送，飞书测试不建立进度", () => {
  const dir = mkdtempSync(join(tmpdir(), "channel-config-"));
  const main = fileURLToPath(new URL("../../dist/telegram-relay/main.js", import.meta.url));
  const preload = join(dir, "preview.mjs");
  try {
    writeFileSync(preload, `
      globalThis.fetch = async (input, options) => {
        const url = new URL(input);
        if (url.host === "sctapi.ftqq.com") {
          console.log("TEST_SEND", options.body.get("title"), options.body.get("desp"));
          return Response.json({ code: 0 });
        }
        if (url.host === "open.feishu.cn") {
          console.log("FEISHU_SEND", JSON.parse(options.body).content.text);
          return Response.json({ code: process.env.FAIL_FEISHU === "1" ? 19021 : 0 });
        }
        const channel = process.env.TEST_SOURCE;
        if (url.href !== "https://t.me/s/" + channel) throw new Error("Unexpected URL");
        const id = process.env.TEST_ID;
        return new Response('<section class="tgme_channel_history"><div class="tgme_widget_message" data-post="' +
          channel + '/' + id + '"><div class="tgme_widget_message_text">新帖</div>' +
          '<a class="tgme_widget_message_date"><time datetime="2026-11-25T00:00:00Z"></time></a></div></section>');
      };
    `);
    const check = (value: string, source: string, id: number, args: string[] = [], failFeishu = false, wechatEnabled = "true") => {
      const result = spawnSync(process.execPath, ["--import", preload, main, ...args], {
        cwd: dir, encoding: "utf8",
        env: {
          TELEGRAM_CHANNEL: value, TEST_SOURCE: source, TEST_ID: String(id), SERVERCHAN_SENDKEY: "SCTtest",
          WECHAT_PUSH_ENABLED: wechatEnabled,
          FEISHU_WEBHOOK_URL: "https://open.feishu.cn/open-apis/bot/v2/hook/test-token",
          FAIL_FEISHU: failFeishu ? "1" : "0",
        },
      });
      assert.equal(result.status, failFeishu ? 1 : 0, result.stderr);
      if (failFeishu) assert.match(result.stderr, /飞书.*19021/);
      return result.stdout;
    };
    const testRun = check("@NewsFeed", "newsfeed", 10, ["--test-feishu"]);
    assert.match(testRun, /FEISHU_SEND \[测试\]/);
    assert.doesNotMatch(testRun, /TEST_SEND/);
    assert.equal(existsSync(join(dir, ".telegram-email")), false);
    assert.doesNotMatch(check("", "aoying999", 134), /TEST_SEND/);
    assert.equal(check("@NewsFeed", "newsfeed", 10).trim(), "检查 Telegram 频道 @newsfeed");
    assert.match(check("https://t.me/s/newsfeed", "newsfeed", 11), /TEST_SEND [^\n]*@newsfeed[\s\S]+https:\/\/t.me\/newsfeed\/11/);
    assert.match(check("AOYING999", "aoying999", 135), /TEST_SEND [^\n]*熬鹰频道[\s\S]+aoying999\/135/);
    assert.doesNotMatch(check("newsfeed", "newsfeed", 11), /TEST_SEND|FEISHU_SEND/);
    assert.match(check("newsfeed", "newsfeed", 12, [], true), /TEST_SEND/);
    const retry = check("newsfeed", "newsfeed", 12);
    assert.match(retry, /FEISHU_SEND [^\n]*@newsfeed[\s\S]+https:\/\/t.me\/newsfeed\/12/);
    assert.doesNotMatch(retry, /TEST_SEND/);
    const paused = check("newsfeed", "newsfeed", 13, [], false, "false");
    assert.match(paused, /FEISHU_SEND/);
    assert.doesNotMatch(paused, /TEST_SEND|已接受帖子|开始订阅新帖/);
    const resumed = check("newsfeed", "newsfeed", 13);
    assert.match(resumed, /TEST_SEND/);
    assert.doesNotMatch(resumed, /FEISHU_SEND/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
