import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { since, type Page, type Post } from "./channel.ts";

export class DeliveryDeferred extends Error {
  readonly code: string;
  readonly retryAt: number;
  constructor(code: string, retryAt: number) {
    super(code);
    this.code = code;
    this.retryAt = retryAt;
  }
}

export type Recipient = { to: string; label?: string; deliver: (post: Post) => Promise<void> };

export const forward = async (
  db: DatabaseSync,
  recipients: Recipient[],
  readPage: (before?: number) => Promise<Page>,
): Promise<void> => {
  db.exec("CREATE TABLE IF NOT EXISTS progress (recipient TEXT PRIMARY KEY, last_id INTEGER NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS delivery_pause (recipient TEXT PRIMARY KEY, retry_at INTEGER NOT NULL)");
  const pause = db.prepare("INSERT OR REPLACE INTO delivery_pause VALUES (?, ?)");
  const paused = db.prepare("SELECT retry_at FROM delivery_pause WHERE recipient = ?");
  const lookup = db.prepare("SELECT last_id FROM progress WHERE recipient = ?");
  const insert = db.prepare("INSERT OR IGNORE INTO progress (recipient, last_id) VALUES (?, ?)");
  const advance = db.prepare("UPDATE progress SET last_id = ? WHERE recipient = ?");
  const first = await readPage();
  const latest = Math.max(...first.posts.map((post) => post.id));
  const failures: string[] = [];
  const history = new Map<number, Promise<Page>>();
  const readHistory = (before?: number) => {
    if (before === undefined) return Promise.resolve(first);
    const cached = history.get(before) ?? readPage(before);
    history.set(before, cached);
    return cached;
  };
  for (const [index, target] of recipients.entries()) {
    const key = createHash("sha256").update(target.to).digest("hex");
    const label = target.label ?? `收件人 ${index + 1}`;
    if (Number(paused.get(key)?.retry_at ?? 0) > Date.now()) continue;
    const { changes } = insert.run(key, latest);
    if (changes) console.log(`${label} 已从 #${latest} 开始订阅新帖`);
    const cursor = Number(lookup.get(key)!.last_id);
    if (cursor >= latest) continue;
    let posts: Post[];
    try {
      posts = await since(first, cursor, readHistory);
    } catch {
      failures.push(`${label} 无法回溯到消息 #${cursor}，保留发送进度`);
      continue;
    }
    for (const post of posts) {
      // Recheck under a SQLite write lock so overlapping local polls cannot both send the same post.
      db.exec("BEGIN IMMEDIATE");
      try {
        if (Number(lookup.get(key)!.last_id) < post.id) {
          await target.deliver(post);
          advance.run(post.id, key);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        if (error instanceof DeliveryDeferred) pause.run(key, error.retryAt);
        // SMTP error messages may contain the full address. Keep logs scoped to the recipient number.
        const code = error instanceof Error && "code" in error ? String(error.code) : "发送失败";
        failures.push(`${label}，帖子 #${post.id}（${code}）`);
        break;
      }
    }
  }
  if (failures.length) throw new Error(failures.join("、"));
};
