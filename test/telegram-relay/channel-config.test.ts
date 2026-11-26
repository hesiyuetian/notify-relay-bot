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
        const posts = process.env.TEST_ID.split(",").map((id) => {
          let body = "新帖";
          if (channel === "aoying999") {
            body = id === "146"
              ? "熬鹰会员群发言实时转发我已做好<br>通常是他在群里通知了才去下单"
              : "【熬鹰币安实盘】<br><br>🔴 平仓 · 牛来USDT 永续 · 平多<br>【平仓量】 480,192 牛来<br><br>" +
                "当前持仓 · 1 个<br>NVDAUSDT · 多<br><br>✅点击欧易币安绑定永久8折<br>✅点击订阅其它大神开单通知群";
          }
          return '<div class="tgme_widget_message" data-post="' + channel + '/' + id +
            '"><div class="tgme_widget_message_text">' + body + '</div>' +
            '<a class="tgme_widget_message_date"><time datetime="2026-11-25T00:00:00Z"></time></a></div>';
        });
        return new Response('<section class="tgme_channel_history">' + posts.join("") + '</section>');
      };
    `);
    const check = (
      value: string,
      source: string,
      id: number | number[],
      args: string[] = [],
      failFeishu = false,
      wechatEnabled = "true",
      relayChannels?: string,
    ) => {
      const result = spawnSync(process.execPath, ["--import", preload, main, ...args], {
        cwd: dir, encoding: "utf8",
        env: {
          TELEGRAM_CHANNEL: value, TEST_SOURCE: source, TEST_ID: String(id), SERVERCHAN_SENDKEY: "SCTtest",
          WECHAT_PUSH_ENABLED: wechatEnabled,
          FEISHU_WEBHOOK_URL: "https://open.feishu.cn/open-apis/bot/v2/hook/test-token",
          FAIL_FEISHU: failFeishu ? "1" : "0",
          ...(relayChannels !== undefined ? { TELEGRAM_RELAY_CHANNELS: relayChannels } : {}),
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
    assert.doesNotMatch(check("", "aoying999", 144), /TEST_SEND|FEISHU_SEND/);
    assert.equal(check("@NewsFeed", "newsfeed", 10).trim(), "");
    assert.match(check("https://t.me/s/newsfeed", "newsfeed", 11), /TEST_SEND [^\n]*@newsfeed[\s\S]+https:\/\/t.me\/newsfeed\/11/);
    const position = check("AOYING999", "aoying999", [145, 146]);
    assert.match(position, /TEST_SEND [^\n]*熬鹰频道[\s\S]+aoying999\/145/);
    assert.match(position, /FEISHU_SEND [^\n]*熬鹰频道[\s\S]+aoying999\/145/);
    assert.match(position, /【平仓量】 480,192 牛来[\s\S]+当前持仓 · 1 个/);
    assert.doesNotMatch(position, /会员群|永久8折|开单通知群|aoying999\/146/);
    assert.doesNotMatch(check("", "aoying999", 146), /TEST_SEND|FEISHU_SEND/);
    const preview = check("", "aoying999", [145, 146], ["--dry-run"]);
    assert.match(preview, /aoying999\/145/);
    assert.doesNotMatch(preview, /TEST_SEND|FEISHU_SEND|会员群|永久8折|开单通知群/);
    assert.match(check("", "aoying999", [145, 146], ["--test-feishu"]), /FEISHU_SEND \[测试\][\s\S]+aoying999\/145/);
    assert.match(check("", "aoying999", 146, ["--test-feishu"]), /^频道最新一页没有符合转发条件的帖子\s*$/);
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
    const feishuOnly = check("newsfeed", "newsfeed", 14, [], false, "true", "feishu");
    assert.match(feishuOnly, /FEISHU_SEND/);
    assert.doesNotMatch(feishuOnly, /TEST_SEND/);
    const catchupWechat = check("newsfeed", "newsfeed", 14, [], false, "true", "wechat,feishu");
    assert.match(catchupWechat, /TEST_SEND/);
    assert.doesNotMatch(catchupWechat, /FEISHU_SEND/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
