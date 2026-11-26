import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { formatOrder } from "../../src/binance-copy/format.ts";
import { AOYING_PORTFOLIO_ID, fetchOrders, type Order } from "../../src/binance-copy/orders.ts";
import { relayOrders, resumeSource } from "../../src/binance-copy/relay.ts";

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
    assert.match(preview.stdout, /熬鹰资本的最新操作 · 买入开多 BTCUSDT[\s\S]+北京时间/);
    assert.equal(preview.stdout.match(/^熬鹰资本的最新操作/gm)?.length, 10);
    assert.match(run([10], { preview: true }).stdout, /^币安合约带单 · 买入开多 BTCUSDT$/m);
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

test("格式化正确区分双向持仓开平方向，且避免极小价格科学计数法", () => {
  const base: Order = {
    symbol: "PEPEUSDT", quoteAsset: "USDT", side: "BUY", positionSide: "LONG", type: "MARKET",
    executedQty: 1000, avgPrice: 0.00000012, totalPnl: 0,
    orderTime: 1795650989000, orderUpdateTime: 1795650989000,
  };
  assert.match(formatOrder("123", { ...base, side: "BUY", positionSide: "LONG" }).subject, /买入开多 PEPEUSDT$/);
  assert.match(formatOrder("123", { ...base, side: "SELL", positionSide: "LONG" }).subject, /卖出平多 PEPEUSDT$/);
  assert.match(formatOrder("123", { ...base, side: "SELL", positionSide: "SHORT" }).subject, /卖出开空 PEPEUSDT$/);
  assert.match(formatOrder("123", { ...base, side: "BUY", positionSide: "SHORT" }).subject, /买入平空 PEPEUSDT$/);
  assert.match(formatOrder("123", { ...base, side: "BUY", positionSide: "BOTH" }).subject, /· 买入 PEPEUSDT$/);
  assert.match(formatOrder("123", base).text, /成交均价 0\.00000012 USDT/);
});

test("查询失败报告超时、网络错误、HTTP 状态和业务码，不暴露原始错误文本", async (t) => {
  const privateText = "private@example.test";
  const cause = Object.assign(new Error(`getaddrinfo ENOTFOUND ${privateText}`), { code: "ENOTFOUND" });
  const replies = [
    new Error("fetch failed", { cause }),
    new DOMException(privateText, "TimeoutError"),
    new Response(privateText, { status: 403, statusText: privateText }),
    new Response(privateText, { status: 451, statusText: privateText }),
    Response.json({ code: 12345, message: privateText }, { status: 400 }),
    new Response(privateText, { status: 200 }),
    Response.json({ code: "-1003", success: false, message: privateText }),
  ];
  t.mock.method(globalThis, "fetch", async () => {
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return reply;
  });
  for (const message of [
    "币安订单接口 网络连接失败（ENOTFOUND）",
    "币安订单接口 请求超时（15 秒）",
    "币安订单接口 HTTP 403（访问被拒绝）",
    "币安订单接口 HTTP 451（因法律原因不可用）",
    "币安订单接口 HTTP 400（Bad Request），业务码 12345",
    "币安订单接口 HTTP 200，响应不是有效 JSON",
    "币安订单接口 HTTP 200，业务码 -1003（业务请求失败）",
  ]) {
    await assert.rejects(() => fetchOrders("123"), { message });
  }
});

test("受限时第一次退避 3 分钟、第二次退避 6 分钟，连续失败后停止请求并通知飞书，支持 --resume 恢复", async (t) => {
  const db = new DatabaseSync(":memory:");
  let now = 1795650989000;
  t.mock.method(Date, "now", () => now);
  const errorLogs: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => {
    errorLogs.push(args.map(String).join(" "));
  });
  const replies = [
    new Response(null, { status: 429 }),
    new Response(null, { status: 403 }),
    new Response(null, { status: 451 }),
    Response.json({ code: "000000", success: true, data: { list: [] } }),
  ];
  const request = t.mock.method(globalThis, "fetch", async () => replies.shift());
  const alerts: Array<{ reason: string; failures: number }> = [];
  const check = () => relayOrders(
    db,
    [{ to: "email", deliver: async () => assert.fail("unexpected send") }],
    () => fetchOrders("123"),
    { onHalt: async (reason, failures) => { alerts.push({ reason, failures }); } },
  );
  try {
    // 1st failure (429): back off 3 minutes and log request time + result.
    await assert.rejects(check, /HTTP 429/);
    assert.equal(request.mock.callCount(), 1);
    assert.match(errorLogs.at(-1) ?? "", /\[币安查询失败\] 请求时间（北京时间）.*\| 返回结果：币安订单接口 HTTP 429/);
    now += 2 * 60_000;
    assert.equal(await check(), 0);
    assert.equal(request.mock.callCount(), 1);

    // After 3 minutes total, 2nd failure (403): back off 6 minutes.
    now += 60_000;
    await assert.rejects(check, /HTTP 403/);
    assert.equal(request.mock.callCount(), 2);
    assert.equal(alerts.length, 0);
    assert.match(errorLogs.at(-1) ?? "", /第 2 次受限/);
    now += 5 * 60_000;
    assert.equal(await check(), 0);
    assert.equal(request.mock.callCount(), 2);

    // After 6 minutes total, 3rd consecutive failure (451): halt polling and notify Feishu once.
    now += 60_000;
    await assert.rejects(check, /HTTP 451/);
    assert.equal(request.mock.callCount(), 3);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0]!.reason, /HTTP 451/);
    assert.equal(alerts[0]!.failures, 3);
    assert.match(errorLogs.at(-1) ?? "", /已停止后续请求/);

    // Subsequent polls never call Binance or send duplicate alerts even hours later.
    now += 24 * 60 * 60_000;
    assert.equal(await check(), 0);
    assert.equal(request.mock.callCount(), 3);
    assert.equal(alerts.length, 1);

    // Resuming clears the halt and allows requests again.
    assert.equal(resumeSource(db), true);
    assert.equal(resumeSource(db), false);
    assert.equal(await check(), 0);
    assert.equal(request.mock.callCount(), 4);
  } finally {
    db.close();
  }
});

test("停止告警发送失败时仍停止请求币安，下次轮询自动补发飞书告警，且 --resume 命令行可用", () => {
  const dir = mkdtempSync(join(tmpdir(), "binance-halt-"));
  const main = fileURLToPath(new URL("../../dist/binance-copy/main.js", import.meta.url));
  const preload = join(dir, "mock.mjs");
  try {
    writeFileSync(preload, `
      globalThis.fetch = async (input, options) => {
        const url = new URL(input);
        if (url.host === "www.binance.com") {
          console.log("BINANCE_CALL");
          return new Response(null, { status: 429 });
        }
        if (url.host === "open.feishu.cn") {
          const text = JSON.parse(options.body).content.text;
          console.log("FEISHU_ALERT " + text.split("\\n")[0]);
          if (process.env.FAIL_ALERT === "1") return Response.json({ code: 99999 });
          return Response.json({ code: 0 });
        }
        throw new Error("Unexpected URL");
      };
    `);
    const dbPath = join(dir, ".binance-copy/123.sqlite");
    const run = (args: string[] = [], failAlert = false) => spawnSync(
      process.execPath,
      ["--import", preload, main, ...args],
      {
        cwd: dir, encoding: "utf8", timeout: 5000,
        env: {
          BINANCE_COPY_PORTFOLIO_ID: "123",
          BINANCE_COPY_CHANNELS: "feishu",
          FEISHU_WEBHOOK_URL: "https://open.feishu.cn/open-apis/bot/v2/hook/test-token",
          FAIL_ALERT: failAlert ? "1" : "0",
        },
      },
    );

    // Seed 2 consecutive failures with expired retry_at so next run triggers halt.
    const first = run();
    assert.equal(first.status, 1);
    assert.match(first.stdout, /BINANCE_CALL/);
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE source_pause SET retry_at = 0, failures = 2 WHERE id = 1").run();
    db.close();

    // 3rd failure halts; Feishu alert fails transiently.
    const halted = run([], true);
    assert.equal(halted.status, 1);
    assert.match(halted.stdout, /BINANCE_CALL/);
    assert.match(halted.stdout, /FEISHU_ALERT .*监控已自动停止/);

    // Next run does NOT call Binance, retries Feishu alert and succeeds.
    const retryAlert = run([], false);
    assert.equal(retryAlert.status, 0, retryAlert.stderr);
    assert.doesNotMatch(retryAlert.stdout, /BINANCE_CALL/);
    assert.match(retryAlert.stdout, /FEISHU_ALERT .*监控已自动停止/);

    // Following run neither calls Binance nor sends alert again.
    const idle = run([], false);
    assert.equal(idle.status, 0, idle.stderr);
    assert.doesNotMatch(idle.stdout, /BINANCE_CALL/);
    assert.doesNotMatch(idle.stdout, /FEISHU_ALERT/);

    // --resume clears halt state so Binance is queried again.
    const resumed = run(["--resume"]);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(resumed.stdout, /已解除暂停\/停止状态/);
    const afterResume = run();
    assert.equal(afterResume.status, 1);
    assert.match(afterResume.stdout, /BINANCE_CALL/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
