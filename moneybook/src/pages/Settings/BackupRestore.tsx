import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import dayjs from 'dayjs';
import { getKV, setKV } from '@/api/kv';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/hint';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { LAST_BACKUP_KEY, STORAGE_SAVE_DIR_KEY } from '@/lib/constants';
import { exportAllData, maskExportBundle } from '@/api/dataExport';
import { downloadJSON, saveJSON } from '@/lib/export';
import { seedTestData } from '@/api/seed';
import { resetAllData } from '@/api/factoryReset';

export default function BackupRestore() {
  const [lastBackup, setLastBackup] = useState<string | null>(() => getKV(LAST_BACKUP_KEY) || null);
  const [pendingRestore, setPendingRestore] = useState<string | null>(null);
  const [pendingSensitiveExport, setPendingSensitiveExport] = useState(false);
  // 恢复出厂设置：是否已展开确认区 + 确认输入框内容（必须输入「恢复出厂设置」才能执行）
  const [resetArmed, setResetArmed] = useState(false);
  const [resetConfirmText, setResetConfirmText] = useState('');

  useEffect(() => {
    setLastBackup(getKV(LAST_BACKUP_KEY) || null);
  }, []);

  function markBackedUp() {
    const now = String(Date.now());
    setKV(LAST_BACKUP_KEY, now);
    setLastBackup(now);
  }

  /** 导出整库为 SQLite 备份文件（Tauri 原生保存对话框；后端经 rusqlite Online Backup 拷贝到目标） */
  async function handleBackup() {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const { save } = await import('@tauri-apps/plugin-dialog');
      // 保存位置（设置 → 系统与存储里可设）：作为另存为对话框的默认目录前缀；空则用系统默认
      const saveDir = getKV(STORAGE_SAVE_DIR_KEY).trim().replace(/[\\/]+$/, '');
      // 文件名的日期与时间用横线分隔：Windows 不允许文件名含冒号（"16:22" 会被
      // 系统另存为对话框判为「文件名无效」，历史缺陷曾导致备份无法导出）
      const fileName = `moneybook-backup-${dayjs().format('YYYY-MM-DD_HH-mm')}.db`;
      const dest = await save({
        defaultPath: saveDir ? `${saveDir}\\${fileName}` : fileName,
        filters: [{ name: 'SQLite DB', extensions: ['db'] }],
      });
      if (!dest) return;
      const src = await invoke<string>('get_db_path');
      await invoke('backup_database', { source: src, dest });
      markBackedUp();
      toast.success('备份成功');
    } catch (e) {
      toast.error(`备份失败：${(e as Error).message}`);
    }
  }

  /** 从备份文件覆盖当前数据库（后端先做安全备份 .bak 再覆盖）。
   *  先选文件，再弹 ConfirmDialog 确认（替换 window.confirm）。 */
  async function handleRestore() {
    const { invoke } = await import('@tauri-apps/api/core');
    const { open } = await import('@tauri-apps/plugin-dialog');
    const file = await open({ filters: [{ name: 'SQLite DB', extensions: ['db'] }], multiple: false });
    if (typeof file !== 'string') return;
    setPendingRestore(file);
  }

  /** 用户确认后真正执行恢复操作 */
  async function confirmRestore() {
    if (!pendingRestore) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const target = await invoke<string>('get_db_path');
      await invoke('restore_database', { backup: pendingRestore, target });
      toast.success('恢复完成，重启应用生效');
    } catch (e) {
      toast.error(`恢复失败：${(e as Error).message}`);
    }
    setPendingRestore(null);
  }

  /** 一键导出全部数据为 JSON（可读/可迁移；默认脱敏，杜绝导出即泄露）。
   *  桌面版弹系统保存对话框由用户选定位置，并在成功提示中显示完整保存路径
   *  （历史缺陷：blob 静默下载不弹框不报路径，用户不知数据导到了哪儿）。 */
  async function handleExportAll(inclSensitive: boolean) {
    try {
      const raw = await exportAllData();
      const bundle = maskExportBundle(raw, inclSensitive); // 默认脱敏
      const filename = `全部数据_${dayjs().format('YYYY-MM-DD')}${inclSensitive ? '_含敏感' : ''}.json`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const isTauri = typeof window !== 'undefined' && (window as any)?.__TAURI_INTERNALS__ !== undefined;
      if (isTauri) {
        const dest = await saveJSON(filename, bundle);
        if (!dest) return; // 用户取消保存对话框
        toast.success(
          inclSensitive
            ? `已导出全部数据（含敏感字段，请妥善保管）：${dest}`
            : `已导出全部数据（备注/卡号等已脱敏；AI 密钥与操作日志不包含，恢复后需重新填写 AI 配置），已保存到：${dest}`
        );
        return;
      }
      downloadJSON(filename, bundle);
      toast.success(inclSensitive ? '已导出全部数据（含敏感字段，请妥善保管）' : '已导出全部数据（备注/卡号等已脱敏；AI 密钥与操作日志不包含，恢复后需重新填写 AI 配置）');
    } catch (e) {
      toast.error(`导出失败：${(e as Error).message}`);
    }
  }

  /** 一键填充测试数据（桌面可写库；浏览器预览仅提示） */
  async function handleSeed() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof (window as any)?.__TAURI_INTERNALS__ === 'undefined') {
      toast.warning('浏览器预览不可写库，请在 Tauri 桌面版使用「填充测试数据」。');
      return;
    }
    try {
      const n = await seedTestData();
      toast.success(`已填充 ${n} 条测试数据，可到智能洞察验证财务问答 / 预测 / 订阅 / 异常。`);
    } catch (e) {
      toast.error(`填充失败：${(e as Error).message}`);
    }
  }

  /** 恢复出厂设置：清空全部数据并回到首次引导（浏览器预览仅提示不可执行） */
  async function handleFactoryReset() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof (window as any)?.__TAURI_INTERNALS__ === 'undefined') {
      toast.warning('浏览器预览不可写库，请在 Tauri 桌面版执行恢复出厂设置。');
      setResetArmed(false);
      setResetConfirmText('');
      return;
    }
    try {
      const { clearedTables } = await resetAllData();
      toast.success(`已恢复出厂设置：${clearedTables} 张数据表已清空，即将回到首次引导`);
      // 刷新页面重置全部前端内存状态；seed_done 缺失会触发 OnboardingModal 自动弹出
      setTimeout(() => window.location.reload(), 800);
    } catch (e) {
      toast.error(`恢复出厂设置失败：${(e as Error).message}`);
    }
  }

  return (
    <div className="space-y-3">
      {/* 一键填充测试数据仅开发期可见：正式打包（production build）后该模块整体不存在（用户要求） */}
      {import.meta.env.DEV && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
          <h3 className="mb-1 font-semibold">🧪 一键填充测试数据</h3>
          <p className="mb-3 text-sm text-muted">
            注入近 3 个月的真实感交易（含订阅/涨价、异常大额、房租、工资等，余额中性），便于验证各类智能功能。可重复执行（幂等）。
          </p>
          <Button variant="outline" onClick={handleSeed}>填充测试数据</Button>
        </div>
      )}

      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <h3 className="mb-3 flex items-center gap-1.5 font-semibold">
          数据备份
          <Hint text="导出 SQLite 数据库文件到本地，涵盖全部账本、分类与设置。" />
        </h3>
        <div className="flex items-center gap-3">
          <Button onClick={handleBackup}>导出数据库备份</Button>
          <span className="text-sm text-muted">
            {lastBackup ? `上次备份：${dayjs(Number(lastBackup)).format('YYYY-MM-DD HH:mm')}` : '尚未备份'}
          </span>
        </div>
      </div>
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <h3 className="mb-3 flex items-center gap-1.5 font-semibold">
          导出全部数据（JSON）
          <Hint text="把所有业务数据导出为可读的 JSON 文件。默认对备注/收款方/卡号等做脱敏，导出文件含个人敏感信息，请妥善保管、勿外传。" />
        </h3>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => void handleExportAll(false)}>导出全部数据（已脱敏）</Button>
          <Button variant="ghost" size="sm" onClick={() => setPendingSensitiveExport(true)}>导出含敏感字段…</Button>
        </div>
      </div>
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <h3 className="mb-1 font-semibold">恢复</h3>
        <p className="mb-3 text-sm text-muted">从先前导出的备份文件覆盖当前数据。</p>
        <Button variant="danger" onClick={handleRestore}>从备份恢复</Button>
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <h3 className="mb-1 font-semibold">恢复出厂设置</h3>
        <p className="mb-3 text-sm text-muted">
          清空全部数据（交易、账户、分类、预算、借贷、AI 配置、知识库等），回到首次使用状态。
          此操作不可恢复，建议先导出一份备份。
        </p>
        {!resetArmed ? (
          <Button variant="danger" onClick={() => setResetArmed(true)}>恢复出厂设置</Button>
        ) : (
          <div className="space-y-2">
            <p className="text-xs" style={{ color: 'var(--color-danger)' }}>
              将清除本机全部账本数据与设置，不可撤销。请输入「恢复出厂设置」以确认。
            </p>
            <Input
              value={resetConfirmText}
              onChange={(e) => setResetConfirmText(e.target.value)}
              placeholder="输入「恢复出厂设置」"
            />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="danger"
                disabled={resetConfirmText !== '恢复出厂设置'}
                onClick={() => void handleFactoryReset()}
              >
                确认并清除全部数据
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setResetArmed(false);
                  setResetConfirmText('');
                }}
              >
                取消
              </Button>
            </div>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={pendingRestore != null}
        title="确认恢复"
        description="恢复将覆盖当前所有数据，确定继续吗？建议先导出一份当前库的备份。"
        confirmText="确定恢复"
        danger
        onConfirm={confirmRestore}
        onClose={() => setPendingRestore(null)}
      />
      <ConfirmDialog
        open={pendingSensitiveExport}
        title="导出含敏感字段"
        description="导出文件将包含完整的备注、收款方、订单号等个人敏感信息。请务必妥善保管，切勿发送给他人。确定继续吗？"
        confirmText="确定导出"
        onConfirm={() => { setPendingSensitiveExport(false); void handleExportAll(true); }}
        onClose={() => setPendingSensitiveExport(false)}
      />
    </div>
  );
}