import assert from "node:assert/strict";
import test from "node:test";
import { sendFeishu } from "../../src/tools/feishu.ts";

const webhook = "https://open.feishu.cn/open-apis/bot/v2/hook/test-token";

test("飞书文本请求使用官方签名格式，接受两种成功响应", async (t) => {
  t.mock.method(Date, "now", () => 1_700_000_000_999);
  const payloads: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, webhook);
    assert.equal(options?.method, "POST");
    assert.equal(options?.redirect, "error");
    payloads.push(JSON.parse(options?.body as string));
    return Response.json(payloads.length === 1 ? { code: 0 } : { StatusCode: 0 });
  });

  await sendFeishu({ webhook, secret: "test-secret" }, "标题", "正文\nhttps://t.me/test/1");
  await sendFeishu({ webhook }, "标题", "正文");
  assert.deepEqual(payloads, [
    {
      timestamp: "1700000000",
      sign: "mbm4Y4oluIPQ00qlBIhX8vAZ0EKv3nw0LuTb91jPL84=",
      msg_type: "text",
      content: { text: "标题\n\n正文\nhttps://t.me/test/1" },
    },
    { msg_type: "text", content: { text: "标题\n\n正文" } },
  ]);
});

test("飞书拒收、无效响应、连接失败均报错，日志可用错误不含凭据", async (t) => {
  const responses = [
    Response.json({ code: 19021, msg: webhook }),
    new Response(webhook, { status: 429 }),
    new Response(webhook),
  ];
  t.mock.method(globalThis, "fetch", async () => {
    const response = responses.shift();
    if (!response) throw Error(webhook);
    return response;
  });
  await assert.rejects(sendFeishu({ webhook }, "标题", "正文"), { message: "飞书返回码 19021" });
  await assert.rejects(sendFeishu({ webhook }, "标题", "正文"), { message: "飞书 HTTP 429" });
  await assert.rejects(sendFeishu({ webhook }, "标题", "正文"), { message: "飞书响应格式异常" });
  await assert.rejects(sendFeishu({ webhook }, "标题", "正文"), { message: "飞书连接失败或超时" });
  await assert.rejects(sendFeishu({ webhook: webhook.replace("open.feishu.cn", "example.test") }, "标题", "正文"), {
    message: "FEISHU_WEBHOOK_URL 格式无效",
  });
});
