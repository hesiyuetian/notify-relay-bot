import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { since, type Page, type Post } from "./channel.ts";

type Recipient = { to: string; deliver: (post: Post) => Promise<void> };

export const forward = async (
  db: DatabaseSync,
  recipients: Recipient[],
  readPage: (before?: number) => Promise<Page>,
): Promise<void> => {
  db.exec("CREATE TABLE IF NOT EXISTS progress (recipient TEXT PRIMARY KEY, last_id INTEGER NOT NULL)");
  const lookup = db.prepare("SELECT last_id FROM progress WHERE recipient = ?");
  const insert = db.prepare("INSERT OR IGNORE INTO progress (recipient, last_id) VALUES (?, ?)");
  const advance = db.prepare("UPDATE progress SET last_id = ? WHERE recipient = ?");
  const first = await readPage();
  const latest = Math.max(...first.posts.map((post) => post.id));
  const targets = recipients.map(({ to, deliver }) => {
    const key = createHash("sha256").update(to).digest("hex");
    const { changes } = insert.run(key, latest);
    if (changes) console.log(`已从 #${latest} 开始订阅新帖`);
    return { key, deliver, cursor: Number(lookup.get(key)!.last_id) };
  });
  const oldest = Math.min(...targets.map((target) => target.cursor));
  if (oldest >= latest) return;
  const posts = await since(first, oldest, readPage);
  const failures: string[] = [];
  for (const [index, target] of targets.entries()) {
    for (const post of posts) {
      if (post.id <= target.cursor) continue;
      // Recheck under a SQLite write lock so overlapping local polls cannot both send the same post.
      db.exec("BEGIN IMMEDIATE");
      try {
        if (Number(lookup.get(target.key)!.last_id) < post.id) {
          await target.deliver(post);
          advance.run(post.id, target.key);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        // SMTP error messages may contain the full address. Keep logs scoped to the recipient number.
        const code = error instanceof Error && "code" in error ? String(error.code) : "发送失败";
        failures.push(`收件人 ${index + 1}，帖子 #${post.id}（${code}）`);
        break;
      }
    }
  }
  if (failures.length) throw new Error(failures.join("、"));
};
