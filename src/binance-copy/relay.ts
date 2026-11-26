import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { DeliveryDeferred } from "../tools/delivery.ts";
import type { Recipient } from "../tools/relay.ts";
import { orderKey, PAGE_SIZE, type Order } from "./orders.ts";

export const relayOrders = async (
  db: DatabaseSync,
  recipients: Recipient<Order>[],
  readOrders: () => Promise<Order[]>,
): Promise<number> => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      sequence INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS progress (
      recipient TEXT PRIMARY KEY, last_sequence INTEGER NOT NULL, retry_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS source_pause (
      id INTEGER PRIMARY KEY CHECK (id = 1), retry_at INTEGER NOT NULL
    );
  `);
  const lookup = db.prepare("SELECT last_sequence, retry_at FROM progress WHERE recipient = ?");
  const latest = db.prepare("SELECT COALESCE(MAX(sequence), 0) AS seq FROM orders");
  const targets = recipients.map((recipient, index) => ({
    ...recipient,
    key: createHash("sha256").update(recipient.to).digest("hex"),
    label: recipient.label ?? `邮件收件人 ${index + 1}`,
  }));
  const failures: string[] = [];

  db.exec("BEGIN IMMEDIATE");
  try {
    const sourcePause = Number(db.prepare("SELECT retry_at FROM source_pause WHERE id = 1").get()?.retry_at ?? 0);
    let orders: Order[] | undefined;
    if (sourcePause <= Date.now()) {
      try {
        orders = await readOrders();
      } catch (error) {
        if (error instanceof DeliveryDeferred) {
          db.prepare("INSERT OR REPLACE INTO source_pause VALUES (1, ?)").run(error.retryAt);
        }
        failures.push(error instanceof Error ? error.message : "币安订单接口失败");
      }
    }
    if (orders) {
      // A larger page may expose older records than the initial baseline contained.
      const first = db.prepare("SELECT json_extract(payload, '$.orderUpdateTime') AS updated_at FROM orders WHERE sequence = 1").get();
      const firstUpdate = Number(first?.updated_at ?? 0);
      const capture = db.prepare("INSERT INTO orders (fingerprint, payload) VALUES (?, ?) ON CONFLICT(fingerprint) DO NOTHING");
      let added = 0;
      for (const order of [...orders].reverse().sort((a, b) => a.orderUpdateTime - b.orderUpdateTime)) {
        if (order.orderUpdateTime < firstUpdate) continue;
        added += Number(capture.run(orderKey(order), JSON.stringify(order)).changes);
      }
      if (first && orders.length === PAGE_SIZE && added === PAGE_SIZE) {
        console.warn(`币安最新 ${PAGE_SIZE} 条记录均未见过，两次检查之间可能有未捕获的成交`);
      }
      const baseline = db.prepare("INSERT OR IGNORE INTO progress (recipient, last_sequence) VALUES (?, ?)");
      const latestSequence = Number(latest.get()!.seq);
      for (const target of targets) baseline.run(target.key, latestSequence);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const pending = db.prepare("SELECT sequence, payload FROM orders WHERE sequence > ? ORDER BY sequence");
  const advance = db.prepare("UPDATE progress SET last_sequence = ?, retry_at = 0 WHERE recipient = ?");
  const pause = db.prepare("UPDATE progress SET retry_at = ? WHERE recipient = ?");
  let sent = 0;
  for (const target of targets) {
    const progress = lookup.get(target.key);
    if (!progress || Number(progress.retry_at) > Date.now()) continue;
    for (const row of pending.all(Number(progress.last_sequence))) {
      const sequence = Number(row.sequence);
      const order = JSON.parse(String(row.payload)) as Order;
      // Recheck under a write lock so concurrent invocations cannot send the same item.
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = lookup.get(target.key)!;
        if (Number(current.retry_at) > Date.now()) {
          db.exec("COMMIT");
          break;
        }
        if (Number(current.last_sequence) < sequence) {
          await target.deliver(order);
          advance.run(sequence, target.key);
          sent++;
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        if (error instanceof DeliveryDeferred) pause.run(error.retryAt, target.key);
        const code = error instanceof Error && "code" in error ? String(error.code) : "发送失败";
        failures.push(`${target.label}，币安订单记录 #${sequence}（${code}）`);
        break;
      }
    }
  }
  if (failures.length) throw new Error(failures.join("、"));
  return sent;
};
