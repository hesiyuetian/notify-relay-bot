import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { configuredMailboxes, env, runMain } from "../tools/channels.ts";
import { sendEmail } from "../tools/notify.ts";
import { channelUsername, fetchPage, formatPost } from "./channel.ts";
import { forward, type Recipient } from "./forward.ts";
import { sendWeChat } from "./wechat.ts";

await runMain(async () => {
  const channel = channelUsername(env("TELEGRAM_CHANNEL"));
  const readPage = (before?: number) => fetchPage(channel, before);
  console.log(`检查 Telegram 频道 @${channel}`);
  const preview = process.argv.includes("--dry-run");
  const testEmail = process.argv.includes("--test-email");
  const testWeChat = process.argv.includes("--test-wechat");
  const sendKey = env("SERVERCHAN_SENDKEY");
  const mailboxes = configuredMailboxes();
  if (!preview && testWeChat && !sendKey) throw new Error("请配置 SERVERCHAN_SENDKEY");
  if (!preview && !mailboxes.length && (testEmail || !sendKey)) throw new Error("请配置 SMTP 邮箱和 MAIL_TO，或设置 SERVERCHAN_SENDKEY");
  if (preview || testEmail || testWeChat) {
    const { posts } = await readPage();
    const latest = posts.reduce((a, b) => a.id > b.id ? a : b);
    const mail = formatPost(latest);
    console.log(mail.text);
    if (preview) return;
    if (testWeChat && sendKey) {
      await sendWeChat(sendKey, latest, true);
      console.log(`Server酱已接受微信测试通知 #${latest.id}`);
    } else {
      for (const mailbox of mailboxes) await sendEmail(mailbox, `[测试] ${mail.subject}`, mail.html, mail.text);
    }
    return;
  }
  mkdirSync(".telegram-email", { recursive: true });
  const db = new DatabaseSync(`.telegram-email/${channel}.sqlite`);
  try {
    const recipients: Recipient[] = mailboxes.map((mailbox) => ({
      to: mailbox.to,
      deliver: async (post) => {
        const mail = formatPost(post);
        await sendEmail(mailbox, mail.subject, mail.html, mail.text);
        console.log(`邮件服务已接受帖子 #${post.id}`);
      },
    }));
    if (sendKey) recipients.push({
      to: "serverchan:wechat:service-account",
      label: "个人微信",
      deliver: async (post) => {
        await sendWeChat(sendKey, post);
        console.log(`Server酱已接受帖子 #${post.id}`);
      },
    });
    await forward(db, recipients, readPage);
  } finally {
    db.close();
  }
});
