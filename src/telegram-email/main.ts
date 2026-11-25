import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { configuredMailboxes, runMain } from "../tools/channels.ts";
import { sendEmail } from "../tools/notify.ts";
import { fetchPage, formatPost } from "./channel.ts";
import { forward } from "./forward.ts";

await runMain(async () => {
  const preview = process.argv.includes("--dry-run");
  const testEmail = process.argv.includes("--test-email");
  const mailboxes = configuredMailboxes();
  if (!preview && !mailboxes.length) throw new Error("请配置 SMTP_HOST、SMTP_USER、SMTP_PASS 和 MAIL_TO");
  if (preview || testEmail) {
    const { posts } = await fetchPage();
    const latest = posts.reduce((a, b) => a.id > b.id ? a : b);
    const mail = formatPost(latest);
    console.log(mail.text);
    if (!preview) {
      for (const mailbox of mailboxes) await sendEmail(mailbox, `[测试] ${mail.subject}`, mail.html, mail.text);
    }
    return;
  }
  mkdirSync(".telegram-email", { recursive: true });
  const db = new DatabaseSync(".telegram-email/aoying999.sqlite");
  try {
    await forward(db, mailboxes.map((mailbox) => ({
      to: mailbox.to,
      deliver: async (post) => {
        const mail = formatPost(post);
        await sendEmail(mailbox, mail.subject, mail.html, mail.text);
        console.log(`邮件服务已接受帖子 #${post.id}`);
      },
    })), fetchPage);
  } finally {
    db.close();
  }
});
