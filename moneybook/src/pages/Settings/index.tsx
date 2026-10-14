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
  // 「使用说明」原单独成组且仅 1 项，显得单薄；并入「系统与存储」并更名为「系统与帮助」，
  // 与「关于系统」相邻成组，减少一个空壳分组（与帮助页分组顺序保持呼应）。
  { title: '系统与帮助', icon: '🖥️', desc: '存储空间、快捷键、关于系统与使用说明', keys: ['storage', 'shortcut', 'about', 'help'] },
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
  const [searchParams, setSearchParams] = useSearchParams();
  const currentTab = resolveSettingsTab(searchParams.get('tab'));
  
  // 查找当前 tab 所在的组索引
  const activeGroupIdx = GROUPS.findIndex((g) => g.keys.includes(currentTab));
  
  // 切换组时，默认选中该组的第一个子页
  const handleGroupClick = (gi: number) => {
    if (gi === activeGroupIdx) return;
    setSearchParams({ tab: GROUPS[gi].keys[0] });
  };

  const activeGroup = GROUPS[activeGroupIdx >= 0 ? activeGroupIdx : 0];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">设置</h1>
        <p className="mt-1 text-sm text-muted">统一管理分类、账户、预算、智能规则、AI 与数据。</p>
      </div>

      {/* 一级导航：分组 */}
      <div className="flex flex-wrap gap-1.5 rounded-2xl border border-[var(--border)] bg-[var(--card)] p-1.5 shadow-sm">
        {GROUPS.map((g, gi) => {
          const on = activeGroupIdx === gi;
          return (
            <button
              key={g.title}
              type="button"
              onClick={() => handleGroupClick(gi)}
              className={`flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium transition-all
                ${on ? 'bg-[var(--color-primary)] text-[var(--color-primary-foreground)] shadow-sm' : 'text-muted hover:bg-black/5 dark:hover:bg-white/10'}`}
            >
              <span className={on ? '' : 'opacity-80'}>{g.icon}</span>
              {g.title}
            </button>
          );
        })}
      </div>

      {/* 二级导航：子页胶囊 */}
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-primary)]/10 text-[var(--color-primary)]">
              {activeGroup.icon}
            </div>
            <div className="flex flex-col">
              <span className="text-sm font-semibold">{activeGroup.title}</span>
              <span className="text-xs text-muted">{activeGroup.desc}</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {activeGroup.keys.map((k) => {
              const on = currentTab === k;
              return (
                <button
                  key={k}
                  onClick={() => setSearchParams({ tab: k })}
                  className={`rounded-xl px-4 py-1.5 text-sm font-medium transition-colors
                    ${on ? 'bg-[var(--fg)] text-[var(--bg)] shadow-sm' : 'bg-[var(--card)] text-muted border border-[var(--border)] hover:bg-black/5 dark:hover:bg-white/10'}`}
                >
                  {keyLabel(k)}
                </button>
              );
            })}
          </div>
        </div>

        {/* 内容区：仅渲染当前选中的子页 */}
        <div className="min-h-[400px]">
          <Rendered k={currentTab} />
        </div>
      </div>
    </div>
  );
}