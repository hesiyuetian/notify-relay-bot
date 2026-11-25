import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { configuredFeishu, configuredMailboxes, configuredWeChatKey, env, runMain } from "../tools/channels.ts";
import { sendFeishu } from "../tools/feishu.ts";
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
  const testFeishu = process.argv.includes("--test-feishu");
  const sendKey = configuredWeChatKey();
  const mailboxes = configuredMailboxes();
  const feishu = configuredFeishu();
  if (!preview && testFeishu && !feishu) throw new Error("请配置 FEISHU_WEBHOOK_URL");
  if (!preview && testWeChat && !sendKey) throw new Error("个人微信推送已暂停或未配置 SERVERCHAN_SENDKEY");
  if (!preview && testEmail && !mailboxes.length) throw new Error("请配置 SMTP 邮箱和 MAIL_TO");
  if (!preview && !mailboxes.length && !sendKey && !feishu) {
    throw new Error("请配置 SMTP 邮箱和 MAIL_TO、SERVERCHAN_SENDKEY 或 FEISHU_WEBHOOK_URL");
  }
  if (preview || testEmail || testWeChat || testFeishu) {
    const { posts } = await readPage();
    const latest = posts.reduce((a, b) => a.id > b.id ? a : b);
    const mail = formatPost(latest);
    console.log(mail.text);
    if (preview) return;
    if (testFeishu && feishu) {
      await sendFeishu(feishu, `[测试] ${mail.subject}`, mail.text);
      console.log(`飞书已接受测试通知 #${latest.id}`);
    } else if (testWeChat && sendKey) {
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
      },
    }));
    if (sendKey) recipients.push({
      to: "serverchan:wechat:service-account",
      label: "个人微信",
      deliver: (post) => sendWeChat(sendKey, post),
    });
    if (feishu) recipients.push({
      to: `feishu:${feishu.webhook}`,
      label: "飞书",
      deliver: async (post) => {
        const mail = formatPost(post);
        await sendFeishu(feishu, mail.subject, mail.text);
      },
    });
    await forward(db, recipients, readPage);
  } finally {
    db.close();
  }
});
