import { useRef, useState } from 'react';
import { chatStream } from '@/api/llm';

export function useAiChat() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  function stop() {
    abortRef.current?.abort();
    abortRef.current = null;
  }

  /**
   * 流式问答。system 缺省时使用通用财务助手角色。
   * 返回最终完整文本；Abort 时抛出后由调用方按需处理（error 会写入）。
   */
  async function run(user: string, system = '你是一名专业的个人财务助手，请根据提供的汇总数据给出简洁、可执行的分析与建议。') {
    setLoading(true);
    setError('');
    setResult('');
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const full = await chatStream(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        { onDelta: (d) => setResult((prev) => prev + d), signal: ac.signal }
      );
      return full;
    } catch (e) {
      const err = e as Error;
      setError(err.name === 'AbortError' ? '已停止' : err.message);
      return '';
    } finally {
      abortRef.current = null;
      setLoading(false);
    }
  }

  return { run, stop, loading, result, error, setResult, setError };
}