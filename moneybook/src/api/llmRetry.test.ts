// llm.chat 有限重试单测：验证「网络错误 / 429 / 5xx 重试，4xx 与取消不重试」的边界。
// 通过 mock 统一 HTTP 客户端（@/lib/http）与 AI 凭证 store，避免真实网络与数据库依赖。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { httpFetch } from '@/lib/http';
import { chat, CHAT_MAX_RETRIES } from './llm';

vi.mock('@/lib/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/http')>();
  // 保留 isAbortError / createTimeoutGuard 的真实实现，仅替换 httpFetch
  return { ...actual, httpFetch: vi.fn() };
});

vi.mock('@/stores/useAIStore', () => ({
  readAIConfig: () => ({ enabled: true, baseURL: 'https://api.example.com/v1', model: 'test-model', apiKey: 'test-key' }),
  useAIStore: { getState: () => ({ activeProviderId: 'p1', providers: [{ id: 'p1' }] }) },
}));

const mockedFetch = vi.mocked(httpFetch);

/** 构造成功响应（含 content 与 usage） */
function okResponse(text: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: text } }], usage: { total_tokens: 10 } }),
  } as unknown as Response;
}

/** 构造失败响应（仅状态码，响应正文不参与判定） */
function errResponse(status: number): Response {
  return { ok: false, status, json: async () => ({}) } as unknown as Response;
}

describe('chat 有限重试', () => {
  beforeEach(() => {
    // 退避使用 setTimeout，需用伪定时器推进，避免测试真实等待 2s
    vi.useFakeTimers();
    mockedFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('网络错误后重试成功（首次失败、第二次成功）', async () => {
    mockedFetch.mockRejectedValueOnce(new Error('Failed to fetch')).mockResolvedValueOnce(okResponse(' 你好 '));
    const p = chat([{ role: 'user', content: 'hi' }]);
    // 先挂断言处理器再推进定时器，避免 rejected Promise 在挂载前触发 unhandled rejection
    const assertion = expect(p).resolves.toBe('你好');
    await vi.advanceTimersByTimeAsync(600); // 覆盖第一次退避 500ms
    await assertion;
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it('HTTP 500 连续失败达到上限后抛错（共 1+CHAT_MAX_RETRIES 次请求）', async () => {
    mockedFetch.mockResolvedValue(errResponse(500));
    const p = chat([{ role: 'user', content: 'hi' }]);
    const assertion = expect(p).rejects.toThrow('AI 服务返回错误');
    await vi.advanceTimersByTimeAsync(3000); // 覆盖两次退避 500ms + 1500ms
    await assertion;
    expect(mockedFetch).toHaveBeenCalledTimes(1 + CHAT_MAX_RETRIES);
  });

  it('HTTP 400（参数错误）不重试，仅请求一次', async () => {
    mockedFetch.mockResolvedValue(errResponse(400));
    await expect(chat([{ role: 'user', content: 'hi' }])).rejects.toThrow('参数错误');
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('HTTP 429 限流会重试并最终成功', async () => {
    mockedFetch.mockResolvedValueOnce(errResponse(429)).mockResolvedValueOnce(okResponse('ok'));
    const p = chat([{ role: 'user', content: 'hi' }]);
    const assertion = expect(p).resolves.toBe('ok');
    await vi.advanceTimersByTimeAsync(600);
    await assertion;
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it('响应格式异常不重试，仅请求一次', async () => {
    mockedFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as unknown as Response);
    await expect(chat([{ role: 'user', content: 'hi' }])).rejects.toThrow('AI 服务返回格式异常');
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('外部已取消（signal 已 abort）不再发起请求', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(chat([{ role: 'user', content: 'hi' }], { signal: ac.signal })).rejects.toThrow('已取消');
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});
