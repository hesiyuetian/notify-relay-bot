import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { env, runMain } from "../tools/channels.ts";
import { relayRecipients } from "../tools/relay.ts";
import { formatOrder } from "./format.ts";
import { fetchOrders, portfolioId, type Order } from "./orders.ts";
import { relayOrders } from "./relay.ts";

await runMain(async () => {
  const id = portfolioId(env("BINANCE_COPY_PORTFOLIO_ID"));
  const format = (order: Order) => formatOrder(id, order);

  if (process.argv.includes("--dry-run")) {
    const orders = await fetchOrders(id);
    if (!orders.length) console.log(`币安带单组合 ${id} 暂无成交记录`);
    for (const order of orders) {
      const { subject, text } = format(order);
      console.log(`${subject}\n${text}\n`);
    }
    return;
  }

  const recipients = relayRecipients("binance-copy", format);
  mkdirSync(".binance-copy", { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(`.binance-copy/${id}.sqlite`);
  try {
    const sent = await relayOrders(db, recipients, () => fetchOrders(id));
    if (sent) console.log(`币安带单组合 ${id} 已投递 ${sent} 条通知（按接收端计）`);
  } finally {
    db.close();
  }
});
