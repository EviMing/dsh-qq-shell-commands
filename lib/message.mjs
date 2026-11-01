/**
 * OneBot 11 消息事件的小工具。
 *
 * NapCat 开启 messagePostFormat=array 时，正文在 message 数组里；部分实现会直接
 * 给字符串。这里统一抽出所有 text 段，@、图片、表情等非文本段不参与匹配——
 * 文本必须「完全等于」配置里的键。
 */

/** @param {unknown} message */
export function extractText(message) {
  if (typeof message === 'string') return message;
  if (!Array.isArray(message)) return '';
  let text = '';
  for (const segment of message) {
    if (segment !== null && typeof segment === 'object' && segment.type === 'text') {
      const value = segment.data?.text;
      if (typeof value === 'string') text += value;
    }
  }
  return text;
}

/** 发送者 QQ 号（统一成字符串）。 */
export function senderOf(event) {
  const value = event?.user_id ?? event?.sender?.user_id;
  if (value === undefined || value === null) return '';
  return String(value);
}

/** 群号（私聊返回空字符串）。 */
export function groupOf(event) {
  const value = event?.group_id;
  if (value === undefined || value === null) return '';
  return String(value);
}
