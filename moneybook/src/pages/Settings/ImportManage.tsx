import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  bulkImportTransactions, getImportReferences, parseBillAOA, parseCsvText,
  accountsMatch, normalizeAccountName, rowFingerprint, rowKeyOf,
  buildColumnMap, parseAoaWithMap, IMPORT_FIELD_LABELS,
  type ImportRow, type ImportSmoke, type ColumnMap, type ImportFieldKey, type ImportRule,
} from '@/api/import';
import { loadImportRules, saveImportRules, pickRuleKeyword, shouldLearnCorrection, learnRuleFromCorrection, type LearnedRuleCandidate } from '@/api/importRules';
import { recalcAccountBalances, updateTransaction } from '@/api/transactions';
import { isZip, tryExtractZip, detectZipEncryption } from '@/api/importZip';
import { recordImportLog, listImportLogs, type ImportLog } from '@/api/importLog';
import { recordAudit } from '@/api/audit';
import { suggestForText } from '@/api/aiSuggest';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/hint';
import { Modal } from '@/components/ui/modal';
import { formatMoney } from '@/lib/format';

/** 支付宝等导出的 CSV 常为 GBK 编码：优先按 UTF-8 解码，若出现替换符则视为 GBK 重解。 */
function decodeText(buf: Uint8Array): string {
  const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const data = hasBom ? buf.subarray(3) : buf;
  const asUtf8 = new TextDecoder('utf-8', { fatal: false }).decode(data);
  if (!hasBom && asUtf8.includes('\uFFFD')) {
    try { return new TextDecoder('gbk').decode(data); } catch { /* 回退 utf-8 */ }
  }
  return asUtf8;
}

// 表头别名推断已迁移至 import.buildColumnMap（含多字段认领策略）。

/** 导入类型下拉选项（预览与「导入后待核对」共用） */
const IMPORT_TYPE_OPTIONS: { value: ImportRow['type']; label: string }[] = [
  { value: 'expense', label: '支出' },
  { value: 'income', label: '收入' },
  { value: 'transfer', label: '转账' },
  { value: 'repay_in', label: '负债减少' },
];

/**
 * 「导入后待核对」项：可疑行（去向为账单推测）已按推测口径入库，
 * 携带库中交易 id 与解析后的账户 id，便于就地改类型/账户后回写该交易。
 */
interface ReconItem {
  id: number;
  line: number;
  pending: string;
  /** 原始解析行（保留备注/订单号/支付时间等字段，回写时一并带回去，避免丢字段） */
  src: ImportRow;
  type: ImportRow['type'];
  accountId: number;
  toAccountId: number | null;
}

export default function ImportManage() {
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [parseWarn, setParseWarn] = useState<string[]>([]);
  const [autoCreate, setAutoCreate] = useState(true);
  const [refs, setRefs] = useState<ImportSmoke | null>(null);
  // 「归入指定账户」选择：'0'=自动（按账户/支付方式匹配或创建）；否则整批归入所选账户
  const [assignAccount, setAssignAccount] = useState('0');
  // 将被自动创建账户名的预览（可改名），导入前可预先调整，避免误建账户
  const [pendingAccounts, setPendingAccounts] = useState<string[]>([]);
  // 疑似重复行（订单号已在库/批内，或批内同指纹）→ 行首黄点提醒
  const [dupLines, setDupLines] = useState<Set<number>>(new Set());
  // 加密文件（微信 zip）解压密码
  const [password, setPassword] = useState('');
  // 解压密码对话框：选中加密 zip 时弹出，输入密码后即时重试解密
  const [pwdModal, setPwdModal] = useState<{ file: File; text: string; error?: string } | null>(null);
  // 导入历史审计
  const [importHist, setImportHist] = useState<ImportLog[]>([]);
  const [busy, setBusy] = useState(false);
  // 「按流水重算信用账户余额」状态：导入为余额中性，需此动作让花呗/白条/信用卡负债如实体现
  const [recalcBusy, setRecalcBusy] = useState(false);
  // 最近一次选择文件的信息（用于审计记录）
  const fileMeta = useRef<{ names: string; count: number }>({ names: '导入文件', count: 1 });
  // 「AI 智能归类」补全未匹配分类/账户的状态
  const [classifying, setClassifying] = useState(false);
  // 列映射预览（仅自定义模板/单文件时启用）：表头各列手动指认业务字段
  const [mapOpen, setMapOpen] = useState(false);
  const [colHeader, setColHeader] = useState<string[]>([]);
  const [colMap, setColMap] = useState<ColumnMap>({});
  const [mapAoa, setMapAoa] = useState<unknown[][] | null>(null);
  // 「导入后待核对」：可疑行已按推测口径入库，此处按库中交易 id 逐条修正（改类型/账户）
  const [recon, setRecon] = useState<ReconItem[]>([]);
  // 解析结果弹窗：选择文件识别成功后以弹窗形式集中展示（用户要求，避免大表格挤在页面）；
  // 弹窗内可编辑修正并直接「开始导入」，关闭后预览数据保留在内存直至下次解析
  const [previewOpen, setPreviewOpen] = useState(false);
  // 用户自定义资金流向规则（存本机 settings，kv.importRules）
  const [rules, setRules] = useState<ImportRule[]>(() => loadImportRules());
  const [rulesOpen, setRulesOpen] = useState(false);
  // 解析原值快照（rowKey → 解析时的 ImportRow）：导入时与修正后行对比，
  // 识别「用户手动改动」以自动学习资金流向规则；AI 智能归类填充不算用户修正，一并更新基线
  const origRowsRef = useRef<Map<string, ImportRow>>(new Map());

  // 载入导入历史（审计）
  useEffect(() => {
    void listImportLogs().then(setImportHist).catch(() => { /* 桌面库不可用时静默 */ });
  }, []);

  /** 将单个文件的二进制解析为二维数组（csv 需解码，xlsx 用 SheetJS 读取） */
  async function bufferToAoa(buf: Uint8Array, name: string): Promise<unknown[][]> {
    if (/\.(csv|txt)$/i.test(name)) return parseCsvText(decodeText(buf));
    try {
      const { read, utils } = await import('xlsx');
      const wb = read(buf, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      return utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' }) as unknown[][];
    } catch (e) {
      throw new Error(`「${name}」不是有效的 Excel 文件（可能是加密文件，需提供解压密码或以明文重新导出）：${(e as Error).message}`);
    }
  }

  /** 统一提交解析结果：刷新参考、行数据、警告、将建账户、疑似重复。供初次解析与列映射重解析共用。
   *  skippedRows 为被规则跳过的候补行（保留原始字段，需用户手动恢复为真实类型后才导入）。 */
  async function commitParsed(rows: ImportRow[], warn: string[], extraNote = '', skippedRows: ImportRow[] = []) {
    const refs2 = await getImportReferences();
    setRefs(refs2);
    // 正常行排在前面，被跳过的行追加在尾部并做标记
    const merged = [...rows, ...skippedRows];
    setRows(merged);
    // 建立「解析原值」基线：后续与用户修正后对比，识别手动改动以自动学习规则
    origRowsRef.current = new Map(merged.map((r) => [rowKeyOf(r), r]));
    setParseWarn(warn);
    // 计算「将被自动创建」的账户（正常行 + 被恢复的跳过行都会用到，一并统计）
    const accNames = [...new Set(merged.map((r) => normalizeAccountName(r.account)).filter(Boolean))];
    setPendingAccounts(
      accNames
        .filter((n) => !(refs2.accounts ?? []).some((a) => accountsMatch(a.name, n)))
        .filter((n) => n !== '未识别账户' && n !== '导入账户')
    );
    // 标注疑似重复行：订单号已在库/批内，或批内无订单号同指纹
    const seenOrder = new Set<string>(refs2.existingOrderNos ?? []);
    const batchOrder = new Set<string>();
    const batchNoOrder = new Set<string>();
    const dup = new Set<number>();
    for (const r of rows) {
      const order = String(r.orderNo ?? '').trim();
      if (order) {
        if (seenOrder.has(order) || batchOrder.has(order)) dup.add(r.line);
        batchOrder.add(order);
      } else {
        const fp = rowFingerprint({ date: r.date, type: r.type, amount: r.amount, account: r.account, note: r.note });
        if (batchNoOrder.has(fp)) dup.add(r.line);
        batchNoOrder.add(fp);
      }
    }
    setDupLines(dup);
    if (rows.length === 0 && skippedRows.length === 0) {
      toast.warning('未解析到可导入的交易（请检查文件格式或解压密码）');
      return;
    }
    const skipCount = skippedRows.length;
    toast.success(`解析到 ${rows.length} 条交易${skipCount ? `，另有 ${skipCount} 条被跳过（可手动恢复）` : ''}。${refs2.accounts.length} 个账户、${refs2.categories.length} 个分类可用于匹配。`);
    if (dup.size) toast.warning(`检测到 ${dup.size} 条疑似重复流水，导入时将被自动跳过。`);
    // 识别成功：弹窗集中展示解析结果（概要 + 可编辑预览 + 开始导入）
    setPreviewOpen(true);
  }

  /** 解析一个已就绪的源文件（非 zip 或已解密 zip）为交易行，供导入流程使用 */
  async function parseSourceFile(name: string, binary: Uint8Array, fileCount: number): Promise<{ rows: ImportRow[]; skippedRows: ImportRow[]; warn: string[] } | null> {
    let aoa: unknown[][];
    try {
      aoa = await bufferToAoa(binary, name);
    } catch (err) {
      return { rows: [], skippedRows: [], warn: [(err as Error).message] };
    }
    const bill = parseBillAOA(aoa, loadImportRules());
    const skipped: string[] = [];
    if (bill.detected) {
      bill.skipped.forEach((s) => skipped.push(s));
      return { rows: bill.rows, skippedRows: bill.skippedRows, warn: skipped.map((s) => `「${name}」跳过 1 行：${s}`) };
    }
    // 自定义模板：自动推断列映射；单文件时保留表头供用户手动调整
    const headerRow = aoa.find((r) => (r as unknown[]).some((c) => String(c ?? '').trim() !== '')) ?? [];
    const header = (headerRow as unknown[]).map((c) => String(c ?? '').trim());
    const map = buildColumnMap(header);
    if (fileCount === 1) {
      setColHeader(header);
      setColMap(map);
      setMapAoa(aoa);
    }
    const p = parseAoaWithMap(aoa, map, 0, loadImportRules());
    return { rows: p.rows, skippedRows: [], warn: p.skipped.map((s) => `「${name}」跳过 1 行：${s}`) };
  }

  async function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!files.length) return;
    fileMeta.current = { names: files.map((f) => f.name).join('，'), count: files.length };
    // 若这批里有加密 zip（待解密），先弹密码对话框让用户输入后再逐文件解析；否则直接全量解析
    await processFiles(files, password);
  }

  /** 用指定密码处理一批文件：加密 zip 先解密，再解析为交易行并提交 */
  async function processFiles(files: File[], pwd: string) {
    setBusy(true);
    try {
      const allRows: ImportRow[] = [];
      const allSkipped: ImportRow[] = [];
      const allWarn: string[] = [];
      let needPwd: { file: File } | null = null;
      // 行唯一标识盖章：rowKeyOf 默认用「文件内行号」，多文件合并时不同文件相同行号会互相覆盖，
      // 导致自动学习基线 / 待核对定位错位——故按文件序号盖章，保证跨文件唯一
      let fileIdx = 0;
      const stampRows = (rows: ImportRow[]) => {
        rows.forEach((r) => {
          r._rowKey = `${fileIdx}:${r.line}${r._rowKey ? `:${r._rowKey}` : ''}`;
        });
      };
      for (const file of files) {
        const binary = new Uint8Array(await file.arrayBuffer());
        // 明文/非加密源文件（含 xlsx 本体的 zip）：直接解析
        if (!isZip(binary)) {
          const r = await parseSourceFile(file.name, binary, files.length);
          if (r) {
            stampRows(r.rows); stampRows(r.skippedRows);
            allRows.push(...r.rows); allSkipped.push(...r.skippedRows); allWarn.push(...r.warn);
          }
          fileIdx++;
          continue;
        }
        // zip：判断加密方式与解压
        const kind = detectZipEncryption(binary);
        if (kind?.aes) {
          allWarn.push(`「${file.name}」使用 WinZip AES 加密，本机暂不支持直接解密。请到导出端选择「明文」或「zip 密码版」重新导出。`);
          fileIdx++;
          continue;
        }
        const ex = tryExtractZip(binary, pwd);
        if (ex.ok) {
          const r = await parseSourceFile(ex.name, ex.data, files.length);
          if (r) {
            stampRows(r.rows); stampRows(r.skippedRows);
            allRows.push(...r.rows); allSkipped.push(...r.skippedRows); allWarn.push(...r.warn);
          }
          fileIdx++;
          continue;
        }
        // zip 炸弹防护：超过上限时给出专门提示，避免误导为「损坏/密码错误」
        if (ex.reason === 'too_large') {
          allWarn.push(`「${file.name}」压缩包超过安全上限（文件大小/条目数/解压体积），已拒绝解压。`);
          fileIdx++;
          continue;
        }
        if (kind?.encrypted) {
          // 加密 zip 需要密码：若已提供仍失败说明密码错误；未提供则等待输入。先记录第一个待处理文件
          needPwd ??= { file };
        } else {
          allWarn.push(`「${file.name}」该 zip 内容无法识别（可能已损坏），请重新导出明文。`);
        }
        fileIdx++;
      }

      // 存在加密 zip 且未成功解密 → 弹出密码对话框（若用户刚在框里填过密码则提示错误）
      if (needPwd && allRows.length === 0) {
        setPwdModal({ file: needPwd.file, text: pwd, error: pwd ? '解压失败：密码不正确或文件损坏，请重新输入解压密码。' : undefined });
        return;
      }
      await commitParsed(allRows, allWarn, '', allSkipped);
    } catch (err) {
      toast.error(`解析失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  /** 用户在密码对话框的输入变化 */
  function updatePwdText(text: string) {
    setPwdModal((m) => (m ? { ...m, text, error: undefined } : m));
  }

  /** 确认密码对话框：用输入的密码重新解密并解析 */
  async function confirmPwd() {
    if (!pwdModal) return;
    const { file, text } = pwdModal;
    setPwdModal(null);
    try {
      const binary = new Uint8Array(await file.arrayBuffer());
      const kind = detectZipEncryption(binary);
      const ex = tryExtractZip(binary, text);
      if (!ex.ok) {
        // 密码仍错 → 保留对话框让你继续改
        setPwdModal({ file, text, error: '解压失败：密码不正确，请重试。' });
        return;
      }
      const r = await parseSourceFile(ex.name, ex.data, 1);
      await commitParsed(r?.rows ?? [], r?.warn ?? []);
    } catch (err) {
      toast.error(`解析失败：${(err as Error).message}`);
    }
  }

  /** 应用手动列映射：用 mapAoa + 当前 colMap 重新解析并刷新预览（仅自定义模板单文件） */
  async function applyColMap() {
    if (!mapAoa) return;
    setBusy(true);
    try {
      const p = parseAoaWithMap(mapAoa, colMap, 0, loadImportRules());
      const rows = p.rows.map((r, i) => ({ ...r, line: i + 1 }));
      await commitParsed(rows, p.skipped, '（已按列映射重新解析）');
    } catch (e) {
      toast.error(`按列映射解析失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  /** 更新某个业务字段对应的表头列 */
  function setFieldColumn(field: ImportFieldKey, colIdx: number) {
    setColMap((prev) => {
      const next = { ...prev };
      if (colIdx === -1) delete next[field];
      else next[field] = colIdx;
      return next;
    });
  }

  async function downloadTemplate() {
    // 动态加载 xlsx 以生成模板（避免顶层静态引包影响首屏体积）
    // 列与 IMPORT_FIELD_LABELS 的 12 个业务字段对齐（含支付时间/付款方式/收款方/订单号/商家订单号 5 个明细字段），
    // 表头命名须能被 buildColumnMap 的别名自动识别，用户填好后选择文件导入即可自动推断列映射。
    // 历史缺陷：xlsx.writeFile 依赖 blob + <a download>，在 Tauri WebView2 中触发下载不可靠 → 点击无反应；
    // 桌面端改为弹系统保存对话框、经 fs 插件写真实文件；浏览器预览回退 blob 下载。
    try {
      const X = await import('xlsx');
      const aoa = [
        ['日期', '类型', '金额', '账户', '转入账户', '分类', '备注', '支付时间', '付款方式', '收款方', '订单号', '商家订单号'],
        ['2026-09-01', '支出', '35.5', '微信', '', '餐饮', '午饭', '2026-09-01 12:30:00', '微信支付', '某快餐店', 'D20260901001', 'M20260901001'],
        ['2026-09-02', '收入', '8000', '银行卡', '', '工资', '9月工资', '2026-09-02 09:00:00', '银行卡', '某公司', '', ''],
        ['2026-09-03', '转账', '500', '银行卡', '微信', '', '转零钱', '2026-09-03 10:00:00', '', '', '', ''],
        ['2026-09-04', '负债减少', '99', '信用卡', '', '还款', '信用卡还款', '2026-09-04 15:20:00', '银行卡', '招商银行', '', ''],
      ];
      const ws = X.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 8 }, { wch: 14 }, { wch: 20 }, { wch: 10 }, { wch: 12 }, { wch: 16 }, { wch: 16 }];
      const wb = X.utils.book_new();
      X.utils.book_append_sheet(wb, ws, '导入模板');
      const out = X.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
      const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
      if (isTauri) {
        const { save } = await import('@tauri-apps/plugin-dialog');
        const { writeFile } = await import('@tauri-apps/plugin-fs');
        const path = await save({
          defaultPath: 'moneybook-导入模板.xlsx',
          filters: [{ name: 'Excel 模板', extensions: ['xlsx'] }],
        });
        if (!path) return; // 用户取消
        await writeFile(path, new Uint8Array(out));
        toast.success('模板已保存，填写后选择文件导入即可');
      } else {
        const blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'moneybook-导入模板.xlsx';
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      toast.error(`模板下载失败：${(e as Error).message}`);
    }
  }

  /** 逐行纠错：解析/匹配结果可改账户、类型、分类等，导入前修正误判。
   *  按「行唯一标识」匹配——同一账单行可能派生多行（如提现的本金 + 服务费）。 */
  function patchRow(key: string, patch: Partial<ImportRow>) {
    setRows((prev) => prev.map((r) => (rowKeyOf(r) === key ? { ...r, ...patch } : r)));
  }

  /** 确认某「待确认」行（退款/提现去向已核对无误，清除提醒标记） */
  function confirmRow(key: string) {
    patchRow(key, { _pending: undefined });
  }

  /** 删除某待导入行（误判严重可直接移出本次导入） */
  function removeRow(key: string) {
    setRows((prev) => prev.filter((r) => rowKeyOf(r) !== key));
  }

  const validRows = rows.filter((r) => !r._skippedReason);
  const total = validRows.reduce((s, r) => (r.type === 'expense' ? s + r.amount : s), 0);
  // 待确认行：去向（退款到账账户 / 提现到账卡）账单无法 100% 保证，需用户核对
  const pendingRows = validRows.filter((r) => r._pending);

  /** 改名「将创建账户」：同步改写所有使用该账户名的待导入行 */
  function renamePending(oldName: string, newName: string) {
    setPendingAccounts((prev) => prev.map((n) => (n === oldName ? newName : n)));
    setRows((prev) => prev.map((r) => (r.account === oldName ? { ...r, account: newName } : r)));
  }

  /** AI/本地「智能归类」：为缺分类/账户的行按备注/收款方推荐并补全。
   *  隐私：未开「允许发送明细」时仅用本地规则（零外泄）；上云时文本先脱敏。 */
  async function aiClassifyRows() {
    const targets = rows.filter((r) => !r.category || !r.account);
    if (!targets.length) { toast.info('所有行都已补齐分类与账户'); return; }
    setClassifying(true);
    try {
      const refs2 = await getImportReferences();
      const accs = refs2.accounts.map((a) => ({ id: a.id, name: a.name }));
      let filledCat = 0; let filledAcc = 0;
      for (const r of targets) {
        const txt = `${r.payee || ''} ${r.note || ''}`.trim() || r.note || '';
        if (!txt) continue;
        // 分类按该行类型过滤，避免误补其他类型
        const typeCats = refs2.categories.filter((c) => c.type === r.type).map((c) => c.name);
        const res = await suggestForText(txt, { categories: typeCats, accounts: accs });
        const patch: Partial<ImportRow> = {};
        if (!r.category && res.categories.length) { patch.category = res.categories[0].name; filledCat++; }
        if (!r.account && res.account) { patch.account = res.account.name; filledAcc++; }
        if (Object.keys(patch).length) {
          patchRow(rowKeyOf(r), patch);
          // AI 填充不算用户修正：同步更新解析基线，避免把 AI 推荐误当作用户改动学成规则
          const key = rowKeyOf(r);
          const prev = origRowsRef.current.get(key);
          if (prev) origRowsRef.current.set(key, { ...prev, ...patch });
        }
      }
      toast.success(`已按推荐补全 ${filledCat} 个分类、${filledAcc} 个账户${(filledCat + filledAcc) === 0 ? '（所有匹配需手动处理）' : ''}`);
    } catch (e) {
      toast.error(`智能归类失败：${(e as Error).message}`);
    } finally {
      setClassifying(false);
    }
  }

  /** 按已入库流水重算真实账户（现金/银行/电子钱包/信用/储蓄）余额：
   *  导入不改变账户余额，需此动作补齐各账户余额与流水一致 */
  async function recalcAccounts() {
    setRecalcBusy(true);
    try {
      const changed = await recalcAccountBalances();
      if (changed.length) {
        toast.success(
          `已重算 ${changed.length} 个账户：${changed.map((c) => `${c.name} ${c.before.toFixed(2)} → ${c.after.toFixed(2)}`).join('；')}`,
          { duration: 6000 }
        );
      } else {
        toast.success('各账户余额已与流水一致，无需调整');
      }
    } catch (e) {
      toast.error(`重算失败：${(e as Error).message}`);
    } finally {
      setRecalcBusy(false);
    }
  }

  /**
   * 把若干「用户修正」自动沉淀为资金流向规则（幂等合并、纯本地、可编辑/停用），并写审计。
   * 读最新规则集（而非组件内存态，避免覆盖其他入口的改动），合并后回写并刷新 UI。
   * @returns 本次实际学习/更新的关键词列表（为空表示无需学习）
   */
  async function applyLearnedRules(candidates: LearnedRuleCandidate[]): Promise<string[]> {
    if (!candidates.length) return [];
    let next = loadImportRules();
    const learned: LearnedRuleCandidate[] = [];
    for (const c of candidates) {
      const r = learnRuleFromCorrection(next, c);
      if (r.changed) { next = r.rules; learned.push(c); }
    }
    if (!learned.length) return [];
    saveImportRules(next);
    setRules(next);
    console.log('[导入规则学习] 沉淀规则：', learned.map((c) => `${c.match} → ${c.type}${c.account ? '/' + c.account : ''}${c.toAccount ? '→' + c.toAccount : ''}${c.category ? '(' + c.category + ')' : ''}`).join('；'));
    // 审计联动：记录学习动作，供「用户纠正→回写规则」闭环可观测
    for (const c of learned) {
      void recordAudit({
        kind: 'rule_learned',
        source: 'rule',
        action: '自动学习导入规则',
        after: JSON.stringify(c),
        basis: '用户在导入中手动修正归类后自动沉淀为资金流向规则（可编辑/停用）',
        method: 'import-learn',
      });
    }
    return learned.map((c) => c.match);
  }

  async function doImport() {
    if (!validRows.length) return toast.error('请先选择并解析文件');
    setBusy(true);
    try {
      // 只导入「有效行」：被规则跳过、尚未手动恢复的行留在列表里等用户处理
      let finalRows = validRows;
      if (assignAccount !== '0' && refs) {
        const target = refs.accounts.find((a) => String(a.id) === assignAccount);
        if (target) finalRows = validRows.map((r) => ({ ...r, account: target.name }));
      }
      const byKey = new Map(finalRows.map((r) => [rowKeyOf(r), r]));
      const res = await bulkImportTransactions(finalRows, { autoCreate });
      let msg = `成功导入 ${res.imported} 条交易`;
      if (res.createdAccounts.length) msg += `，自动创建账户 ${res.createdAccounts.length} 个`;
      if (res.createdCategories.length) msg += `，自动创建分类 ${res.createdCategories.length} 个`;
      if (res.skipped.length) msg += `，跳过 ${res.skipped.length} 条${res.duplicates ? `（其中 ${res.duplicates} 条疑似重复）` : ''}`;
      toast.success(msg);
      if (res.skipped.length) {
        const first = res.skipped.slice(0, 6).map((s) => `第${s.line}行：${s.reason}`).join('\n');
        toast.warning(`部分行被跳过：\n${first}${res.skipped.length > 6 ? `\n…共 ${res.skipped.length} 条` : ''}`, { duration: 6000 });
      }
      // 刷新参考数据（可能新建了账户/分类），供「导入后待核对」的账户下拉使用
      const refs2 = await getImportReferences();
      setRefs(refs2);
      // 组装「导入后待核对」：仅可疑行（去向为账单推测），携带库中交易 id 供就地修正
      const items: ReconItem[] = [];
      for (const ir of res.importedRows) {
        if (!ir.pending) continue;
        const src = byKey.get(ir.rowKey);
        if (!src) continue;
        items.push({ id: ir.id, line: ir.line, pending: ir.pending, src, type: src.type, accountId: ir.accountId, toAccountId: ir.toAccountId });
      }
      setRecon(items);
      // 导入为余额中性 → 自动按流水重算全部真实账户余额，使账户余额与流水一致
      try {
        const changed = await recalcAccountBalances();
        if (changed.length) toast.success(`已按流水自动重算 ${changed.length} 个账户余额`, { duration: 6000 });
      } catch (e) {
        toast.warning(`余额重算未完成：${(e as Error).message}（可用「重算账户余额」手动重试）`);
      }
      // 写入导入审计，并刷新历史（审计失败不影响导入本身）
      try {
        await recordImportLog({
          fileName: fileMeta.current.names, fileCount: fileMeta.current.count,
          imported: res.imported, skipped: res.skipped.length, duplicates: res.duplicates,
          createdAccounts: res.createdAccounts.length, createdCategories: res.createdCategories.length,
        });
        const hist = await listImportLogs();
        setImportHist(hist);
      } catch { /* 写入审计失败可忽略 */ }
      // —— 导入规则自动学习 ——
      // 用户修正了类型/账户/分类的行导入成功后，自动沉淀为资金流向规则（幂等合并、纯本地、可编辑/停用）。
      // 仅学习真正落库的行；「整批归入账户」的批量覆盖不算逐商户修正，不学账户。
      try {
        const importedKeys = new Set(res.importedRows.map((ir) => ir.rowKey));
        const candidates: LearnedRuleCandidate[] = [];
        const bulkAssign = assignAccount !== '0';
        for (const r of finalRows) {
          if (!importedKeys.has(rowKeyOf(r))) continue;
          const orig = origRowsRef.current.get(rowKeyOf(r));
          if (!orig) continue;
          if (!shouldLearnCorrection(orig, r, { ignoreAccount: bulkAssign })) continue;
          const match = pickRuleKeyword(r);
          if (!match) continue;
          const c: LearnedRuleCandidate = { match, type: r.type };
          if (!bulkAssign && r.account && r.account !== orig.account) c.account = r.account;
          if (r.toAccount && r.toAccount !== orig.toAccount) c.toAccount = r.toAccount;
          if (r.category && r.category !== orig.category) c.category = r.category;
          candidates.push(c);
        }
        const learned = await applyLearnedRules(candidates);
        if (learned.length) {
          toast.success(`已自动学习 ${learned.length} 条资金流向规则：${learned.join('、')}（可在「资金流向判定规则」中查看/停用）`, { duration: 6000 });
        }
      } catch { /* 学习失败不影响导入结果 */ }
      // 保留仍未恢复的「被跳过行」（等用户手动恢复），其余已入库行清空
      setRows((prev) => prev.filter((r) => r._skippedReason));
      setDupLines(new Set());
      setParseWarn([]);
      // 导入完成：关闭解析结果弹窗，回到页面顶部的选择文件入口
      setPreviewOpen(false);
    } catch (err) {
      toast.error(`导入失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  /** 更新某「待核对」项的本地选择（类型 / 账户 / 转入账户），点「保存」时才回写库 */
  function patchRecon(id: number, patch: Partial<Pick<ReconItem, 'type' | 'accountId' | 'toAccountId'>>) {
    setRecon((prev) => prev.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  }

  /** 保存「待核对」项：按修正后的类型/账户回写库中交易（updateTransaction 会同步账户余额） */
  async function saveRecon(item: ReconItem) {
    if (!item.src.date) { toast.error(`第${item.line}行缺少有效日期，请到交易列表编辑`); return; }
    if (item.type === 'transfer') {
      if (!item.toAccountId) { toast.error('转账需选择转入账户'); return; }
      if (item.toAccountId === item.accountId) { toast.error('转出与转入账户不能相同'); return; }
    }
    const cat = refs?.categories.find((c) => c.name === item.src.category && c.type === item.type);
    try {
      await updateTransaction(item.id, {
        type: item.type,
        amount: item.src.amount,
        accountId: item.accountId,
        toAccountId: item.type === 'transfer' ? item.toAccountId ?? undefined : undefined,
        categoryId: cat?.id,
        date: item.src.date,
        note: item.src.note,
        payTime: item.src.payTime,
        payMethod: item.src.payMethod,
        payee: item.src.payee,
        orderNo: item.src.orderNo,
        merchantOrderNo: item.src.merchantOrderNo,
      });
      setRecon((prev) => prev.filter((x) => x.id !== item.id));
      toast.success(`第${item.line}行已修正`);
      // —— 导入规则自动学习 ——
      // 用户就地修正可疑行的类型/账户后，自动沉淀为资金流向规则（幂等合并、纯本地、可编辑/停用）。
      // 分类/备注在待核对中不可编辑，不参与学习；仅把与解析原值不同的字段写入规则。
      try {
        const match = pickRuleKeyword(item.src);
        const cur: ImportRow = {
          ...item.src,
          type: item.type,
          account: refs?.accounts.find((a) => a.id === item.accountId)?.name ?? item.src.account,
          toAccount: item.type === 'transfer'
            ? (refs?.accounts.find((a) => a.id === item.toAccountId)?.name ?? item.src.toAccount)
            : undefined,
        };
        if (match && shouldLearnCorrection(item.src, cur)) {
          const c: LearnedRuleCandidate = { match, type: item.type };
          if (cur.account && cur.account !== item.src.account) c.account = cur.account;
          if (item.type === 'transfer' && cur.toAccount && cur.toAccount !== item.src.toAccount) c.toAccount = cur.toAccount;
          const learned = await applyLearnedRules([c]);
          if (learned.length) toast.info(`已学习规则「${match}」：同类导入将自动按此归类（可编辑/停用）`, { duration: 6000 });
        }
      } catch { /* 学习失败不影响修正结果 */ }
    } catch (e) {
      toast.error(`修正失败：${(e as Error).message}`);
    }
  }

  /** 新增一条空白资金流向规则（默认支出，关键词留空待填） */
  function addRule() {
    setRules((prev) => [...prev, { match: '', type: 'expense', enabled: true }]);
  }

  /** 编辑规则字段 */
  function patchRule(i: number, patch: Partial<ImportRule>) {
    setRules((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  /** 删除规则 */
  function removeRule(i: number) {
    setRules((prev) => prev.filter((_, idx) => idx !== i));
  }

  /** 保存规则到本机（丢弃关键词为空的项）；下次选择文件解析时生效 */
  function persistRules() {
    const valid = rules.filter((r) => r.match.trim());
    setRules(valid);
    saveImportRules(valid);
    toast.success(`已保存 ${valid.length} 条规则（下次选择文件解析时生效）`);
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <h3 className="mb-1 flex items-center gap-1.5 font-semibold">
          Excel / CSV 批量导入
          <Hint text="支持 .xlsx / .xls / .csv 及支付宝、微信加密账单（zip 可输入解压密码，本机解密不上传）。可一次选择多个文件；下载模板填写后导入。「类型」填 收入 / 支出 / 转账 / 负债减少，「账户」按名称匹配当前账本，缺失的账户与分类可自动创建。" />
        </h3>
        {/* 余额中性是用户易踩坑的关键点，保留为一行醒目提示（不折叠） */}
        <p className="mb-3 text-xs text-[var(--color-warning,#F59E0B)]">
          导入为余额中性：仅写入流水与统计，不改变账户当前余额；导入成功后会按流水自动重算账户余额（也可用「重算账户余额」手动执行）。
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" onClick={downloadTemplate}>下载模板</Button>
          <label className="cursor-pointer rounded-lg border border-[var(--color-primary)] px-3 py-1.5 text-sm text-[var(--color-primary-fg)] hover:bg-[var(--color-primary)]/10">
            选择文件导入
            <input
              type="file"
              multiple
              accept=".xlsx,.xls,.csv,.zip,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              onChange={handleFiles}
            />
          </label>
          <div className="flex items-center gap-1.5 text-sm text-muted">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="加密账单解压密码（可选）"
              className="h-8 w-44 rounded-lg border border-[var(--border)] bg-[var(--card)] px-2 text-sm"
            />
          </div>
          <label className="flex cursor-pointer items-center gap-1.5 text-sm text-muted">
            <input type="checkbox" checked={autoCreate} onChange={(e) => setAutoCreate(e.target.checked)} />
            自动创建缺失的账户 / 分类
          </label>
          {refs && refs.accounts.length > 0 && (
            <label className="flex items-center gap-1.5 text-sm text-muted">
              归入账户
              <select
                value={assignAccount}
                onChange={(e) => setAssignAccount(e.target.value)}
                className="h-8 rounded-lg border border-[var(--border)] bg-[var(--card)] px-1.5 text-sm"
              >
                <option value="0">自动（按账户/支付方式匹配或创建）</option>
                {refs.accounts.map((a) => <option key={a.id} value={String(a.id)}>{a.name}</option>)}
              </select>
            </label>
          )}
          <Button size="sm" onClick={doImport} disabled={!validRows.length || busy}>{busy ? '导入中…' : `导入 ${validRows.length} 条`}</Button>
          <Button type="button" variant="outline" size="sm" onClick={aiClassifyRows} disabled={!validRows.length || classifying} title="为缺分类/账户的行按备注智能补全（未开可发送明细时仅本地规则）">
            {classifying ? '归类中…' : '智能归类'}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={recalcAccounts} disabled={recalcBusy} title="按已入库流水重算现金/银行/电子钱包/信用/储蓄等真实账户余额：导入为余额中性，需此动作才能补齐">
            {recalcBusy ? '重算中…' : '重算账户余额'}
          </Button>
        </div>
        {/* 资金流向判定规则：用户规则优先于内置识别（存本机 settings，kv.importRules），可解释、可复用 */}
        <div className="mt-3 rounded-lg border border-[var(--border)] p-2">
          <button type="button" onClick={() => setRulesOpen((v) => !v)} className="text-xs font-medium hover:underline">
            资金流向判定规则（{rules.length} 条，可自定义）{rulesOpen ? ' ▲' : ' ▼'}
          </button>
          {rulesOpen && (
            <div className="mt-2 space-y-2">
              <div className="text-xs text-muted">
                命中关键词（包含匹配）时按此规则判定资金流向，优先级高于内置识别（还款/退款/提现/收支方向）；可把某商家或某说明文本固定归到某类型、某账户或某分类。
                在预览里修正行的类型/账户/分类并导入，或在「导入后待核对」保存修正后，会自动沉淀为规则（幂等合并；已停用的规则不会被自动覆盖）。
              </div>
              {rules.length === 0 && <div className="text-xs text-muted">暂无规则，点「添加规则」新建。</div>}
              {rules.map((r, i) => (
                <div key={i} className="flex flex-wrap items-center gap-1.5 text-xs">
                  <input value={r.match} onChange={(e) => patchRule(i, { match: e.target.value })} placeholder="关键词"
                    className="h-7 w-28 rounded border border-[var(--border)] bg-[var(--bg)] px-1" />
                  <select value={r.type} onChange={(e) => patchRule(i, { type: e.target.value as ImportRule['type'] })}
                    className="h-7 rounded border border-[var(--border)] bg-[var(--bg)] px-1 [color-scheme:inherit]">
                    {IMPORT_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <input value={r.account ?? ''} onChange={(e) => patchRule(i, { account: e.target.value || undefined })} placeholder="账户(可空)"
                    className="h-7 w-28 rounded border border-[var(--border)] bg-[var(--bg)] px-1" />
                  <input value={r.toAccount ?? ''} onChange={(e) => patchRule(i, { toAccount: e.target.value || undefined })} placeholder="转入账户(转账用)"
                    className="h-7 w-28 rounded border border-[var(--border)] bg-[var(--bg)] px-1" />
                  <input value={r.category ?? ''} onChange={(e) => patchRule(i, { category: e.target.value || undefined })} placeholder="分类(可空)"
                    className="h-7 w-24 rounded border border-[var(--border)] bg-[var(--bg)] px-1" />
                  <label className="flex items-center gap-1">
                    <input type="checkbox" checked={r.enabled !== false} onChange={(e) => patchRule(i, { enabled: e.target.checked })} />
                    启用
                  </label>
                  <button type="button" onClick={() => removeRule(i)} title="删除该规则"
                    className="flex h-6 w-6 items-center justify-center rounded-md text-sm text-muted hover:bg-[var(--color-danger)]/10 hover:text-[var(--color-danger)]">✕</button>
                </div>
              ))}
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={addRule}>+ 添加规则</Button>
                <Button type="button" size="sm" onClick={persistRules}>保存规则</Button>
              </div>
            </div>
          )}
        </div>
        {/* 列映射预览：自定义模板/单文件时可手动指认表头列到业务字段 */}
        {colHeader.length > 0 && (
          <div className="mt-3 rounded-lg border border-[var(--border)] p-2">
            <button type="button" onClick={() => setMapOpen((v) => !v)} className="text-xs font-medium hover:underline">
              列映射预览（自定义模板，可调整）{mapOpen ? ' ▲' : ' ▼'}
            </button>
            {mapOpen && (
              <div className="mt-2">
                <div className="mb-1 text-xs text-muted">把表格列指认到业务字段（「不导入」表示忽略该字段）：</div>
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  {(Object.keys(IMPORT_FIELD_LABELS) as ImportFieldKey[]).map((field) => (
                    <label key={field} className="flex items-center justify-between gap-2 text-xs">
                      <span className="text-muted">{IMPORT_FIELD_LABELS[field]}</span>
                      <select
                        value={String(colMap[field] ?? -1)}
                        onChange={(e) => setFieldColumn(field, Number(e.target.value))}
                        className="h-7 w-full max-w-[150px] rounded border border-[var(--border)] bg-[var(--card)] px-1 text-xs"
                      >
                        <option value="-1">（不导入）</option>
                        {colHeader.map((h, idx) => (
                          <option key={idx} value={String(idx)}>{h || `列${idx + 1}`}</option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
                <div className="mt-2 flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setColMap(buildColumnMap(colHeader))}>还原自动</Button>
                  <Button size="sm" disabled={busy} onClick={() => void applyColMap()}>{busy ? '解析中…' : '应用映射'}</Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 导入后待核对：可疑行已按账单推测口径入库，此处就地改类型/账户并回写该交易 */}
      {recon.length > 0 && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">导入后待核对（{recon.length} 条）</h3>
            <span className="text-xs text-muted">这些行已按账单推测口径入库；若去向不符，改类型/账户后点「保存」修正该交易。</span>
          </div>
          <div className="max-h-80 overflow-auto rounded-lg border border-[var(--border)]">
            <table className="w-full min-w-[640px] table-fixed text-sm">
              <thead className="sticky top-0 z-10 bg-[var(--bg)] text-left text-xs font-semibold text-[var(--fg)] shadow-[0_1px_0_0_var(--border)]">
                <tr>
                  <th className="w-12 px-2 py-2">行</th>
                  <th className="w-28 px-2 py-2">日期</th>
                  <th className="w-24 px-2 py-2">类型</th>
                  <th className="w-28 px-2 py-2 text-right">金额</th>
                  <th className="px-2 py-2">账户</th>
                  <th className="hidden px-2 py-2 sm:table-cell">转入</th>
                  <th className="w-32 px-2 py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {recon.map((it) => (
                  <tr key={it.id} className="border-t border-[var(--border)] bg-[var(--color-warning,#F59E0B)]/8">
                    <td className="px-2 py-1.5 text-[var(--color-warning,#F59E0B)]" title={it.pending}>⚠ {it.line}</td>
                    <td className="px-2 py-1.5">{it.src.date || '—'}</td>
                    <td className="px-2 py-1.5">
                      <select
                        value={it.type}
                        onChange={(e) => patchRecon(it.id, {
                          type: e.target.value as ImportRow['type'],
                          toAccountId: e.target.value === 'transfer' ? it.toAccountId : null,
                        })}
                        className="h-7 rounded border border-[var(--border)] bg-transparent px-1 text-xs [color-scheme:inherit]"
                      >
                        {IMPORT_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </td>
                    <td className="px-2 py-1.5 text-right font-medium">{['income', 'repay_in'].includes(it.type) ? '+' : '-'}{formatMoney(it.src.amount)}</td>
                    <td className="px-2 py-1.5">
                      <select
                        value={String(it.accountId)}
                        onChange={(e) => patchRecon(it.id, { accountId: Number(e.target.value) })}
                        className="h-7 w-full min-w-0 rounded border border-[var(--border)] bg-transparent px-1 text-xs [color-scheme:inherit]"
                      >
                        {(refs?.accounts ?? []).map((a) => <option key={a.id} value={String(a.id)}>{a.name}</option>)}
                      </select>
                    </td>
                    <td className="hidden px-2 py-1.5 sm:table-cell">
                      {it.type === 'transfer' ? (
                        <select
                          value={it.toAccountId == null ? '' : String(it.toAccountId)}
                          onChange={(e) => patchRecon(it.id, { toAccountId: e.target.value ? Number(e.target.value) : null })}
                          className="h-7 w-full min-w-0 rounded border border-[var(--border)] bg-transparent px-1 text-xs [color-scheme:inherit]"
                        >
                          <option value="">（选择转入账户）</option>
                          {(refs?.accounts ?? []).map((a) => <option key={a.id} value={String(a.id)}>{a.name}</option>)}
                        </select>
                      ) : <span className="text-xs text-muted">—</span>}
                    </td>
                    <td className="w-28 px-2 py-1.5">
                      <div className="flex items-center gap-1">
                        <button type="button" onClick={() => void saveRecon(it)}
                          className="rounded border border-[var(--color-primary)] px-2 py-0.5 text-xs text-[var(--color-primary-fg)] hover:bg-[var(--color-primary)]/10">保存</button>
                        <button type="button" onClick={() => setRecon((prev) => prev.filter((x) => x.id !== it.id))}
                          title="忽略：保持当前口径，移出待核对"
                          className="flex h-6 w-6 items-center justify-center rounded-md text-sm text-muted hover:bg-black/5 dark:hover:bg-white/10">✕</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {importHist.length > 0 && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
          <h3 className="mb-2 font-semibold">导入历史</h3>
          <div className="max-h-64 overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-black/5 text-left text-muted dark:bg-white/5">
                <tr>
                  <th className="px-2 py-1.5">时间</th>
                  <th className="px-2 py-1.5">文件</th>
                  <th className="px-2 py-1.5">文件数</th>
                  <th className="px-2 py-1.5">成功</th>
                  <th className="px-2 py-1.5">跳过</th>
                  <th className="px-2 py-1.5">重复</th>
                  <th className="px-2 py-1.5">建账户</th>
                  <th className="px-2 py-1.5">建分类</th>
                </tr>
              </thead>
              <tbody>
                {importHist.map((h) => (
                  <tr key={h.id} className="border-t border-[var(--border)]">
                    <td className="px-2 py-1 text-muted">{h.imported_at}</td>
                    <td className="px-2 py-1">{h.file_name}</td>
                    <td className="px-2 py-1">{h.file_count}</td>
                    <td className="px-2 py-1">{h.imported}</td>
                    <td className="px-2 py-1">{h.skipped}</td>
                    <td className="px-2 py-1 text-[var(--color-warning,#F59E0B)]">{h.duplicates}</td>
                    <td className="px-2 py-1">{h.created_accounts}</td>
                    <td className="px-2 py-1">{h.created_categories}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 解析结果弹窗：选择文件识别成功后集中展示（用户要求，避免预览大表格挤在页面）。
          弹窗内可编辑修正误判，确认后直接「开始导入」；关闭仅收起弹窗，预览数据保留在内存。 */}
      <Modal open={previewOpen} onClose={() => setPreviewOpen(false)} title={`导入解析结果（${validRows.length} 条）`}>
        <div className="space-y-3">
          {/* 概要：识别 / 跳过 / 疑似重复 / 待确认 */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            <span>识别 <b className="text-[var(--fg)]">{validRows.length}</b> 条</span>
            <span>支出合计 <b className="text-[var(--fg)]">{formatMoney(total)}</b></span>
            {pendingRows.length > 0 && (
              <span className="text-[var(--color-warning,#F59E0B)]">⚠ {pendingRows.length} 行去向为账单推测（导入后待核对）</span>
            )}
            {dupLines.size > 0 && (
              <span className="text-[var(--color-warning,#F59E0B)]">● {dupLines.size} 条疑似重复（导入时自动跳过）</span>
            )}
          </div>
          {parseWarn.length > 0 && (
            <div className="rounded-lg border-l-4 border-[var(--color-warning,#F59E0B)] bg-[var(--color-warning,#F59E0B)]/10 px-3 py-2 text-xs leading-relaxed text-[var(--fg)]">
              <div className="mb-1 font-medium text-[var(--color-warning,#F59E0B)]">导入待确认（部分行被跳过或解析未识别）</div>
              {parseWarn.slice(0, 6).map((w, i) => <div key={i} className="text-muted">{w}</div>)}
              {parseWarn.length > 6 && <div className="text-muted">…共 {parseWarn.length} 条未解析</div>}
            </div>
          )}
          {/* 将自动创建的账户：可改名到已有账户以复用，避免误建重复账户 */}
          {pendingAccounts.length > 0 && (
            <div>
              <div className="mb-1 text-xs text-muted">导入时将自动创建账户（可改名到已有账户以复用，避免重复）：</div>
              <div className="flex flex-wrap gap-2">
                {pendingAccounts.map((n) => (
                  <label key={n} className="flex items-center gap-1 rounded-full border border-[var(--border)] bg-black/2 px-2 py-1 text-xs dark:bg-white/5">
                    <input
                      value={n}
                      onChange={(e) => renamePending(n, e.target.value)}
                      className="w-32 rounded bg-transparent outline-none"
                    />
                  </label>
                ))}
              </div>
            </div>
          )}
          {/* 可编辑预览：修正误判后点「开始导入」 */}
          {pendingRows.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border-l-4 border-[var(--color-warning,#F59E0B)] bg-[var(--color-warning,#F59E0B)]/10 px-3 py-2 text-xs">
              <span className="text-[var(--color-warning,#F59E0B)]">
                ⚠ {pendingRows.length} 行去向为账单推测（退款到账账户 / 提现到账卡）：将按推测口径先入库，导入后可在下方「导入后待核对」逐条修正。
              </span>
              <button type="button"
                onClick={() => setRows((prev) => prev.map((r) => (r._pending ? { ...r, _pending: undefined } : r)))}
                title="这些行的推测去向已足够确定，无需导入后复核"
                className="rounded border border-[var(--color-warning,#F59E0B)] px-2 py-0.5 text-[var(--color-warning,#F59E0B)] hover:bg-[var(--color-warning,#F59E0B)]/10">
                均无需复核
              </button>
            </div>
          )}
          <div className="max-h-72 overflow-auto rounded-lg border border-[var(--border)]">
            <table className="w-full min-w-[640px] table-fixed text-sm">
              <thead className="sticky top-0 z-10 bg-[var(--bg)] text-left text-xs font-semibold text-[var(--fg)] shadow-[0_1px_0_0_var(--border)]">
                <tr>
                  <th className="w-12 px-2 py-2">行</th>
                  <th className="w-28 px-2 py-2">日期</th>
                  <th className="w-20 px-2 py-2">类型</th>
                  <th className="w-28 px-2 py-2 text-right">金额</th>
                  <th className="px-2 py-2">账户</th>
                  <th className="hidden px-2 py-2 sm:table-cell">转入</th>
                  <th className="hidden px-2 py-2 md:table-cell">分类</th>
                  <th className="hidden px-2 py-2 lg:table-cell">备注</th>
                  <th className="w-20 px-2 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const key = rowKeyOf(r);
                  const isSkipped = !!r._skippedReason;
                  const isPending = !isSkipped && !!r._pending;
                  return (
                  <tr key={key} className={`border-t border-[var(--border)] ${
                    isSkipped ? 'bg-black/2 dark:bg-white/5'
                      : isPending ? 'bg-[var(--color-warning,#F59E0B)]/8'
                      : dupLines.has(r.line) ? 'bg-[var(--color-warning,#F59E0B)]/5' : ''
                  }`}>
                    <td className="px-2 py-1.5 text-muted">
                      {dupLines.has(r.line) && <span className="mr-1 text-[var(--color-warning,#F59E0B)]" title="疑似重复导入，将被跳过">●</span>}
                      {isSkipped && <span className="mr-1 text-[var(--color-warning,#F59E0B)]" title={r._skippedReason}>⏭</span>}
                      {isPending && <span className="mr-1 text-[var(--color-warning,#F59E0B)]" title={r._pending}>⚠</span>}
                      {!isSkipped && !isPending && r.basis && (
                        <span className="mr-1 cursor-help text-[var(--color-muted)]" title={r.basis}>ℹ</span>
                      )}
                      {r.line}
                    </td>
                    <td className="px-2 py-1.5">{r.date}</td>
                    <td className="px-2 py-1.5">
                      {isSkipped && (
                        <div className="flex items-center gap-1">
                          <span className="text-xs text-[var(--color-warning,#F59E0B)]" title={r._skippedReason}>已跳过</span>
                          <button type="button"
                            onClick={() => patchRow(key, { type: 'expense', _skippedReason: undefined })}
                            className="rounded border border-[var(--color-primary)] px-1 text-xs text-[var(--color-primary-fg)] hover:bg-[var(--color-primary)]/10" title="按支出恢复">支出</button>
                          <button type="button"
                            onClick={() => patchRow(key, { type: 'income', _skippedReason: undefined })}
                            className="rounded border border-[var(--color-primary)] px-1 text-xs text-[var(--color-primary-fg)] hover:bg-[var(--color-primary)]/10" title="按收入恢复">收入</button>
                        </div>
                      )}
                      {!isSkipped && (
                      <div className="flex items-center gap-1">
                        <select
                          value={r.type}
                          onChange={(e) => patchRow(key, { type: e.target.value as ImportRow['type'] })}
                          className="h-7 w-full min-w-0 rounded border border-[var(--border)] bg-transparent px-1 text-xs [color-scheme:inherit]"
                        >
                          {IMPORT_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </div>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right font-medium">{isSkipped ? '' : ['income', 'repay_in'].includes(r.type) ? '+' : '-'}{formatMoney(r.amount)}</td>
                    <td className="px-2 py-1.5">
                      <input value={r.account} onChange={(e) => patchRow(key, { account: e.target.value, _pending: undefined })}
                        className="w-full min-w-0 rounded border border-transparent bg-transparent px-1.5 py-0.5 text-xs outline-none transition-colors hover:border-[var(--border)] focus:border-[var(--color-primary)]" />
                    </td>
                    <td className="hidden px-2 py-1.5 sm:table-cell">
                      <input value={r.toAccount ?? ''} onChange={(e) => patchRow(key, { toAccount: e.target.value || undefined, _pending: undefined })}
                        className="w-full min-w-0 rounded border border-transparent bg-transparent px-1.5 py-0.5 text-xs outline-none transition-colors hover:border-[var(--border)] focus:border-[var(--color-primary)]" />
                    </td>
                    <td className="hidden px-2 py-1.5 md:table-cell">
                      <input value={r.category ?? ''} onChange={(e) => patchRow(key, { category: e.target.value || undefined })}
                        className="w-full min-w-0 rounded border border-transparent bg-transparent px-1.5 py-0.5 text-xs outline-none transition-colors hover:border-[var(--border)] focus:border-[var(--color-primary)]" />
                    </td>
                    <td className="hidden px-2 py-1.5 lg:table-cell">
                      <input value={r.note ?? ''} onChange={(e) => patchRow(key, { note: e.target.value || undefined })}
                        className="w-full min-w-0 rounded border border-transparent bg-transparent px-1.5 py-0.5 text-xs outline-none transition-colors hover:border-[var(--border)] focus:border-[var(--color-primary)]" />
                    </td>
                    <td className="px-2 py-1.5">
                      <div className="flex items-center justify-end gap-1">
                        {isPending && (
                          <button type="button" onClick={() => confirmRow(key)} title={r._pending}
                            className="rounded border border-[var(--color-warning,#F59E0B)] px-1.5 py-0.5 text-xs text-[var(--color-warning,#F59E0B)] hover:bg-[var(--color-warning,#F59E0B)]/10">确认</button>
                        )}
                        <button type="button" onClick={() => removeRow(key)} title={isSkipped ? '移出待确认列表' : '移出本次导入'}
                          className="flex h-6 w-6 items-center justify-center rounded-md text-sm text-muted transition-colors hover:bg-[var(--color-danger)]/10 hover:text-[var(--color-danger)]">✕</button>
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--border)] pt-3">
            <span className="mr-auto text-xs text-muted">类型 / 账户 / 分类 / 备注可直接编辑以修正误判</span>
            <Button variant="outline" size="sm" onClick={() => setPreviewOpen(false)}>关闭</Button>
            <Button size="sm" onClick={() => void doImport()} disabled={!validRows.length || busy}>
              {busy ? '导入中…' : `开始导入 ${validRows.length} 条`}
            </Button>
          </div>
        </div>
      </Modal>

      {/* 加密账单解压密码对话框：选中 zip 后弹出，输入密码即时重试解密 */}
      <Modal open={!!pwdModal} onClose={() => setPwdModal(null)} title="输入解压密码">
        {pwdModal && (
          <div className="space-y-3">
            <p className="text-sm text-muted">
              文件「{pwdModal.file.name}」为加密压缩包，请输入解压密码以在本机解密后导入（全程离线，不上传）。
              {pwdModal.error && <span className="mt-1 block text-xs text-[var(--color-danger)]">{pwdModal.error}</span>}
            </p>
            <input
              type="password"
              autoFocus
              value={pwdModal.text}
              onChange={(e) => updatePwdText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void confirmPwd(); }}
              placeholder="解压密码"
              className="h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 text-sm outline-none focus:border-[var(--color-primary)]"
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setPwdModal(null)}>取消</Button>
              <Button size="sm" onClick={() => void confirmPwd()}>解密并导入</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}