import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AOYING_PORTFOLIO_ID, fetchOrders } from "../../src/binance-copy/orders.ts";
import { relayOrders } from "../../src/binance-copy/relay.ts";

test("编译入口每轮匿名查询最近两天的十条，升级不补发旧成交，失败记录离开首页后仍补发", () => {
  const dir = mkdtempSync(join(tmpdir(), "binance-copy-"));
  const main = fileURLToPath(new URL("../../dist/binance-copy/main.js", import.meta.url));
  const preload = join(dir, "mock.mjs");
  try {
    writeFileSync(preload, `
      import assert from "node:assert/strict";
      globalThis.fetch = async (input, options) => {
        const url = new URL(input);
        if (url.host === "www.binance.com") {
          assert.equal(url.pathname, "/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/order-history");
          assert.equal(options.method, "POST");
          assert.deepEqual(Object.keys(options.headers).sort(), ["Accept", "Content-Type"]);
          const body = JSON.parse(options.body);
          assert.equal(body.portfolioId, process.env.BINANCE_COPY_PORTFOLIO_ID);
          assert.equal(body.pageSize, 10);
          assert.equal(body.endTime - body.startTime, 2 * 86400000);
          console.log("QUERY");
          const list = JSON.parse(process.env.TEST_ORDERS).map((number) => ({
            symbol: "BTCUSDT", quoteAsset: "USDT", side: "BUY", positionSide: "LONG", type: "MARKET",
            executedQty: number, avgPrice: 100, totalPnl: 0,
            orderTime: 1795650989000 + number, orderUpdateTime: 1795650989000 + number,
          }));
          return Response.json({ code: "000000", success: true, data: { list } });
        }
        const prints = (name, message) => console.log(name + " " + message.match(/成交数量 (\\d+)/)[1]);
        if (url.host === "sctapi.ftqq.com") {
          prints("WECHAT", options.body.get("desp"));
          return Response.json({ code: 0 });
        }
        if (url.host === "open.feishu.cn") {
          prints("FEISHU", JSON.parse(options.body).content.text);
          return Response.json({ code: process.env.FAIL_FEISHU === "1" ? 19021 : 0 });
        }
        throw new Error("Unexpected URL");
      };
    `);
    const run = (orders: number[], { fail = false, preview = false, id = "123", channels = "" } = {}) => {
      const result = spawnSync(process.execPath, ["--import", preload, main, ...(preview ? ["--dry-run"] : [])], {
        cwd: dir, encoding: "utf8", timeout: 5000,
        env: {
          BINANCE_COPY_PORTFOLIO_ID: id, TEST_ORDERS: JSON.stringify(orders), FAIL_FEISHU: fail ? "1" : "0",
          TELEGRAM_RELAY_CHANNELS: "wechat,feishu", BINANCE_COPY_CHANNELS: channels,
          WECHAT_PUSH_ENABLED: "true", SERVERCHAN_SENDKEY: "SCTtest",
          FEISHU_WEBHOOK_URL: "https://open.feishu.cn/open-apis/bot/v2/hook/test-token",
        },
      });
      assert.equal(result.status, fail ? 1 : 0, result.error?.message ?? result.stderr);
      assert.equal(result.stdout.match(/^QUERY$/gm)?.length, 1);
      if (fail) assert.match(result.stderr, /飞书.*19021/);
      return result;
    };
    const sent = (stdout: string) => stdout.match(/^(FEISHU|WECHAT) \d+$/gm) ?? [];
    const page = (last: number, size = 10) => Array.from({ length: size }, (_, index) => last - index);
    const preview = run(page(10), { preview: true, id: AOYING_PORTFOLIO_ID });
    assert.match(preview.stdout, /熬鹰资本的最新操作 · 买入多头 BTCUSDT[\s\S]+北京时间/);
    assert.equal(preview.stdout.match(/^熬鹰资本的最新操作/gm)?.length, 10);
    assert.match(run([10], { preview: true }).stdout, /^币安合约带单 · 买入多头 BTCUSDT$/m);
    assert.deepEqual(sent(preview.stdout), []);
    assert.equal(existsSync(join(dir, ".binance-copy")), false);
    assert.deepEqual(sent(run(page(10, 5)).stdout), []);
    assert.deepEqual(sent(run(page(12), { fail: true }).stdout), ["WECHAT 11", "WECHAT 12", "FEISHU 11"]);
    const afterGap = run(page(23), { channels: "feishu" });
    assert.match(afterGap.stderr, /最新 10 条.*可能有未捕获的成交/);
    assert.deepEqual(sent(afterGap.stdout), [11, 12, ...page(23).reverse()].map((n) => "FEISHU " + n));
    assert.deepEqual(sent(run(page(23), { channels: "feishu" }).stdout), []);
    assert.deepEqual(sent(run(page(23), { id: "456" }).stdout), []);
    assert.deepEqual(sent(run(page(23)).stdout), page(23).reverse().map((n) => "WECHAT " + n));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("识别 HTTP 200 中的繁忙业务码，跨轮次遵守退避时间", async (t) => {
  const db = new DatabaseSync(":memory:");
  let now = 1795650989000;
  t.mock.method(Date, "now", () => now);
  const replies = [
    Response.json({ code: "11012005", success: false }),
    new Response(null, { status: 429, headers: { "Retry-After": "180" } }),
    Response.json({ code: "000000", success: true, data: { list: [] } }),
  ];
  const request = t.mock.method(globalThis, "fetch", async () => replies.shift());
  const check = () => relayOrders(db, [{ to: "email", deliver: async () => assert.fail("unexpected send") }],
    () => fetchOrders("123"));
  try {
    await assert.rejects(check, /11012005/);
    now += 30_000;
    assert.equal(await check(), 0);
    assert.equal(request.mock.callCount(), 1);
    now += 90_000;
    await assert.rejects(check, /HTTP 429/);
    now += 120_000;
    assert.equal(await check(), 0);
    assert.equal(request.mock.callCount(), 2);
    now += 60_000;
    assert.equal(await check(), 0);
    assert.equal(request.mock.callCount(), 3);
  } finally {
    db.close();
  }
});
