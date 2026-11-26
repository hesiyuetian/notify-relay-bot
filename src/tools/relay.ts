import {
  configuredFeishu, configuredMailboxes, configuredWeChatKey, enabledChannels, TASK_CHANNELS,
} from "./channels.ts";
import { sendFeishu } from "./feishu.ts";
import { sendEmail } from "./notify.ts";
import { sendWeChatMessage } from "./wechat.ts";

export type RelayMessage = { subject: string; html: string; text: string };
export type Recipient<T> = { to: string; label?: string; deliver: (item: T) => Promise<void> };

export const relayRecipients = <T>(
  task: "telegram-email" | "binance-copy",
  format: (item: T) => RelayMessage,
): Recipient<T>[] => {
  const enabled = enabledChannels(task);
  const recipients: Recipient<T>[] = [];

  if (enabled.has("email")) {
    for (const mailbox of configuredMailboxes()) {
      recipients.push({
        to: mailbox.to,
        deliver: (item) => {
          const { subject, html, text } = format(item);
          return sendEmail(mailbox, subject, html, text);
        },
      });
    }
  }
  const sendKey = enabled.has("wechat") ? configuredWeChatKey() : undefined;
  if (sendKey) {
    recipients.push({
      to: "serverchan:wechat:service-account",
      label: "个人微信",
      deliver: (item) => {
        const { subject, text } = format(item);
        return sendWeChatMessage(sendKey, subject, text);
      },
    });
  }
  const feishu = enabled.has("feishu") ? configuredFeishu() : undefined;
  if (feishu) {
    recipients.push({
      to: `feishu:${feishu.webhook}`,
      label: "飞书",
      deliver: (item) => {
        const { subject, text } = format(item);
        return sendFeishu(feishu, subject, text);
      },
    });
  }
  if (!recipients.length) {
    throw new Error(
      `没有可用的推送渠道（当前允许：${[...enabled].join("、")}），请检查对应渠道凭据或 ${TASK_CHANNELS[task].envVar} 配置`,
    );
  }
  return recipients;
};
