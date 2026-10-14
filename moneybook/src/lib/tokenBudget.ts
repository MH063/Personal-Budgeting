/**
 * LLM 上下文体积控制（零依赖的粗略 token 估算 + 裁剪）。
 * ---------------------------------------------------------------
 * 背景（历史缺陷）：多处拼接给大模型的上下文此前只有「条目数量」上限，
 * 或干脆没有上限（如知识库、对话历史），单条内容一旦很长就会把请求撑爆，
 * 既可能触发服务端 400/413，也会产生高额计费。
 *
 * 这里不做精确分词（引入 tokenizer 会显著增大体积且各厂商口径不一致），
 * 只用「保守高估」的近似估算来控制体积——宁可少发一点，也不冒超限的风险：
 *  - 非 ASCII 字符（中文/日文/emoji 等）：约 1 token / 字符（实际多为 1～2 字/token，偏高估）
 *  - ASCII 字符（英文/数字/符号）：约 1 token / 4 字符
 * 估算一旦偏高，只会让预留预算更保守，不会导致低估超限。
 */

/** 最小消息结构（与各调用方的历史消息兼容，避免为此引入对具体模块的类型依赖） */
export interface ChatMsgLike {
  role: string;
  content: string;
}

/**
 * 粗略估算文本的 token 数（保守高估，见文件头说明）。
 * @param text 待估算文本；空值返回 0
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let nonAscii = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
    else nonAscii++;
  }
  return nonAscii + Math.ceil(ascii / 4);
}

/**
 * 把单条文本裁剪到 token 预算内（超出时按估算比例截断并追加省略号）。
 * 用于「单条消息过长」的场景（如对话历史中的某条回答）。
 * @param text 原文
 * @param maxTokens 预算上限；<=0 时返回空串
 * @param tail 截断后追加的省略标记
 */
export function truncateToTokens(text: string, maxTokens: number, tail = '…'): string {
  if (maxTokens <= 0) return '';
  const est = estimateTokens(text);
  if (est <= maxTokens) return text;
  // 按估算比例折算保留字符数，至少保留 1 个字符
  const keep = Math.max(1, Math.floor(text.length * (maxTokens / est)));
  return text.slice(0, keep) + tail;
}

/**
 * 裁剪对话历史到 token 预算内，并保证结果以 user 开头（不外发「半条对话」）。
 * 做法：从最近一条往前累计，超预算即停；若裁剪后首条是 assistant（其对应的
 * user 问题已被截掉），则丢弃该条，避免模型看到无提问的回答而产生错乱。
 * @param messages 历史消息（通常为 user/assistant 交替）
 * @param budgetTokens 历史部分的总 token 预算
 */
export function clipChatHistory<T extends ChatMsgLike>(messages: T[], budgetTokens: number): T[] {
  const out: T[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    // 每条消息附加约 4 token 的角色/结构开销
    const cost = estimateTokens(m.content) + 4;
    // 至少保留一条（即使单条已超预算，也交由上层决定是否发送）
    if (out.length > 0 && used + cost > budgetTokens) break;
    out.unshift(m);
    used += cost;
  }
  // 丢弃开头孤立的 assistant 消息，保证多轮对话从「用户提问」开始
  let dropped = 0;
  while (out.length > 0 && out[0].role === 'assistant') {
    out.shift();
    dropped++;
  }
  if (dropped > 0) {
    console.debug('[tokenBudget] 对话历史裁剪：丢弃开头孤立 assistant 消息', dropped, '条');
  }
  return out;
}

/** clipLinesToBudget 的可选项 */
export interface ClipLinesOptions {
  /** 小节标题等已占用的 token，裁剪时一并计入预算 */
  headerTokens?: number;
  /** 行间连接符，默认换行 */
  separator?: string;
}

/**
 * 按 token 预算裁剪「多行拼接」内容（明细行、示例行、知识库条目等）。
 * 采用「从前往后取、超预算即停」的策略，保证首个条目一定会被包含（避免整体为空）。
 * @returns text 为拼好的文本，omitted 为因超预算被省略的行数
 */
export function clipLinesToBudget(
  lines: string[],
  budgetTokens: number,
  opts: ClipLinesOptions = {}
): { text: string; omitted: number } {
  const sep = opts.separator ?? '\n';
  const picked: string[] = [];
  let used = opts.headerTokens ?? 0;
  for (const line of lines) {
    // 每条附加约 1 token 的连接符开销
    const cost = estimateTokens(line) + 1;
    if (picked.length > 0 && used + cost > budgetTokens) break;
    picked.push(line);
    used += cost;
  }
  const omitted = Math.max(0, lines.length - picked.length);
  if (omitted > 0) {
    console.debug('[tokenBudget] 内容超出 token 预算，已省略行数：', omitted);
  }
  return { text: picked.join(sep), omitted };
}
