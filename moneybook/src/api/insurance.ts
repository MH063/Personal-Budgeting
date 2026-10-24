/**
 * 保障保单存储（settings/kv，不新增数据库表）。
 *
 * 保单列表以 JSON 存于 kv.checkup.insurance.policies：
 * - 读取：启动时 hydrateKV() 把 kv.% 前缀行载入内存缓存，getInsurancePolicies() 同步读缓存；
 * - 保存：setKV() 写穿（先更新内存缓存，再异步写库），同会话内立即生效，重启后由 hydrateKV 重新载入；
 * - 容错：JSON 损坏时降级为空列表并打日志，不阻塞财务体检页其余指标。
 */
import { getKV, setKV } from './kv';
import { INSURANCE_KIND_LABELS, type InsurancePolicy, type InsuranceKind } from './stats';

/** 保单列表的 kv key（与 hydrateKV 的 kv.% 前缀约定一致） */
const KV_KEY = 'kv.checkup.insurance.policies';

/** 清洗单条保单：约束数值字段为有限数字、险种回退默认、名称回退险种名。
 *  防止旧版本 JSON 缺字段导致后续覆盖计算出现 NaN。 */
function sanitizePolicy(p: unknown): InsurancePolicy | null {
  if (!p || typeof p !== 'object') return null;
  const raw = p as Partial<InsurancePolicy>;
  const kinds: InsuranceKind[] = ['life', 'critical', 'medical', 'accident'];
  const kind = kinds.includes(raw.kind as InsuranceKind) ? (raw.kind as InsuranceKind) : 'medical';
  const num = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : INSURANCE_KIND_LABELS[kind];
  const note = typeof raw.note === 'string' && raw.note.trim() ? raw.note.trim() : undefined;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : genId(),
    kind,
    name,
    coverage: Math.max(0, num(raw.coverage)),
    annualPremium: Math.max(0, num(raw.annualPremium)),
    note,
  };
}

/** 读取全部保单（逐条清洗；解析失败时返回空列表并打日志，避免脏数据阻塞体检页） */
export function getInsurancePolicies(): InsurancePolicy[] {
  const raw = getKV(KV_KEY, '[]');
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.map(sanitizePolicy).filter((x): x is InsurancePolicy => x !== null);
  } catch (e) {
    // 关键位置日志：保单 JSON 损坏时降级为空列表，不影响体检页其余指标
    // eslint-disable-next-line no-console
    console.error('[insurance] 保单数据解析失败，已降级为空列表：', e);
    return [];
  }
}

/** 整体保存保单列表（内存 + 数据库写穿），返回是否落库成功 */
export async function saveInsurancePolicies(list: InsurancePolicy[]): Promise<boolean> {
  return setKV(KV_KEY, JSON.stringify(list));
}

/** 生成简单唯一 id（时间戳 + 随机后缀，避免依赖 crypto） */
function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 新增保单（追加到列表末尾并整体保存） */
export async function addInsurancePolicy(p: Omit<InsurancePolicy, 'id'>): Promise<boolean> {
  const list = getInsurancePolicies();
  list.push({ ...p, id: genId() });
  return saveInsurancePolicies(list);
}

/** 更新保单（按 id 匹配，找不到时返回 false 不落库） */
export async function updateInsurancePolicy(id: string, patch: Omit<InsurancePolicy, 'id'>): Promise<boolean> {
  const list = getInsurancePolicies();
  const idx = list.findIndex((x) => x.id === id);
  if (idx < 0) return false;
  list[idx] = { ...patch, id };
  return saveInsurancePolicies(list);
}

/** 删除保单（按 id 过滤后整体保存） */
export async function deleteInsurancePolicy(id: string): Promise<boolean> {
  return saveInsurancePolicies(getInsurancePolicies().filter((x) => x.id !== id));
}
