import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import CategoryManage from './CategoryManage';
import LedgerManage from './LedgerManage';
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
import { SETTINGS_TABS, SETTINGS_GROUPS, resolveSettingsTab, searchSettingsTabs, groupTitleOfTab } from '@/lib/settingsTabs';
import { Input } from '@/components/ui/input';

/**
 * 设置页：把分散子页合并为少数分区（同一页内分组展示，功能零丢失）。
 * 单击组标题展开该组内的若干子页；支持 ?tab=xxx 深链定位到对应组；
 * 顶部搜索框可跨分组按关键词（含别名/英文 key）直达子页。
 */
const GROUPS = SETTINGS_GROUPS;
const keyLabel = (k: string) => SETTINGS_TABS.find((t) => t.key === k)?.label ?? k;

function Rendered({ k }: { k: string }) {
  switch (k) {
    case 'ledgers': return <LedgerManage />;
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
  // 搜索关键词：非空时在顶部展示跨分组的搜索结果，点击可直接跳转对应子页
  const [q, setQ] = useState('');
  const matchedTabs = searchSettingsTabs(q);
  const searching = q.trim().length > 0;
  
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

      {/* 搜索：跨分组按关键词直达子页（支持别名与英文 key） */}
      <div className="flex flex-col gap-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索设置项：如 预算 / 备份 / AI / 导入"
          className="w-full sm:w-80"
        />
        {searching && (
          matchedTabs.length === 0 ? (
            <p className="text-xs text-muted">没有匹配的设置项，试试更短的关键词。</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {matchedTabs.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setSearchParams({ tab: k })}
                  className={`rounded-xl border border-[var(--border)] px-3 py-1.5 text-sm transition-colors
                    ${currentTab === k ? 'bg-[var(--fg)] text-[var(--bg)]' : 'bg-[var(--card)] text-muted hover:bg-black/5 dark:hover:bg-white/10'}`}
                >
                  <span className="text-xs opacity-70">{groupTitleOfTab(k)} · </span>{keyLabel(k)}
                </button>
              ))}
            </div>
          )
        )}
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