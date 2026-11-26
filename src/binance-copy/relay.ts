import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { DeliveryDeferred } from "../tools/delivery.ts";
import type { Recipient } from "../tools/relay.ts";
import { formatBeijingTime } from "./format.ts";
import { orderKey, PAGE_SIZE, type Order } from "./orders.ts";

const MINUTE = 60_000;
const RETENTION_MS = 7 * 24 * 60 * MINUTE;
// 1st rate-limit failure backs off 3m; 2nd backs off 6m; 3rd consecutive failure halts polling.
export const SOURCE_BACKOFF_MS = [3 * MINUTE, 6 * MINUTE] as const;

type SourceState = {
  retryAt: number;
  failures: number;
  halted: boolean;
  alertSent: boolean;
  reason: string;
};

export type RelayOptions = {
  onHalt?: (reason: string, failures: number) => Promise<void>;
};

const ensureSchema = (db: DatabaseSync): void => {
  db.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS orders (
      sequence INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS progress (
      recipient TEXT PRIMARY KEY, last_sequence INTEGER NOT NULL, retry_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS source_pause (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      retry_at INTEGER NOT NULL,
      failures INTEGER NOT NULL DEFAULT 0,
      halted INTEGER NOT NULL DEFAULT 0,
      alert_sent INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS source_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      baseline_updated_at INTEGER NOT NULL
    );
  `);
  // Migrate databases created before backoff counter and halt tracking existed.
  const columns = new Set(
    (db.prepare("PRAGMA table_info(source_pause)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!columns.has("failures")) db.exec("ALTER TABLE source_pause ADD COLUMN failures INTEGER NOT NULL DEFAULT 0");
  if (!columns.has("halted")) db.exec("ALTER TABLE source_pause ADD COLUMN halted INTEGER NOT NULL DEFAULT 0");
  if (!columns.has("alert_sent")) db.exec("ALTER TABLE source_pause ADD COLUMN alert_sent INTEGER NOT NULL DEFAULT 0");
  if (!columns.has("reason")) db.exec("ALTER TABLE source_pause ADD COLUMN reason TEXT NOT NULL DEFAULT ''");
};

const readSourceState = (db: DatabaseSync): SourceState => {
  const row = db.prepare(
    "SELECT retry_at, failures, halted, alert_sent, reason FROM source_pause WHERE id = 1",
  ).get() as Record<string, unknown> | undefined;
  return {
    retryAt: Number(row?.retry_at ?? 0),
    failures: Number(row?.failures ?? 0),
    halted: Number(row?.halted ?? 0) === 1,
    alertSent: Number(row?.alert_sent ?? 0) === 1,
    reason: typeof row?.reason === "string" ? row.reason : "",
  };
};

const writeSourceState = (db: DatabaseSync, state: SourceState): void => {
  db.prepare(`
    INSERT INTO source_pause (id, retry_at, failures, halted, alert_sent, reason)
    VALUES (1, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      retry_at = excluded.retry_at,
      failures = excluded.failures,
      halted = excluded.halted,
      alert_sent = excluded.alert_sent,
      reason = excluded.reason
  `).run(state.retryAt, state.failures, state.halted ? 1 : 0, state.alertSent ? 1 : 0, state.reason);
};

export const resumeSource = (db: DatabaseSync): boolean => {
  ensureSchema(db);
  return Number(db.prepare("DELETE FROM source_pause WHERE id = 1").run().changes) > 0;
};

export const relayOrders = async (
  db: DatabaseSync,
  recipients: Recipient<Order>[],
  readOrders: () => Promise<Order[]>,
  options: RelayOptions = {},
): Promise<number> => {
  ensureSchema(db);
  const lookup = db.prepare("SELECT last_sequence, retry_at FROM progress WHERE recipient = ?");
  const latest = db.prepare("SELECT COALESCE(MAX(sequence), 0) AS seq FROM orders");
  const targets = recipients.map((recipient, index) => ({
    ...recipient,
    key: createHash("sha256").update(recipient.to).digest("hex"),
    label: recipient.label ?? `邮件收件人 ${index + 1}`,
  }));
  const failures: string[] = [];

  const sourceState = readSourceState(db);
  const notifyHalt = async (reason: string, count: number): Promise<void> => {
    if (!options.onHalt) return;
    try {
      await options.onHalt(reason, count);
      db.prepare("UPDATE source_pause SET alert_sent = 1 WHERE id = 1").run();
    } catch (alertError) {
      const code = alertError instanceof Error && "code" in alertError
        ? String(alertError.code)
        : (alertError instanceof Error ? alertError.message : "告警发送失败");
      failures.push(`飞书停止告警（${code}）`);
    }
  };

  if (sourceState.halted) {
    if (!sourceState.alertSent) {
      await notifyHalt(sourceState.reason, sourceState.failures);
    }
  } else if (sourceState.retryAt <= Date.now()) {
    const requestedAt = Date.now();
    let orders: Order[] | undefined;
    let sourceError: unknown;
    try {
      orders = await readOrders();
    } catch (error) {
      sourceError = error;
    }

    if (orders) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("DELETE FROM source_pause WHERE id = 1").run();
        const metaRow = db.prepare("SELECT baseline_updated_at FROM source_meta WHERE id = 1").get();
        let baselineUpdatedAt = metaRow ? Number(metaRow.baseline_updated_at) : undefined;
        if (baselineUpdatedAt === undefined) {
          const first = db.prepare(
            "SELECT json_extract(payload, '$.orderUpdateTime') AS updated_at FROM orders WHERE sequence = 1",
          ).get();
          if (first) {
            baselineUpdatedAt = Number(first.updated_at);
            db.prepare("INSERT OR REPLACE INTO source_meta (id, baseline_updated_at) VALUES (1, ?)").run(baselineUpdatedAt);
          }
        }
        const hadBaseline = baselineUpdatedAt !== undefined;
        const firstUpdate = baselineUpdatedAt ?? 0;
        const capture = db.prepare(
          "INSERT INTO orders (fingerprint, payload) VALUES (?, ?) ON CONFLICT(fingerprint) DO NOTHING",
        );
        const sorted = [...orders].reverse().sort((a, b) => a.orderUpdateTime - b.orderUpdateTime);
        let added = 0;
        for (const order of sorted) {
          if (order.orderUpdateTime < firstUpdate) continue;
          added += Number(capture.run(orderKey(order), JSON.stringify(order)).changes);
        }
        if (!hadBaseline && sorted.length > 0) {
          db.prepare("INSERT OR REPLACE INTO source_meta (id, baseline_updated_at) VALUES (1, ?)").run(
            sorted[0]!.orderUpdateTime,
          );
        }
        if (hadBaseline && orders.length === PAGE_SIZE && added === PAGE_SIZE) {
          console.warn(`币安最新 ${PAGE_SIZE} 条记录均未见过，两次检查之间可能有未捕获的成交`);
        }
        const baseline = db.prepare("INSERT OR IGNORE INTO progress (recipient, last_sequence) VALUES (?, ?)");
        const latestSequence = Number(latest.get()!.seq);
        for (const target of targets) baseline.run(target.key, latestSequence);

        // Prune orders already delivered to every known recipient and well past the 2-day query window.
        const minSeq = db.prepare("SELECT MIN(last_sequence) AS seq FROM progress").get()?.seq;
        if (minSeq !== null && minSeq !== undefined) {
          const cutoff = Date.now() - RETENTION_MS;
          db.prepare(
            "DELETE FROM orders WHERE sequence <= ? AND json_extract(payload, '$.orderUpdateTime') < ?",
          ).run(Number(minSeq), cutoff);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } else if (sourceError !== undefined) {
      const message = sourceError instanceof Error ? sourceError.message : "币安订单接口失败";
      const requestTime = formatBeijingTime(requestedAt);
      if (sourceError instanceof DeliveryDeferred) {
        const nextFailures = sourceState.failures + 1;
        const backoffDelay = SOURCE_BACKOFF_MS[nextFailures - 1];
        if (backoffDelay !== undefined) {
          const until = Math.max(sourceError.retryAt, Date.now() + backoffDelay);
          writeSourceState(db, {
            retryAt: until,
            failures: nextFailures,
            halted: false,
            alertSent: false,
            reason: message,
          });
          console.error(
            `[币安查询失败] 请求时间（北京时间）${requestTime} | 返回结果：${message} | 第 ${nextFailures} 次受限，暂停至北京时间 ${formatBeijingTime(until)}`,
          );
        } else {
          writeSourceState(db, {
            retryAt: 0,
            failures: nextFailures,
            halted: true,
            alertSent: false,
            reason: message,
          });
          console.error(
            `[币安查询失败] 请求时间（北京时间）${requestTime} | 返回结果：${message} | 连续受限（共 ${nextFailures} 次），已停止后续请求`,
          );
          await notifyHalt(message, nextFailures);
        }
      } else {
        console.error(`[币安查询失败] 请求时间（北京时间）${requestTime} | 返回结果：${message}`);
      }
      failures.push(message);
    }
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
