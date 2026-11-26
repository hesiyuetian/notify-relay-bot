import { DeliveryDeferred } from "../tools/delivery.ts";

const ENDPOINT = "https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/order-history";
const MINUTE = 60_000;
const LOOKBACK = 2 * 24 * 60 * MINUTE;
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
  if (typeof symbol !== "string" || !symbol || typeof quoteAsset !== "string" ||
      (side !== "BUY" && side !== "SELL") ||
      (positionSide !== "LONG" && positionSide !== "SHORT" && positionSide !== "BOTH") ||
      typeof type !== "string" || !finiteNumber(executedQty) || !finiteNumber(avgPrice) ||
      !finiteNumber(totalPnl) || !timestamp(orderTime) || !timestamp(orderUpdateTime)) {
    throw new Error("币安订单记录格式异常");
  }
  return { symbol, quoteAsset, side, positionSide, type, executedQty, avgPrice, totalPnl, orderTime, orderUpdateTime };
};

const retryAt = (header: string | null, fallback: number): number => {
  const now = Date.now();
  if (!header) return now + fallback;
  const time = /^\d+$/.test(header) ? now + Number(header) * 1000 : Date.parse(header);
  return time > now && Number.isSafeInteger(time) ? time : now + fallback;
};

export const fetchOrders = async (id: string): Promise<Order[]> => {
  const endTime = Date.now();
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ portfolioId: id, startTime: endTime - LOOKBACK, endTime, pageSize: PAGE_SIZE }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  }).catch(() => { throw new Error("币安订单接口连接失败或超时"); });

  const retryAfter = response.headers.get("Retry-After");
  if (!response.ok) {
    const code = `币安订单接口 HTTP ${response.status}`;
    if (response.status === 403 || response.status === 418) {
      throw new DeliveryDeferred(code, retryAt(retryAfter, 60 * MINUTE));
    }
    if (response.status === 429 || retryAfter) {
      throw new DeliveryDeferred(code, retryAt(retryAfter, 2 * MINUTE));
    }
    throw new Error(code);
  }

  const body = await response.json().catch(() => null) as {
    code?: unknown; success?: unknown; data?: { list?: unknown };
  } | null;
  if (!body || !/^\d+$/.test(String(body.code))) throw new Error("币安订单接口响应格式异常");
  const code = String(body.code);
  if (code === "11012005") throw new DeliveryDeferred(`币安订单接口繁忙（${code}）`, retryAt(retryAfter, 2 * MINUTE));
  if (code !== "000000" || body.success !== true) throw new Error(`币安订单接口失败（${code}）`);
  if (!Array.isArray(body.data?.list)) throw new Error("币安订单列表格式异常");
  return body.data.list.slice(0, PAGE_SIZE).map(parseOrder);
};

// The public response has no order ID. Exclude the mutable update time from the record fingerprint.
export const orderKey = (order: Order): string => JSON.stringify([
  order.orderTime, order.symbol, order.side, order.positionSide, order.type,
  order.executedQty, order.avgPrice, order.totalPnl,
]);
