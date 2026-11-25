import { createHmac } from "node:crypto";

export type FeishuConfig = {
  readonly webhook: string;
  readonly secret?: string;
};

const webhookPattern = /^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[\w-]+$/;

const deliveryError = (code: string): Error => Object.assign(new Error(code), { code });

export const sendFeishu = async (config: FeishuConfig, subject: string, text: string): Promise<void> => {
  if (!webhookPattern.test(config.webhook)) throw deliveryError("FEISHU_WEBHOOK_URL 格式无效");

  const timestamp = String(Math.floor(Date.now() / 1000));
  const signing = config.secret ? {
    timestamp,
    // Feishu uses timestamp + LF + secret as the HMAC key and an empty message.
    sign: createHmac("sha256", `${timestamp}\n${config.secret}`).digest("base64"),
  } : {};

  const response = await fetch(config.webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...signing, msg_type: "text", content: { text: `${subject}\n\n${text}` } }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  }).catch(() => { throw deliveryError("飞书连接失败或超时"); });

  if (!response.ok) throw deliveryError(`飞书 HTTP ${response.status}`);
  const result = await response.json().catch(() => null) as { code?: unknown; StatusCode?: unknown } | null;
  const code = result?.code ?? result?.StatusCode;
  if (code === 0) return;
  // API error text can contain request data. Report only the numeric code.
  throw deliveryError(typeof code === "number" ? `飞书返回码 ${code}` : "飞书响应格式异常");
};
