import { describeError } from "./async.ts";
import { type FeishuConfig, sendFeishu } from "./feishu.ts";
import { splitList } from "./list.ts";
import { type MailConfig, sendEmail, sendTelegram } from "./notify.ts";

const DEFAULT_SMTP_PORT = 465;

export const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;

export const configuredWeChatKey = (): string | undefined =>
  env("WECHAT_PUSH_ENABLED")?.toLowerCase() === "true" ? env("SERVERCHAN_SENDKEY") : undefined;

export type Message = {
  readonly subject: string;
  readonly telegram: string;
  readonly email: string;
  readonly text: string;
};

type Channel = {
  readonly name: string;
  readonly send: () => Promise<void>;
};

const runChannel = async (channel: Channel): Promise<void> => {
  try {
    await channel.send();
  } catch (error: unknown) {
    throw new Error(`${channel.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(`✅ ${channel.name} 已推送`);
};

/** Names a recipient by position only, so chat IDs and addresses never show up in Actions logs. */
const recipientName = (channel: string, index: number, total: number): string =>
  total > 1 ? `${channel} (${index + 1}/${total})` : channel;

export const configuredMailboxes = (): MailConfig[] => {
  const host = env("SMTP_HOST");
  const user = env("SMTP_USER");
  const pass = env("SMTP_PASS");
  const recipients = splitList(env("MAIL_TO"));
  if (!host || !user || !pass) return [];
  const port = Number(env("SMTP_PORT") ?? DEFAULT_SMTP_PORT);
  return recipients.map((to) => ({ host, port, user, pass, to }));
};

export const configuredFeishu = (): FeishuConfig | undefined => {
  const webhook = env("FEISHU_WEBHOOK_URL");
  return webhook ? { webhook, secret: env("FEISHU_WEBHOOK_SECRET") } : undefined;
};

const buildChannels = (message: Message): Channel[] => {
  const channels: Channel[] = [];

  const tgToken = env("TELEGRAM_BOT_TOKEN");
  const chatIds = splitList(env("TELEGRAM_CHAT_ID"));
  if (tgToken && chatIds.length > 0) {
    channels.push(
      ...chatIds.map((chatId, index) => ({
        name: recipientName("Telegram", index, chatIds.length),
        send: () => sendTelegram(tgToken, chatId, message.telegram),
      })),
    );
  } else {
    console.warn("⚠️ 未配置 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID，跳过 Telegram");
  }

  const mailboxes = configuredMailboxes();
  if (mailboxes.length > 0) {
    channels.push(
      ...mailboxes.map((config, index) => ({
        name: recipientName("邮件", index, mailboxes.length),
        send: () => sendEmail(config, message.subject, message.email, message.text),
      })),
    );
  } else {
    console.warn("⚠️ 未配置 SMTP_HOST / SMTP_USER / SMTP_PASS / MAIL_TO，跳过邮件");
  }

  const feishu = configuredFeishu();
  if (feishu) channels.push({ name: "飞书", send: () => sendFeishu(feishu, message.subject, message.text) });

  return channels;
};

/** Sends the message to all configured destinations; throws if none is configured or any fails. */
export const pushToAll = async (message: Message): Promise<void> => {
  const channels = buildChannels(message);
  if (channels.length === 0) {
    throw new Error("没有可用的推送渠道，请检查 Telegram、SMTP 或 FEISHU_WEBHOOK_URL 配置");
  }

  const results = await Promise.allSettled(channels.map(runChannel));
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => String(result.reason));
  if (failures.length > 0) throw new Error(failures.join("\n"));
};

/** Runs an entry point and turns any thrown error into a logged failure with exit code 1. */
export const runMain = async (main: () => Promise<void>): Promise<void> => {
  try {
    await main();
  } catch (error: unknown) {
    console.error("❌", describeError(error));
    process.exit(1);
  }
};
