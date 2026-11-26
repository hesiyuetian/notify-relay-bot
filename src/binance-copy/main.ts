import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { configuredFeishu, env, runMain } from "../tools/channels.ts";
import { sendFeishu } from "../tools/feishu.ts";
import { relayRecipients } from "../tools/relay.ts";
import { formatHaltAlert, formatOrder } from "./format.ts";
import { fetchOrders, portfolioId, type Order } from "./orders.ts";
import { relayOrders, resumeSource } from "./relay.ts";

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

  mkdirSync(".binance-copy", { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(`.binance-copy/${id}.sqlite`);
  try {
    if (process.argv.includes("--resume")) {
      const cleared = resumeSource(db);
      console.log(
        cleared
          ? `币安带单组合 ${id} 已解除暂停/停止状态，下次轮询将恢复请求`
          : `币安带单组合 ${id} 当前未处于暂停或停止状态`,
      );
      return;
    }

    const recipients = relayRecipients("binance-copy", format);
    const sent = await relayOrders(db, recipients, () => fetchOrders(id), {
      onHalt: async (reason, failures) => {
        const feishu = configuredFeishu();
        if (!feishu) {
          console.warn("⚠️ 未配置 FEISHU_WEBHOOK_URL，无法发送币安监控停止通知到飞书");
          return;
        }
        const { subject, text } = formatHaltAlert(id, reason, failures);
        await sendFeishu(feishu, subject, text);
        console.warn(`⚠️ 已发送币安监控停止通知到飞书（组合 ${id}）`);
      },
    });
    if (sent) console.log(`币安带单组合 ${id} 已投递 ${sent} 条通知（按接收端计）`);
  } finally {
    db.close();
  }
});
