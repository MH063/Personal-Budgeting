/**
 * 服务商预设与模型列表拉取逻辑单元测试。
 * 覆盖：预设查找、OpenAI 风格 /models 解析、Ollama /api/tags 解析、
 * 无 /models 端点直接回退静态列表、各错误分支回退精选列表、genId 唯一性。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  getPreset,
  genId,
  fetchModels,
  PROVIDER_PRESETS,
  type ProviderPreset,
} from '@/api/providers';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getPreset', () => {
  it('返回内置服务商预设', () => {
    const ds = getPreset('deepseek');
    expect(ds?.defaultBaseUrl).toBe('https://api.deepseek.com');
    expect(ds?.authHeaderPrefix).toBe('Bearer');
  });

  it('未知名返回 undefined', () => {
    expect(getPreset('not-exist')).toBeUndefined();
  });

  it('预设名称与 id 一一对应且唯一', () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('fetchModels', () => {
  const githubFallback = async (): Promise<never> => {
    throw new Error('invalid url');
  };

  it('解析 OpenAI 风格 /models 返回（{data:[{id}]}）', async () => {
    const preset = getPreset('openai')!;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] }),
      })
    );
    const { models, fallback } = await fetchModels('https://api.openai.com', 'key', preset);
    expect(models).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(fallback).toBeFalsy();
  });

  it('解析 Ollama /api/tags 返回（{models:[{name}]}）', async () => {
    const preset = getPreset('ollama')!;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ models: [{ name: 'llama3.1' }, { name: 'qwen2.5' }] }),
      })
    );
    const { models } = await fetchModels('http://localhost:11434', '', preset);
    expect(models).toEqual(['llama3.1', 'qwen2.5']);
  });

  it('无 /models 端点的提供商直接返回静态精选列表', async () => {
    const preset = getPreset('zhipu')!;
    expect(preset.modelListEndpoint).toBe('');
    vi.stubGlobal('fetch', vi.fn(githubFallback));
    const { models } = await fetchModels('https://open.bigmodel.cn', 'key', preset);
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
  });

  it('HTTP 401/403 失败时回退到精选列表并标记 fallback', async () => {
    const preset = getPreset('deepseek')!;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    const res = await fetchModels('https://api.deepseek.com', 'bad-key', preset);
    expect(res.fallback).toBe(true);
    expect(res.models).toEqual(preset.models);
  });

  it('网络异常时回退到精选列表', async () => {
    const preset = getPreset('deepseek')!;
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const res = await fetchModels('https://api.deepseek.com', 'key', preset);
    expect(res.fallback).toBe(true);
    expect(res.models).toEqual(preset.models);
  });

  it('实时返回空列表时回退到精选列表', async () => {
    const preset = getPreset('deepseek')!;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) })
    );
    const res = await fetchModels('https://api.deepseek.com', 'key', preset);
    expect(res.fallback).toBe(true);
    expect(res.models).toEqual(preset.models);
  });
});

describe('genId', () => {
  it('生成唯一 ID', () => {
    const a = genId();
    const b = genId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });
});