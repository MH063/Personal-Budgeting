/**
 * 更新检查单测：latest.json 直链主路径 + GitHub API 兜底路径 + 错误归一化。
 * 覆盖 v1.0.3 修复的 403 根因：请求必须显式携带 User-Agent（GitHub 对无 UA 请求
 * 直接拒绝），且优先走 latest.json 直链规避未认证 API 限流。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchLatestStableRelease, friendlyUpdateError } from '@/lib/update';

// kv 走内存 mock，避免真实 settings 表依赖
vi.mock('@/api/kv', () => ({
  getKV: () => '',
  setKV: vi.fn(),
}));

vi.mock('@/lib/http');
import { httpFetch } from '@/lib/http';

/** 构造一个最小可用的 Response（仅暴露 update.ts 用到的方法） */
function jsonRes(data: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => data } as unknown as Response;
}

describe('fetchLatestStableRelease：latest.json 直链主路径', () => {
  beforeEach(() => {
    vi.mocked(httpFetch).mockReset();
  });

  it('latest.json 命中正式版：返回清单内容且只发一次请求（未降级）', async () => {
    vi.mocked(httpFetch).mockResolvedValueOnce(
      jsonRes({
        version: '1.0.3',
        notes: '修复一键更新通道',
        pub_date: '2026-10-02T00:00:00Z',
      }),
    );
    const info = await fetchLatestStableRelease();
    expect(info).toEqual({
      version: '1.0.3',
      url: 'https://github.com/MH063/Personal-Budgeting/releases/latest',
      notes: '修复一键更新通道',
      publishedAt: '2026-10-02T00:00:00Z',
    });
    expect(vi.mocked(httpFetch)).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(httpFetch).mock.calls[0];
    expect(String(url)).toContain('latest.json');
    // 403 修复关键断言：请求必须显式携带 User-Agent
    expect(init?.headers).toMatchObject({
      'User-Agent': expect.stringContaining('moneybook-updater'),
    });
  });

  it('latest.json 的 version 为四段（非正式）→ 视为无正式版，降级 API 兜底', async () => {
    vi.mocked(httpFetch)
      .mockResolvedValueOnce(jsonRes({ version: '1.0.3.1', notes: '', pub_date: '' }))
      .mockResolvedValueOnce(
        jsonRes([
          {
            tag_name: 'v1.0.3',
            html_url: 'https://github.com/MH063/Personal-Budgeting/releases/tag/v1.0.3',
            body: '说明',
            published_at: '2026-10-02T00:00:00Z',
            draft: false,
            prerelease: false,
          },
        ]),
      );
    const info = await fetchLatestStableRelease();
    expect(info?.version).toBe('1.0.3');
    expect(vi.mocked(httpFetch)).toHaveBeenCalledTimes(2);
  });

  it('latest.json 请求失败（网络错误）→ 降级 API 兜底成功', async () => {
    vi.mocked(httpFetch)
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValueOnce(
        jsonRes([
          {
            tag_name: 'v1.0.2',
            html_url: 'u',
            body: 'b',
            published_at: 't',
            draft: false,
            prerelease: false,
          },
        ]),
      );
    const info = await fetchLatestStableRelease();
    expect(info?.version).toBe('1.0.2');
    // 兜底请求同样带 User-Agent
    const init = vi.mocked(httpFetch).mock.calls[1][1];
    expect(init?.headers).toMatchObject({
      'User-Agent': expect.stringContaining('moneybook-updater'),
    });
  });

  it('API 兜底路径：跳过四段 / 预发布 / draft，命中第一个正式版', async () => {
    vi.mocked(httpFetch)
      .mockResolvedValueOnce(jsonRes({ version: 'x', notes: '', pub_date: '' }))
      .mockResolvedValueOnce(
        jsonRes([
          { tag_name: 'v1.0.0.1', draft: false, prerelease: false },
          { tag_name: 'v1.0.3-rc.1', draft: false, prerelease: true },
          { tag_name: 'v1.0.2', draft: true },
          {
            tag_name: 'v1.0.1',
            html_url: 'u',
            body: 'b',
            published_at: 't',
            draft: false,
            prerelease: false,
          },
        ]),
      );
    const info = await fetchLatestStableRelease();
    expect(info?.version).toBe('1.0.1');
  });

  it('两条路径都无正式版 → 返回 null', async () => {
    vi.mocked(httpFetch)
      .mockResolvedValueOnce(jsonRes({ version: '1.0.3.1', notes: '', pub_date: '' }))
      .mockResolvedValueOnce(jsonRes([]));
    expect(await fetchLatestStableRelease()).toBeNull();
  });
});

describe('friendlyUpdateError：异常归一化为友好文案', () => {
  it('HTTP 403 → 被拒绝文案，不再把 403 技术细节直接暴露', () => {
    const msg = friendlyUpdateError(new Error('GitHub 接口返回 HTTP 403'));
    expect(msg).toContain('被拒绝');
    expect(msg).not.toContain('403');
  });
  it('HTTP 429 限流 → 同样归类为被拒绝', () => {
    expect(friendlyUpdateError(new Error('HTTP 429'))).toContain('被拒绝');
  });
  it('网络类关键词 → 保持网络文案并给出手动安装出路', () => {
    expect(friendlyUpdateError(new Error('Failed to fetch'))).toContain('无法连接');
  });
  it('超时（AbortError）→ 超时文案', () => {
    expect(friendlyUpdateError(new DOMException('aborted', 'AbortError'))).toContain('超时');
  });
});
