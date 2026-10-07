import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import CategoryManage from './CategoryManage';
import TagManage from './TagManage';
import BudgetManage from './BudgetManage';
import RecurringManage from './RecurringManage';
import AccountManage from '../Accounts/AccountsPage';
import TemplateManage from './TemplateManage';
import RuleManage from './RuleManage';
import AISetting from './AISetting';
import BackupRestore from './BackupRestore';
import ExportManage from './ExportManage';
import ImportManage from './ImportManage';
import StorageManage from './StorageManage';
import ShortcutSetting from './ShortcutSetting';
import AboutSystem from './AboutSystem';
import Help from './Help';
import { SETTINGS_TABS, resolveSettingsTab } from '@/lib/settingsTabs';

/**
 * 设置页：把分散子页合并为少数分区（同一页内分组展示，功能零丢失）。
 * 单击组标题展开该组内的若干子页；支持 ?tab=xxx 深链定位到对应组。
 */
const GROUPS: { title: string; icon: string; desc: string; keys: string[] }[] = [
  { title: '分类与标签', icon: '🏷️', desc: '分类与标签的增删改', keys: ['category', 'tag'] },
  { title: '账户与模板', icon: '👛', desc: '账户管理、常用交易模板', keys: ['account', 'templates'] },
  { title: '预算与周期', icon: '📊', desc: '预算、周期性记账', keys: ['budget', 'recurring'] },
  { title: '智能规则与 AI', icon: '🧠', desc: '全部规则、参考知识与 AI 助手', keys: ['rules', 'ai'] },
  { title: '数据备份与导出', icon: '💾', desc: '账目导入、报表导出与 JSON 导出、数据库备份', keys: ['import', 'export', 'backup'] },
  { title: '系统与存储', icon: '🖥️', desc: '存储空间、快捷键与关于系统', keys: ['storage', 'shortcut', 'about'] },
  { title: '使用说明', icon: '❓', desc: '使用说明', keys: ['help'] },
];
const keyLabel = (k: string) => SETTINGS_TABS.find((t) => t.key === k)?.label ?? k;

function Rendered({ k }: { k: string }) {
  switch (k) {
    case 'category': return <CategoryManage />;
    case 'tag': return <TagManage />;
    case 'account': return <AccountManage />;
    case 'budget': return <BudgetManage />;
    case 'recurring': return <RecurringManage />;
    case 'templates': return <TemplateManage />;
    case 'rules': return <RuleManage />;
    case 'ai': return <AISetting />;
    case 'backup': return <BackupRestore />;
    case 'export': return <ExportManage />;
    case 'import': return <ImportManage />;
    case 'storage': return <StorageManage />;
    case 'shortcut': return <ShortcutSetting />;
    case 'about': return <AboutSystem />;
    case 'help': return <Help />;
    default: return null;
  }
}

export default function Settings() {
  const [searchParams] = useSearchParams();
  const [openGroup, setOpenGroup] = useState<number>(() => {
    const t = resolveSettingsTab(searchParams.get('tab'));
    const gi = GROUPS.findIndex((g) => g.keys.includes(t));
    return gi >= 0 ? gi : 0;
  });
  // URL ?tab= 变化时即时切换到对应分区（无需刷新/重挂载）
  useEffect(() => {
    const t = resolveSettingsTab(searchParams.get('tab'));
    const gi = GROUPS.findIndex((g) => g.keys.includes(t));
    if (gi >= 0) setOpenGroup(gi);
  }, [searchParams]);

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">设置</h1>
        <p className="mt-1 text-sm text-muted">统一管理分类、账户、预算、智能规则、AI 与数据。</p>
      </div>

      {/* 分段导航（选中态为主色卡片，未选中柔和悬浮） */}
      <div className="mb-6 flex flex-wrap gap-1.5 rounded-2xl border border-[var(--border)] bg-[var(--card)] p-1.5 shadow-sm">
        {GROUPS.map((g, gi) => {
          const on = openGroup === gi;
          return (
            <button
              key={g.title}
              type="button"
              onClick={() => setOpenGroup(on ? -1 : gi)}
              className={`flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium transition-all
                ${on ? 'bg-[var(--color-primary)] text-white shadow-sm' : 'text-muted hover:bg-black/5 dark:hover:bg-white/10'}`}
            >
              <span className={on ? '' : 'opacity-80'}>{g.icon}</span>
              {g.title}
            </button>
          );
        })}
      </div>

      {/* 当前分区：轻量头部（图标+标题 / 分隔线 / 说明 / 子项胶囊）+ 各子页 */}
      {GROUPS.map((g, gi) =>
        openGroup === gi ? (
          <div key={g.title} className="space-y-6">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex items-center gap-1.5 text-sm font-semibold">{g.icon} {g.title}</span>
                <span className="h-px flex-1 bg-[var(--border)]" />
                <span className="text-xs text-muted">{g.desc}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {g.keys.map((k) => (
                  <span key={k} className="rounded-full bg-black/5 px-2 py-0.5 text-xs text-muted dark:bg-white/10">{keyLabel(k)}</span>
                ))}
              </div>
            </div>
            {g.keys.map((k) => (
              <section key={k}>
                <Rendered k={k} />
              </section>
            ))}
          </div>
        ) : null
      )}
    </div>
  );
}