import { STATUS_CODES } from "node:http";
import { DeliveryDeferred } from "../tools/delivery.ts";

const ENDPOINT = "https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/order-history";
const MINUTE = 60_000;
const LOOKBACK = 2 * 24 * 60 * MINUTE;
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_BACKOFF_MS = 3 * MINUTE;
const MAX_RETRY_AFTER_MS = 24 * 60 * MINUTE;
const HTTP_FAILURE_REASONS: Partial<Record<number, string>> = {
  403: "访问被拒绝",
  418: "请求受限",
  429: "请求频率超限",
  451: "因法律原因不可用",
};
const DEFERRED_HTTP_STATUSES = new Set([403, 418, 429, 451]);
export const PAGE_SIZE = 10;
export const AOYING_PORTFOLIO_ID = "5075281354358777856";

export type Order = {
  symbol: string;
  quoteAsset: string;
  side: "BUY" | "SELL";
  positionSide: "LONG" | "SHORT" | "BOTH";
  type: string;
  executedQty: number;
  avgPrice: number;
  totalPnl: number;
  orderTime: number;
  orderUpdateTime: number;
};

type OrderHistoryResponse = {
  code?: unknown;
  success?: unknown;
  data?: { list?: unknown };
};

export const portfolioId = (value = AOYING_PORTFOLIO_ID): string => {
  if (!/^\d{1,24}$/.test(value)) throw new Error("BINANCE_COPY_PORTFOLIO_ID 必须是数字组成的带单组合 ID");
  return value;
};

const finiteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const timestamp = (value: unknown): value is number =>
  finiteNumber(value) && Number.isSafeInteger(value) && value > 0 && value <= 8.64e15;

const parseOrder = (value: unknown): Order => {
  if (!value || typeof value !== "object") throw new Error("币安订单记录格式异常");
  const order = value as Record<string, unknown>;
  const { symbol, quoteAsset, side, positionSide, type, executedQty, avgPrice, totalPnl, orderTime, orderUpdateTime } = order;
  if (typeof symbol !== "string" || !symbol || typeof quoteAsset !== "string" || !quoteAsset ||
    (side !== "BUY" && side !== "SELL") ||
    (positionSide !== "LONG" && positionSide !== "SHORT" && positionSide !== "BOTH") ||
    typeof type !== "string" || !type || !finiteNumber(executedQty) || !finiteNumber(avgPrice) ||
    !finiteNumber(totalPnl) || !timestamp(orderTime) || !timestamp(orderUpdateTime)) {
    throw new Error("币安订单记录格式异常");
  }
  return { symbol, quoteAsset, side, positionSide, type, executedQty, avgPrice, totalPnl, orderTime, orderUpdateTime };
};

const retryAt = (header: string | null, fallback: number): number => {
  const now = Date.now();
  const trimmed = header?.trim();
  if (!trimmed) return now + fallback;
  const time = /^\d+$/.test(trimmed) ? now + Number(trimmed) * 1000 : Date.parse(trimmed);
  if (!Number.isSafeInteger(time) || time <= now) return now + fallback;
  return Math.min(time, now + MAX_RETRY_AFTER_MS);
};

const networkReason = (error: unknown, signal: AbortSignal): string => {
  if (signal.aborted || (error instanceof Error && error.name === "TimeoutError")) {
    return `请求超时（${REQUEST_TIMEOUT_MS / 1000} 秒）`;
  }
  const cause: unknown = error instanceof Error ? error.cause ?? error : error;
  if (cause instanceof Error && cause.message === "unexpected redirect") return "接口返回了重定向";
  // Socket error messages can include local addresses. Keep only the Node error code.
  const code = cause instanceof Error && "code" in cause ? cause.code : undefined;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,47}$/.test(code)
    ? `网络连接失败（${code}）`
    : "网络连接失败";
};

const businessCode = (body: OrderHistoryResponse | null): string | undefined => {
  const code = typeof body?.code === "string" || typeof body?.code === "number" ? String(body.code) : "";
  return /^-?\d{1,12}$/.test(code) ? code : undefined;
};

export const fetchOrders = async (id: string): Promise<Order[]> => {
  const endTime = Date.now();
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ portfolioId: id, startTime: endTime - LOOKBACK, endTime, pageSize: PAGE_SIZE }),
    redirect: "error",
    signal,
  }).catch((error: unknown) => {
    throw new Error(`币安订单接口 ${networkReason(error, signal)}`);
  });

  const retryAfter = response.headers.get("Retry-After");
  if (!response.ok) {
    const reason = HTTP_FAILURE_REASONS[response.status] ?? STATUS_CODES[response.status] ?? "请求被拒绝";
    const contentType = response.headers.get("Content-Type") ?? "";
    const body = /(?:^application\/json\b|\+json\b)/i.test(contentType)
      ? await response.json().catch(() => null) as OrderHistoryResponse | null
      : null;
    const business = businessCode(body);
    const code = `币安订单接口 HTTP ${response.status}（${reason}）${business ? `，业务码 ${business}` : ""}`;
    if (DEFERRED_HTTP_STATUSES.has(response.status) || retryAfter) {
      throw new DeliveryDeferred(code, retryAt(retryAfter, DEFAULT_BACKOFF_MS));
    }
    throw new Error(code);
  }

  const body = await response.json().catch((error: unknown) => {
    const reason = error instanceof SyntaxError ? "响应不是有效 JSON" : networkReason(error, signal);
    throw new Error(`币安订单接口 HTTP ${response.status}，${reason}`);
  }) as OrderHistoryResponse | null;
  const code = businessCode(body);
  if (!code) {
    throw new Error(`币安订单接口 HTTP ${response.status}，响应缺少有效业务码`);
  }
  const result = `币安订单接口 HTTP ${response.status}，业务码 ${code}`;
  if (code === "11012005") throw new DeliveryDeferred(`${result}（系统繁忙）`, retryAt(retryAfter, DEFAULT_BACKOFF_MS));
  if (code !== "000000" || body?.success !== true) throw new Error(`${result}（业务请求失败）`);
  if (!Array.isArray(body.data?.list)) throw new Error(`${result}，响应缺少订单列表`);
  return body.data.list.slice(0, PAGE_SIZE).map(parseOrder);
};

// The public response has no order ID. Exclude the mutable update time from the record fingerprint.
export const orderKey = (order: Order): string => JSON.stringify([
  order.orderTime, order.symbol, order.side, order.positionSide, order.type,
  order.executedQty, order.avgPrice, order.totalPnl,
]);
