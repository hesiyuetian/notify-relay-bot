import { escapeHtml } from "../tools/html.ts";
import type { RelayMessage } from "../tools/relay.ts";
import { AOYING_PORTFOLIO_ID, type Order } from "./orders.ts";

const sourceName = (id: string): string => (id === AOYING_PORTFOLIO_ID ? "熬鹰资本的最新操作" : "币安合约带单");

const actionLabel = (side: Order["side"], positionSide: Order["positionSide"]): string => {
  if (positionSide === "LONG") return side === "BUY" ? "买入开多" : "卖出平多";
  if (positionSide === "SHORT") return side === "SELL" ? "卖出开空" : "买入平空";
  return side === "BUY" ? "买入" : "卖出";
};

const formatNumber = (value: number): string => {
  const text = String(value);
  if (!/[eE]/.test(text)) return text;
  const fixed = value.toFixed(12).replace(/\.?0+$/, "");
  return fixed === "-0" ? "0" : fixed;
};

export const formatBeijingTime = (timestamp: number): string =>
  new Date(timestamp).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });

export const formatOrder = (id: string, order: Order): RelayMessage => {
  const action = actionLabel(order.side, order.positionSide);
  const timestamp = formatBeijingTime(order.orderUpdateTime);
  const url = `https://www.binance.com/zh-CN/copy-trading/lead-details/${id}`;
  const subject = `${sourceName(id)} · ${action} ${order.symbol}`;
  const lines = [
    `成交时间（北京时间） ${timestamp}`,
    `订单类型 ${order.type}`,
    `成交数量 ${formatNumber(order.executedQty)}`,
    `成交均价 ${formatNumber(order.avgPrice)} ${order.quoteAsset}`,
    `已实现盈亏 ${formatNumber(order.totalPnl)} ${order.quoteAsset}`,
    `带单组合 ${id}`,
  ];
  return {
    subject,
    text: [...lines, url].join("\n"),
    html: `<p>${lines.map(escapeHtml).join("<br>")}</p><p><a href="${escapeHtml(url)}">查看带单组合</a></p>`,
  };
};

export const formatHaltAlert = (id: string, reason: string, failures: number, now = Date.now()): {
  subject: string;
  text: string;
} => {
  const subject = `${sourceName(id)} · 监控已自动停止`;
  const lines = [
    `停止时间（北京时间） ${formatBeijingTime(now)}`,
    `带单组合 ${id}`,
    `最近一次错误 ${reason}`,
    `说明：连续受限（含 3 分钟、6 分钟两次退避重试，共失败 ${failures} 次），已停止后续币安请求以避免继续触发风控。`,
    "排查服务器网络或 IP 后，在服务器执行以下命令恢复监控：",
    "./deploy/run-task.sh binance-copy --resume",
  ];
  return { subject, text: lines.join("\n") };
};
