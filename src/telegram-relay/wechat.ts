import { sendWeChatMessage } from "../tools/wechat.ts";
import { formatPost, type Post } from "./channel.ts";

export const sendWeChat = (sendKey: string, post: Post, test = false): Promise<void> => {
  const message = formatPost(post);
  return sendWeChatMessage(sendKey, (test ? "[测试] " : "") + message.subject, message.text);
};
