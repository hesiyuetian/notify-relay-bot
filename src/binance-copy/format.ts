import { escapeHtml } from "../tools/html.ts";
import type { RelayMessage } from "../tools/relay.ts";
import { AOYING_PORTFOLIO_ID, type Order } from "./orders.ts";

export const formatOrder = (id: string, order: Order): RelayMessage => {
  const side = order.side === "BUY" ? "买入" : "卖出";
  const position = { LONG: "多头", SHORT: "空头", BOTH: "单向" }[order.positionSide];
  const action = order.positionSide === "BOTH" ? side : `${side}${position}`;
  const timestamp = new Date(order.orderUpdateTime).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
  const url = `https://www.binance.com/zh-CN/copy-trading/lead-details/${id}`;
  const source = id === AOYING_PORTFOLIO_ID ? "熬鹰资本的最新操作" : "币安合约带单";
  const subject = `${source} · ${action} ${order.symbol}`;
  const lines = [
    `成交时间（北京时间） ${timestamp}`,
    `订单类型 ${order.type}`,
    `成交数量 ${order.executedQty}`,
    `成交均价 ${order.avgPrice} ${order.quoteAsset}`,
    `已实现盈亏 ${order.totalPnl} ${order.quoteAsset}`,
    `带单组合 ${id}`,
  ];
  return {
    subject,
    text: [...lines, url].join("\n"),
    html: `<p>${lines.map(escapeHtml).join("<br>")}</p><p><a href="${escapeHtml(url)}">查看带单组合</a></p>`,
  };
};
