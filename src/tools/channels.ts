import { describeError } from "./async.ts";
import { type FeishuConfig, sendFeishu } from "./feishu.ts";
import { splitList } from "./list.ts";
import { type MailConfig, sendEmail, sendTelegram } from "./notify.ts";

const DEFAULT_SMTP_PORT = 465;

export type TaskName = "github-trending" | "ai-news" | "stocks" | "telegram-email" | "binance-copy";
export type PushChannel = "telegram" | "email" | "feishu" | "wechat";

type TaskChannelSpec = {
  readonly envVar: string;
  readonly supported: readonly PushChannel[];
  readonly defaults: readonly PushChannel[];
};
const RELAY_CHANNELS = ["email", "wechat", "feishu"] as const;

/**
 * 各任务的默认推送渠道与自定义环境变量。
 * supported 校验白名单
 * 环境变量未设置或为空时使用 defaults；设置时用英文或中文逗号分隔渠道名。
 */
export const TASK_CHANNELS: Record<TaskName, TaskChannelSpec> = {
  // github 涨星榜
  "github-trending": {
    envVar: "GITHUB_TRENDING_CHANNELS",
    supported: ["telegram"],
    defaults: ["telegram"],
  },
  "ai-news": {
    envVar: "AI_NEWS_CHANNELS",
    supported: ["telegram"],
    defaults: ["telegram"],
  },
  // 股票
  stocks: {
    envVar: "STOCKS_CHANNELS",
    supported: ["telegram", "email", "feishu"],
    defaults: ["telegram", "email", "feishu"],
  },
  // 熬鹰资本 tg 频道 仓位同步推送
  "telegram-email": {
    envVar: "TELEGRAM_RELAY_CHANNELS",
    supported: RELAY_CHANNELS,
    defaults: RELAY_CHANNELS,
  },
  // 熬鹰资本 最新操作
  "binance-copy": {
    envVar: "BINANCE_COPY_CHANNELS",
    supported: RELAY_CHANNELS,
    defaults: RELAY_CHANNELS,
  },
};

export const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;

export const enabledChannels = (task: TaskName): Set<PushChannel> => {
  const spec = TASK_CHANNELS[task];
  const raw = env(spec.envVar);
  if (!raw && task === "binance-copy") return enabledChannels("telegram-email");
  if (!raw) return new Set(spec.defaults);
  const supported = new Set<string>(spec.supported);
  const parsed = splitList(raw).map((item) => item.toLowerCase());
  if (parsed.length === 0) {
    throw new Error(`${spec.envVar} 未指定有效的推送渠道（可选：${spec.supported.join("、")}）`);
  }
  const unsupported = parsed.filter((item) => !supported.has(item));
  if (unsupported.length > 0) {
    throw new Error(`${spec.envVar} 包含不支持的渠道：${unsupported.join("、")}（可选：${spec.supported.join("、")}）`);
  }
  return new Set(parsed as PushChannel[]);
};

export const configuredWeChatKey = (): string | undefined =>
  env("WECHAT_PUSH_ENABLED")?.toLowerCase() === "true" ? env("SERVERCHAN_SENDKEY") : undefined;

export type TelegramTarget = {
  readonly token: string;
  readonly chatId: string;
};

export const configuredTelegram = (): TelegramTarget[] => {
  const token = env("TELEGRAM_BOT_TOKEN");
  if (!token) return [];
  return splitList(env("TELEGRAM_CHAT_ID")).map((chatId) => ({ token, chatId }));
};

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

export const configuredChannelsFor = (task: TaskName): PushChannel[] => {
  const enabled = enabledChannels(task);
  const available: PushChannel[] = [];
  if (enabled.has("telegram") && configuredTelegram().length > 0) available.push("telegram");
  if (enabled.has("email") && configuredMailboxes().length > 0) available.push("email");
  if (enabled.has("feishu") && configuredFeishu()) available.push("feishu");
  if (enabled.has("wechat") && configuredWeChatKey()) available.push("wechat");
  return available;
};

const buildChannels = (task: TaskName, enabled: ReadonlySet<PushChannel>, message: Message): Channel[] => {
  const channels: Channel[] = [];

  if (enabled.has("telegram")) {
    const targets = configuredTelegram();
    if (targets.length > 0) {
      channels.push(
        ...targets.map(({ token, chatId }, index) => ({
          name: recipientName("Telegram", index, targets.length),
          send: () => sendTelegram(token, chatId, message.telegram),
        })),
      );
    } else {
      console.warn("⚠️ 未配置 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID，跳过 Telegram");
    }
  }

  if (enabled.has("email")) {
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
  }

  if (enabled.has("feishu")) {
    const feishu = configuredFeishu();
    if (feishu) channels.push({ name: "飞书", send: () => sendFeishu(feishu, message.subject, message.text) });
  }

  return channels;
};

/** Sends the message to all enabled & configured destinations for the task; throws if none is available or any fails. */
export const pushToAll = async (task: TaskName, message: Message): Promise<void> => {
  const enabled = enabledChannels(task);
  const channels = buildChannels(task, enabled, message);
  if (channels.length === 0) {
    throw new Error(
      `没有可用的推送渠道（当前允许：${[...enabled].join("、")}），请检查对应渠道凭据或 ${TASK_CHANNELS[task].envVar} 配置`,
    );
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
