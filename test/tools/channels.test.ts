import assert from "node:assert/strict";
import test from "node:test";
import { configuredChannelsFor, enabledChannels, pushToAll, type Message } from "../../src/tools/channels.ts";

const sampleMessage: Message = {
  subject: "测试标题",
  telegram: "<b>测试</b>",
  email: "<p>测试</p>",
  text: "测试正文",
};

const withEnv = async (values: Record<string, string | undefined>, fn: () => void | Promise<void>) => {
  const keys = Object.keys(values);
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

test("各任务默认推送渠道：GitHub 涨星默认排除飞书，其余任务启用全部支持渠道", async () => {
  await withEnv({
    GITHUB_TRENDING_CHANNELS: undefined,
    AI_NEWS_CHANNELS: undefined,
    STOCKS_CHANNELS: undefined,
    TELEGRAM_RELAY_CHANNELS: undefined,
  }, () => {
    assert.deepEqual([...enabledChannels("github-trending")], ["telegram", "email"]);
    assert.deepEqual([...enabledChannels("ai-news")], ["telegram", "email", "feishu"]);
    assert.deepEqual([...enabledChannels("stocks")], ["telegram", "email", "feishu"]);
    assert.deepEqual([...enabledChannels("telegram-email")], ["email", "wechat", "feishu"]);
  });
});

test("自定义任务推送渠道支持大小写、中英文逗号、留空回退默认，并拒绝无效渠道", async () => {
  await withEnv({
    GITHUB_TRENDING_CHANNELS: " FEISHU，Email , email ",
    AI_NEWS_CHANNELS: "   ",
    TELEGRAM_RELAY_CHANNELS: "feishu",
  }, () => {
    assert.deepEqual([...enabledChannels("github-trending")], ["feishu", "email"]);
    assert.deepEqual([...enabledChannels("ai-news")], ["telegram", "email", "feishu"]);
    assert.deepEqual([...enabledChannels("telegram-email")], ["feishu"]);
  });

  await withEnv({ GITHUB_TRENDING_CHANNELS: "wechat" }, () => {
    assert.throws(() => enabledChannels("github-trending"), /GITHUB_TRENDING_CHANNELS 包含不支持的渠道：wechat/);
  });

  await withEnv({ STOCKS_CHANNELS: "dingtalk" }, () => {
    assert.throws(() => enabledChannels("stocks"), /STOCKS_CHANNELS 包含不支持的渠道：dingtalk/);
  });

  await withEnv({ GITHUB_TRENDING_CHANNELS: "," }, () => {
    assert.throws(() => enabledChannels("github-trending"), /GITHUB_TRENDING_CHANNELS 未指定有效的推送渠道/);
  });
});

test("pushToAll 按任务配置过滤推送渠道，GitHub 涨星默认不发飞书，自定义后可开启", async (t) => {
  const calledHosts: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = new URL(String(input));
    calledHosts.push(url.host);
    if (url.host === "api.telegram.org") return Response.json({ ok: true });
    if (url.host === "open.feishu.cn") return Response.json({ code: 0 });
    throw new Error(`Unexpected URL: ${url.href}`);
  });

  const baseEnv = {
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_CHAT_ID: "12345",
    FEISHU_WEBHOOK_URL: "https://open.feishu.cn/open-apis/bot/v2/hook/test-token",
    FEISHU_WEBHOOK_SECRET: undefined,
    SMTP_HOST: undefined,
    SMTP_USER: undefined,
    SMTP_PASS: undefined,
    MAIL_TO: undefined,
    GITHUB_TRENDING_CHANNELS: undefined,
    AI_NEWS_CHANNELS: undefined,
  };

  await withEnv(baseEnv, async () => {
    assert.deepEqual(configuredChannelsFor("github-trending"), ["telegram"]);
    await pushToAll("github-trending", sampleMessage);
    assert.deepEqual(calledHosts, ["api.telegram.org"]);

    calledHosts.length = 0;
    await pushToAll("ai-news", sampleMessage);
    assert.deepEqual(calledHosts, ["api.telegram.org", "open.feishu.cn"]);
  });

  await withEnv({ ...baseEnv, GITHUB_TRENDING_CHANNELS: "feishu" }, async () => {
    calledHosts.length = 0;
    assert.deepEqual(configuredChannelsFor("github-trending"), ["feishu"]);
    await pushToAll("github-trending", sampleMessage);
    assert.deepEqual(calledHosts, ["open.feishu.cn"]);
  });

  await withEnv({ ...baseEnv, TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_CHAT_ID: undefined }, async () => {
    assert.deepEqual(configuredChannelsFor("github-trending"), []);
    await assert.rejects(
      pushToAll("github-trending", sampleMessage),
      /没有可用的推送渠道（当前允许：telegram、email）.*GITHUB_TRENDING_CHANNELS/,
    );
  });
});
