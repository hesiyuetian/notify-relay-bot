import { DeliveryDeferred } from "./delivery.ts";

const MINUTE = 60_000;

// Turbo channel 9 is the personal WeChat service account (方糖服务号).
const WECHAT_CHANNEL = "9";

export const sendWeChatMessage = async (sendKey: string, subject: string, text: string): Promise<void> => {
  const title = Array.from(subject).slice(0, 32).join("");
  const response = await fetch(`https://sctapi.ftqq.com/${encodeURIComponent(sendKey)}.send`, {
    method: "POST",
    body: new URLSearchParams({ channel: WECHAT_CHANNEL, title, desp: text }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 429) throw new DeliveryDeferred("Server酱 HTTP 429", Date.now() + 1440 * MINUTE);
  if (!response.ok) throw new DeliveryDeferred(`Server酱 HTTP ${response.status}`, Date.now() + 5 * MINUTE);
  const result = await response.json().catch(() => null) as {
    code?: number; message?: string; data?: { errno?: number; error?: string };
  } | null;
  const resultCode = result?.code === 0 ? (result.data?.errno ?? 0) : result?.code;
  if (resultCode === 0) return;
  // Returned messages can echo request data. Log only the numeric API code.
  const code = Number.isSafeInteger(resultCode) ? String(resultCode) : "响应异常";
  const dailyLimit = /日.{0,8}(额度|限额|上限|次数)|每天|每日|daily|当天/i.test([result?.message, result?.data?.error].join(" "));
  const nextDay = new Date(Date.now() + 8 * 3600_000);
  nextDay.setUTCHours(24, 0, 0, 0);
  const retryAt = dailyLimit ? nextDay.getTime() - 8 * 3600_000 : Date.now() + 5 * MINUTE;
  throw new DeliveryDeferred(`Server酱 ${code}`, retryAt);
};
