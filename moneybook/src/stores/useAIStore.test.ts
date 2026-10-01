/**
 * 凭证管理模块核心逻辑单元测试。
 * 覆盖「凭证目录 + 激活指针」模型的四项要求：
 * 1. 新增凭证是「追加」而非覆盖，历史凭证完整保留、可回退（防数据丢失核心）。
 * 2. 激活只是移动 activeProviderId 指针，不破坏任何凭证数据。
 * 3. 激活中的凭证在存在其他凭证时不可删除（删除保护）。
 * 4. API Key 明文只存在内存，持久化落盘为加密密文（apiKeyEnc），绝不写明文。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useAIStore, readAIConfig } from '@/stores/useAIStore';
import { getPreset } from '@/api/providers';
import { getRawKV } from '@/api/kv';
import { AI_CONFIG_KEY } from '@/lib/constants';

const STORAGE_KEY = AI_CONFIG_KEY;

function deepseek() {
  const p = getPreset('deepseek');
  if (!p) throw new Error('缺少 DeepSeek 预设');
  return p;
}
function openai() {
  const p = getPreset('openai');
  if (!p) throw new Error('缺少 OpenAI 预设');
  return p;
}

beforeEach(() => {
  // 每个用例从干净的凭证目录开始
  useAIStore.getState().reset();
});

describe('addProvider：追加不覆盖，不自动激活，填充目录字段', () => {
  it('新增凭证采用追加语义，历史凭证不被覆盖', () => {
    const s = useAIStore.getState();
    const id1 = s.addProvider(deepseek());
    s.addProvider(openai());
    const after = useAIStore.getState();
    expect(after.providers.length).toBe(2);
    expect(after.providers.find((p) => p.id === id1)).toBeTruthy();
  });

  it('多条凭证各自保留完整独立字段（displayName / createdAt）', () => {
    const s = useAIStore.getState();
    s.addProvider(deepseek());
    s.addProvider(openai());
    const ps = useAIStore.getState().providers;
    ps.forEach((p) => {
      expect(p.displayName).toBeTruthy();
      expect(p.createdAt).toBeTruthy();
    });
    expect(new Set(ps.map((p) => p.displayName)).size).toBe(2);
  });

  it('新增凭证不自动成为当前激活项，仍由用户显式选择', () => {
    const s = useAIStore.getState();
    const id1 = s.addProvider(deepseek());
    const id2 = s.addProvider(openai());
    const st = useAIStore.getState();
    // 未显式选择时 activeProviderId 不被新凭证改写（保持为空）
    expect(st.activeProviderId).not.toBe(id2);
    expect(st.activeProviderId).toBe('');
    // 此时实际生效的是目录中最早创建的一条（providers[0] = deepseek），而非最新添加的 openai
    expect(st.providers[0].id).toBe(id1);
    expect(readAIConfig().baseURL).toContain('deepseek');
  });
});

describe('setActiveProvider：激活指针切换，凭证数据不丢失（可回退）', () => {
  it('切换激活指针后，其他凭证数据完整保留', () => {
    const s = useAIStore.getState();
    const id1 = s.addProvider(deepseek());
    const id2 = s.addProvider(openai());
    // 给凭证1写入模型与 Key 后切到凭证2，再切回凭证1
    useAIStore.getState().setActiveProvider(id1);
    const before = useAIStore.getState();
    expect(before.activeProviderId).toBe(id1);
    expect(before.providers.find((p) => p.id === id1)).toBeTruthy();
    expect(before.providers.find((p) => p.id === id2)).toBeTruthy();
    // 切回凭证2：指针移动，两个凭证都还在
    useAIStore.getState().setActiveProvider(id2);
    const back = useAIStore.getState();
    expect(back.activeProviderId).toBe(id2);
    expect(back.providers.length).toBe(2);
  });
});

describe('removeProvider：激活中凭证删除保护', () => {
  it('存在其他凭证时，激活中的凭证不可删除', () => {
    const s = useAIStore.getState();
    const id1 = s.addProvider(deepseek());
    s.addProvider(openai());
    // 显式让 id1 成为激活项（新增凭证不再自动激活）
    useAIStore.getState().setActiveProvider(id1);
    const ok = useAIStore.getState().removeProvider(id1); // active=id1 且 providers>1
    expect(ok).toBe(false);
    expect(useAIStore.getState().providers.length).toBe(2);
  });

  it('删除非激活凭证成功，且激活指针不变', () => {
    const s = useAIStore.getState();
    const id1 = s.addProvider(deepseek());
    const id2 = s.addProvider(openai());
    s.addProvider(getPreset('qwen')!);
    // 显式把激活指针指向 id2，保证 id1 是非激活项
    useAIStore.getState().setActiveProvider(id2);
    const activeBefore = useAIStore.getState().activeProviderId; // 当前激活（id2）
    expect(activeBefore).not.toBe(id1); // id1 确实非激活
    const ok = useAIStore.getState().removeProvider(id1); // id1 非激活
    const after = useAIStore.getState();
    expect(ok).toBe(true);
    expect(after.providers.length).toBe(2);
    expect(after.activeProviderId).toBe(activeBefore); // 激活指针保持删除前不变
    expect(after.providers.find((p) => p.id === id1)).toBeUndefined();
  });

  it('未显式选择激活项时，回退生效的目录首条受删除保护', () => {
    const s = useAIStore.getState();
    const id1 = s.addProvider(deepseek());
    s.addProvider(openai());
    // 未显式激活（activeProviderId 为空）：实际生效的是 providers[0]（id1），同样不可删除
    expect(useAIStore.getState().activeProviderId).toBe('');
    expect(useAIStore.getState().removeProvider(id1)).toBe(false);
    // 先显式切换到第二条，再删第一条即可成功
    useAIStore.getState().setActiveProvider(useAIStore.getState().providers[1].id);
    expect(useAIStore.getState().removeProvider(id1)).toBe(true);
  });

  it('仅剩唯一凭证时可删除（等价于回到空配置）', () => {
    const s = useAIStore.getState();
    const id1 = s.addProvider(deepseek());
    const ok = useAIStore.getState().removeProvider(id1);
    const after = useAIStore.getState();
    expect(ok).toBe(true);
    expect(after.providers.length).toBe(0);
    expect(after.activeProviderId).toBe('');
  });
});

describe('updateProvider：API Key 加密持久化，明文仅存内存', () => {
  it('明文 Key 保存在内存，密文写入 apiKeyEnc', async () => {
    const s = useAIStore.getState();
    const id = s.addProvider(deepseek());
    await useAIStore.getState().updateProvider(id, { model: 'deepseek-chat', apiKey: 'sk-test-123456' });
    const p = useAIStore.getState().providers.find((x) => x.id === id)!;
    expect(p.apiKey).toBe('sk-test-123456'); // 内存明文
    expect(p.apiKeyEnc).toBeTruthy();
    expect(p.apiKeyEnc).not.toBe('sk-test-123456'); // 落盘非明文
    expect(p.model).toBe('deepseek-chat');
  });

  it('持久化数据中不包含明文 Key，也不存在 apiKey 字段', async () => {
    const s = useAIStore.getState();
    const id = s.addProvider(deepseek());
    await useAIStore.getState().updateProvider(id, { apiKey: 'sk-test-123456' });
    const raw = getRawKV(STORAGE_KEY)!;
    const persisted = JSON.parse(raw) as { providers: Array<Record<string, unknown>> };
    const json = JSON.stringify(persisted.providers);
    expect(persisted.providers.length).toBe(1);
    expect(persisted.providers[0].apiKey).toBeUndefined(); // apiKey 字段被剔除
    expect(json).not.toContain('sk-test-123456'); // 明文不出现在落盘 JSON
    expect(persisted.providers[0].apiKeyEnc).toBeTruthy(); // 密文存在
  });

  it('清空 apiKey 时密文也清空', async () => {
    const s = useAIStore.getState();
    const id = s.addProvider(deepseek());
    await useAIStore.getState().updateProvider(id, { apiKey: 'sk-test-123456' });
    await useAIStore.getState().updateProvider(id, { apiKey: '' });
    const p = useAIStore.getState().providers.find((x) => x.id === id)!;
    expect(p.apiKey).toBe('');
    expect(p.apiKeyEnc).toBe('');
  });
});

describe('readAIConfig：读取当前激活凭证，切换指针后跟随变化', () => {
  it('返回激活凭证的 baseURL / model / apiKey', async () => {
    const s = useAIStore.getState();
    const id = s.addProvider(deepseek());
    await useAIStore.getState().updateProvider(id, { model: 'deepseek-chat', apiKey: 'sk-test-123456' });
    useAIStore.getState().setEnabled(true);
    const cfg = readAIConfig();
    expect(cfg.baseURL).toContain('deepseek');
    expect(cfg.model).toBe('deepseek-chat');
    expect(cfg.apiKey).toBe('sk-test-123456');
  });

  it('切换激活凭证后，readAIConfig 跟随新激活项', async () => {
    const s = useAIStore.getState();
    const id1 = s.addProvider(deepseek());
    const id2 = s.addProvider(openai());
    await useAIStore.getState().updateProvider(id1, { model: 'deepseek-chat' });
    await useAIStore.getState().updateProvider(id2, { model: 'gpt-4o-mini' });
    useAIStore.getState().setEnabled(true);
    // 显式把激活指针切到 id2（openai）→ readAIConfig 用 openai 的模型
    useAIStore.getState().setActiveProvider(id2);
    expect(readAIConfig().model).toBe('gpt-4o-mini');
    // 切回 id1（deepseek）
    useAIStore.getState().setActiveProvider(id1);
    expect(readAIConfig().model).toBe('deepseek-chat');
  });
});