import { parseHTML } from "linkedom";
import { withRetry } from "../tools/async.ts";
import { escapeHtml } from "../tools/html.ts";

const DEFAULT_CHANNEL = "aoying999";

export const channelUsername = (input?: string): string => {
  const value = input?.trim() || DEFAULT_CHANNEL;
  const match = /^(?:@|(?:https:\/\/)?t\.me\/(?:s\/)?)?([a-z0-9_]{1,32})\/?$/i.exec(value);
  if (!match) throw new Error("TELEGRAM_CHANNEL 请填写一个公开频道用户名、@用户名或 t.me 频道链接");
  return match[1].toLowerCase();
};

export type Post = { channel: string; id: number; date: string; text: string };
export type Page = { posts: Post[]; before?: number };

export const parsePage = (html: string, channel: string): Page => {
  const { document } = parseHTML(html);
  const history = document.querySelector(".tgme_channel_history");
  const posts = Array.from(history?.querySelectorAll(".tgme_widget_message") ?? [], (message) => {
    const [source, rawId] = (message.getAttribute("data-post") ?? "").split("/");
    const id = Number(rawId);
    const date = message.querySelector(".tgme_widget_message_date time")?.getAttribute("datetime");
    if (source.toLowerCase() !== channel || !Number.isSafeInteger(id) || id <= 0 || !date || !Number.isFinite(Date.parse(date))) {
      throw new Error("频道预览页的消息编号或发布时间异常");
    }
    const body = message.querySelector(".tgme_widget_message_text");
    for (const br of body?.querySelectorAll("br") ?? []) br.replaceWith("\n");
    return { channel, id, date, text: body?.textContent?.trim() || "此帖没有可预览的正文，请打开原帖查看。" };
  });
  if (!posts.length) throw new Error("频道公开页未解析到消息");
  const older = history?.querySelector("a[data-before]");
  const before = older ? Number(older.getAttribute("data-before")) : undefined;
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw new Error("频道分页编号异常");
  return { posts, before };
};

export const fetchPage = (channel: string, before?: number): Promise<Page> => withRetry(async () => {
  const url = new URL(`https://t.me/s/${channel}`);
  if (before !== undefined) url.searchParams.set("before", String(before));
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`频道预览请求失败 HTTP ${response.status}`);
  return parsePage(await response.text(), channel);
}, 3, 1000);

export const since = async (first: Page, cursor: number, readPage: (before?: number) => Promise<Page>): Promise<Post[]> => {
  const posts = new Map<number, Post>();
  let page = first;
  let boundary = Infinity;
  for (;;) {
    for (const post of page.posts) if (post.id > cursor) posts.set(post.id, post);
    if (Math.min(...page.posts.map((post) => post.id)) <= cursor + 1) break;
    if (page.before === undefined || page.before >= boundary) throw new Error(`无法回溯到消息 #${cursor}，保留发送进度`);
    boundary = page.before;
    page = await readPage(boundary);
  }
  return [...posts.values()].sort((a, b) => a.id - b.id);
};

export const formatPost = (post: Post) => {
  const url = `https://t.me/${post.channel}/${post.id}`;
  const timestamp = new Date(post.date).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  const metadata = `@${post.channel} · #${post.id} · 北京时间 ${timestamp}`;
  const lines = post.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const headline = post.channel === DEFAULT_CHANNEL && lines[0] === "【熬鹰币安实盘】" && lines[1] ? lines[1] : lines[0];
  return {
    subject: post.channel === DEFAULT_CHANNEL
      ? `【熬鹰频道】${headline.slice(0, 80)} (#${post.id})`
      : `${headline.slice(0, 80)} · @${post.channel} (#${post.id})`,
    text: `${metadata}\n\n${post.text}\n\n原帖 ${url}`,
    html: `<p>${escapeHtml(metadata)}</p><p>${escapeHtml(post.text).replaceAll("\n", "<br>")}</p><p><a href="${url}">查看 Telegram 原帖</a></p>`,
  };
};
