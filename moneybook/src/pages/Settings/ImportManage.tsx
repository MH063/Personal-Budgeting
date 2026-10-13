import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Link } from 'react-router-dom';
import {
  bulkImportTransactions, getImportReferences, parseBillAOA, parseCsvText,
  accountsMatch, normalizeAccountName, rowFingerprint, rowKeyOf,
  buildColumnMap, parseAoaWithMap, IMPORT_FIELD_LABELS,
  type ImportRow, type ImportSmoke, type ColumnMap, type ImportFieldKey,
} from '@/api/import';
import { loadImportRules, saveImportRules, pickRuleKeyword, shouldLearnCorrection, learnRuleFromCorrection, type LearnedRuleCandidate } from '@/api/importRules';
import { recalcAccountBalances, updateTransaction } from '@/api/transactions';
import { isZip, tryExtractZipAsync, detectZipEncryption } from '@/api/importZip';
import { recordImportLog, listImportLogs, type ImportLog, type ImportSkip } from '@/api/importLog';
import { recordAudit } from '@/api/audit';
import { suggestForText } from '@/api/aiSuggest';
import { PLATFORM_PRESETS, matchPlatformPreset, presetToColumnMap } from '@/api/platformPresets';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/hint';
import ReconPanel from './import/ReconPanel';
import ImportHistoryPanel from './import/ImportHistoryPanel';
import PreviewDialog from './import/PreviewDialog';
import PasswordDialog, { type PasswordModalState } from './import/PasswordDialog';
import { decodeText, type ReconItem } from './import/helpers';
import { isTauriRuntime } from '@/lib/runtime';

// 表头别名推断已迁移至 import.buildColumnMap（含多字段认领策略）。
// 导入类型下拉选项、「待核对」项类型见 ./import/helpers；各弹窗与独立区块已拆为 ./import 下的子组件。

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
  const [pwdModal, setPwdModal] = useState<PasswordModalState | null>(null);
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
  // 平台模板：'auto' = 自动识别（buildColumnMap）；其余为 PLATFORM_PRESETS 的 id（按平台常见列名套用）
  const [platformId, setPlatformId] = useState<string>('auto');
  // 「导入后待核对」：可疑行已按推测口径入库，此处按库中交易 id 逐条修正（改类型/账户）
  const [recon, setRecon] = useState<ReconItem[]>([]);
  // 解析结果弹窗：选择文件识别成功后以弹窗形式集中展示（用户要求，避免大表格挤在页面）；
  // 弹窗内可编辑修正并直接「开始导入」，关闭后预览数据保留在内存直至下次解析
  const [previewOpen, setPreviewOpen] = useState(false);
  // 导入历史「跳过明细」弹窗与「补导入」二次确认的状态已内聚到子组件 ImportHistoryPanel
  // 用户自定义资金流向规则的编辑 UI 已集中到「设置 → 智能规则」（用户要求规则统一一栏），
  // 本页仅保留自动学习（修正后沉淀规则）与跳转入口。
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
    // 自定义模板：优先按「平台模板」（文件名/表头特征词）套用列映射，否则自动推断；
    // 单文件时保留表头供用户手动调整（平台可切换）
    const headerRow = aoa.find((r) => (r as unknown[]).some((c) => String(c ?? '').trim() !== '')) ?? [];
    const header = (headerRow as unknown[]).map((c) => String(c ?? '').trim());
    const matched = matchPlatformPreset(header, name);
    const map = matched ? presetToColumnMap(matched, header) : buildColumnMap(header);
    if (fileCount === 1) {
      setColHeader(header);
      setColMap(map);
      setMapAoa(aoa);
      setPlatformId(matched ? matched.id : 'auto');
      if (matched) toast.message(`已识别为「${matched.name}」账单，自动套用其列映射（可在列映射预览中调整）`);
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
        // zip：识别加密方式（明文 / zipcrypto / WinZip AES 均由 tryExtractZipAsync 统一处理）
        const kind = detectZipEncryption(binary);
        const ex = await tryExtractZipAsync(binary, pwd);
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
      const ex = await tryExtractZipAsync(binary, text);
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

  /** 套用平台模板：'auto' 用自动推断；其余按对应平台的常见列名套用映射。
   *  仅更新映射（需再点「应用映射」重解析），与「还原自动」按钮同一路径。 */
  function applyPlatform(id: string) {
    setPlatformId(id);
    if (id === 'auto') { setColMap(buildColumnMap(colHeader)); return; }
    const preset = PLATFORM_PRESETS.find((p) => p.id === id);
    if (preset) setColMap(presetToColumnMap(preset, colHeader));
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
      if (isTauriRuntime()) {
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
   * 读最新规则集（而非组件内存态，避免覆盖「智能规则」页里的改动），合并后回写；
   * 规则编辑界面已集中到智能规则页，本页不再持有规则 state（历史缺陷：规则分散两处）。
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
      // 写入导入审计，并刷新历史（审计失败不影响导入本身）。
      // 被跳过的行（疑似重复 / 金额无效 / 类型无法识别等）连同原始字段一并持久化到
      // import_skips 表：导入历史「跳过」列可点开查看明细，日后可一键补导入。
      try {
        const rowByLine = new Map(finalRows.map((r) => [r.line, r]));
        const skips = res.skipped.map((s) => ({
          line: s.line, reason: s.reason,
          row: rowByLine.get(s.line) ?? null,
        }));
        await recordImportLog({
          fileName: fileMeta.current.names, fileCount: fileMeta.current.count,
          imported: res.imported, skipped: res.skipped.length, duplicates: res.duplicates,
          createdAccounts: res.createdAccounts.length, createdCategories: res.createdCategories.length,
          skips,
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
          toast.success(`已自动学习 ${learned.length} 条资金流向规则：${learned.join('、')}（可在「设置 → 智能规则」中查看/停用）`, { duration: 6000 });
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

  /** 把某次导入的跳过明细还原为可导入行，追加到当前预览后即可重新导入（补导入）。
   *  还原时：仅取持久化的原始字段（日期/金额/账户等），清除跳过标记作为正常行；
   *  行标识重新盖章，避免与当前预览中已有行互相覆盖（同文件行号可能重复）。
   *  @returns 是否成功还原（供 ImportHistoryPanel 决定是否关闭跳过明细弹窗） */
  function restoreSkipsToImport(skips: ImportSkip[]): boolean {
    const restored: ImportRow[] = [];
    for (const sk of skips) {
      try {
        const row = JSON.parse(sk.row_data) as Partial<ImportRow> & { type?: string };
        if (!row || typeof row !== 'object' || !row.date || !Number(row.amount)) continue;
        const type = ['income', 'expense', 'transfer', 'repay_in'].includes(String(row.type))
          ? (row.type as ImportRow['type'])
          : 'expense';
        restored.push({
          date: String(row.date),
          type,
          amount: Number(row.amount),
          account: String(row.account ?? '未识别账户'),
          toAccount: row.toAccount ?? '',
          category: row.category ?? '',
          note: row.note ?? '',
          payTime: row.payTime ?? '',
          payMethod: row.payMethod ?? '',
          payee: row.payee ?? '',
          orderNo: row.orderNo ?? '',
          merchantOrderNo: row.merchantOrderNo ?? '',
          line: sk.line,
          _rowKey: `skip:${sk.log_id}:${sk.line}`,
        });
      } catch { /* 单条还原失败忽略，其余照常补导入 */ }
    }
    if (!restored.length) { toast.error('该批跳过明细缺少可还原的关键字段（日期/金额），无法补导入'); return false; }
    setRows((prev) => [...prev, ...restored]);
    setPreviewOpen(true);
    toast.success(`已将 ${restored.length} 条跳过的数据加入待导入列表，请核对后开始导入`);
    return true;
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
          if (learned.length) toast.info(`已学习规则「${match}」：同类导入将自动按此归类（可在「设置 → 智能规则」中编辑/停用）`, { duration: 6000 });
        }
      } catch { /* 学习失败不影响修正结果 */ }
    } catch (e) {
      toast.error(`修正失败：${(e as Error).message}`);
    }
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
        {/* 资金流向判定规则的编辑已集中到「智能规则」页：本页仅保留跳转入口，避免规则分散（用户要求） */}
        <div className="mt-3 rounded-lg border border-[var(--border)] p-2 text-xs text-muted">
          资金流向判定规则已集中到
          <Link to="/settings?tab=rules" className="mx-1 text-[var(--color-primary-fg)] hover:underline">设置 → 智能规则</Link>
          统一管理（含归类规则、商户归并与参考知识）；在本页预览/核对中修正归类仍会自动沉淀规则。
        </div>
        {/* 列映射预览：自定义模板/单文件时可手动指认表头列到业务字段 */}
        {colHeader.length > 0 && (
          <div className="mt-3 rounded-lg border border-[var(--border)] p-2">
            <button type="button" onClick={() => setMapOpen((v) => !v)} className="text-xs font-medium hover:underline">
              列映射预览（自定义模板，可调整）{mapOpen ? ' ▲' : ' ▼'}
            </button>
            {mapOpen && (
              <div className="mt-2">
                <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-muted">平台模板</span>
                  <select
                    value={platformId}
                    onChange={(e) => applyPlatform(e.target.value)}
                    className="h-7 rounded border border-[var(--border)] bg-[var(--card)] px-1 text-xs"
                  >
                    <option value="auto">自动识别</option>
                    {PLATFORM_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <span className="text-muted">按平台常见列名快速套用，仍可逐列调整</span>
                </div>
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
                  <Button variant="outline" size="sm" onClick={() => applyPlatform('auto')}>还原自动</Button>
                  <Button size="sm" disabled={busy} onClick={() => void applyColMap()}>{busy ? '解析中…' : '应用映射'}</Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 导入后待核对：可疑行已按账单推测口径入库，此处就地改类型/账户并回写该交易 */}
      <ReconPanel
        recon={recon}
        accounts={refs?.accounts ?? []}
        onPatch={patchRecon}
        onSave={saveRecon}
        onRemove={(id) => setRecon((prev) => prev.filter((x) => x.id !== id))}
      />

      <ImportHistoryPanel logs={importHist} onRestoreSkips={restoreSkipsToImport} />

      {/* 解析结果弹窗：选择文件识别成功后集中展示（用户要求，避免预览大表格挤在页面）。
          弹窗内可编辑修正误判，确认后直接「开始导入」；关闭仅收起弹窗，预览数据保留在内存。
          （「跳过明细」弹窗与补导入二次确认已内聚到 ImportHistoryPanel。） */}
      <PreviewDialog
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        rows={rows}
        validCount={validRows.length}
        total={total}
        pendingRows={pendingRows}
        dupLines={dupLines}
        parseWarn={parseWarn}
        pendingAccounts={pendingAccounts}
        onRenamePending={renamePending}
        onPatchRow={patchRow}
        onConfirmRow={confirmRow}
        onRemoveRow={removeRow}
        onClearPending={() => setRows((prev) => prev.map((r) => (r._pending ? { ...r, _pending: undefined } : r)))}
        onImport={() => void doImport()}
        busy={busy}
      />

      {/* 加密账单解压密码对话框：选中 zip 后弹出，输入密码即时重试解密 */}
      <PasswordDialog
        modal={pwdModal}
        onClose={() => setPwdModal(null)}
        onTextChange={updatePwdText}
        onConfirm={() => void confirmPwd()}
      />
    </div>
  );
}