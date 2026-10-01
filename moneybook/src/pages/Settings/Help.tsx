import { useState } from 'react';

/* ============================================================
 * 使用说明 / 帮助页
 * 用数据驱动渲染，覆盖本应用全部功能并给出分步操作指南。
 * 分组卡片 + 图标标识 + 步骤编号，亮色/暗色均保证对比清晰。
 * ============================================================ */

interface GuideItem {
  icon: string;           // 功能图标
  title: string;         // 功能名（全中文）
  desc: string;          // 一句话用途
  steps: string[];       // 分步操作说明
}

interface GuideGroup {
  key: string;
  title: string;
  accent: string;        // 分组标识色（用于左侧色条 / 标题点）
  items: GuideItem[];
}

const GROUPS: GuideGroup[] = [
  {
    key: 'start',
    title: '快速上手',
    accent: '#10B981',
    items: [
      {
        icon: '🚀',
        title: '三步开始记账',
        desc: '从空白账本到第一笔记录仅需几步。',
        steps: [
          '在【账户】中先建立你的资金账户，并填写初始余额。',
          '点击顶部「＋记一笔」，选择交易类型录入第一笔收支。',
          '回到【仪表板】查看本月收入、支出与净资产概览。',
        ],
      },
      {
        icon: '🖱️',
        title: '快捷键',
        desc: '常用操作可用键盘快速完成。',
        steps: [
          'Ctrl/⌘ + K：打开命令面板，快速跳转或新建。',
          'Esc：关闭当前弹窗或菜单。',
          'Ctrl/⌘ + Enter：在记账弹窗内直接提交。',
        ],
      },
    ],
  },
  {
    key: 'book',
    title: '记账与交易',
    accent: '#1E6FA9',
    items: [
      {
        icon: '💰',
        title: '手工记账',
        desc: '录入收入、支出、转账、借贷等交易。',
        steps: [
          '在【收入】【支出】【转账】页点「＋记一笔」。',
          '选择账户、分类，填写金额与日期，备注可选。',
          '提交后自动更新净资产与对应统计。',
        ],
      },
      {
        icon: '🤖',
        title: 'AI 记账',
        desc: '用自然语言一句话完成记账。',
        steps: [
          '在【设置 → AI 助手】先配置可用凭证并开启 AI。',
          '在记账入口选择「AI 记账」，输入如"今晚吃饭花了38"。',
          'AI 自动识别类型、金额、分类与账户，确认后可写入。',
          '关闭 AI 或未配置时仍可完全手工记账。',
        ],
      },
      {
        icon: '🧾',
        title: '票据 / 截图 OCR 记账',
        desc: '拍照或截图小票，本地识别后填入表单。',
        steps: [
          '在记账弹窗点「拍照录入 / 票据记账」，选择图片。',
          '图片在本机识别，识别文字可修改；配置 AI 后可自动解析成账目。',
          '点「填入表单」回填并确认提交；未配置 AI 时也可复制文本手动填写。',
        ],
      },
      {
        icon: '🔁',
        title: '周期记账（自动记账）',
        desc: '按月/周/年自动生成重复交易，到点提醒。',
        steps: [
          '在【设置 → 周期记账】新建一条周期规则（如每月发工资）。',
          '设定类型、金额、起止与频率；启用后到点自动生成交易。',
          '可在【仪表板/通知】看到到期待入账提醒，一键确认入账。',
        ],
      },
    ],
  },
  {
    key: 'asset',
    title: '账户 · 储蓄 · 借贷',
    accent: '#F59E0B',
    items: [
      {
        icon: '🏦',
        title: '账户管理',
        desc: '维护现金、银行卡、电子钱包、信用卡、应收应付等资产账户。',
        steps: [
          '在【账户】页新建账户，选择类型并填写当前余额。',
          '可设定账户图标便于区分；转账记录账户间资金移动。',
        ],
      },
      {
        icon: '🐷',
        title: '储蓄目标',
        desc: '为目标金额分账户归集，支持自动计提。',
        steps: [
          '在【储蓄】页新建目标，设定目标金额与目标日期。',
          '选择归集账户并设定每月自动计提金额。',
          '储蓄进度按转入金额累计，可在仪表板/储蓄页查看达标情况。',
        ],
      },
      {
        icon: '🎯',
        title: '借贷管理',
        desc: '管理借出、借入、还款计划与应计利息。',
        steps: [
          '在【借贷】页登记借出/借入及还款计划（一次还本付息或等额本息）。',
          '逾期利息按规则自动累计，通知中心会提醒到期与逾期。',
          '收到/偿还后登记还款，系统自动更新应收应付。',
        ],
      },
    ],
  },
  {
    key: 'plan',
    title: '预算 · 分类 · 标签',
    accent: '#8B5CF6',
    items: [
      {
        icon: '📊',
        title: '预算管理',
        desc: '按账户设月度/年度预算，支持滚动结转与超支提醒。',
        steps: [
          '在【设置 → 预算】为账户新增预算及金额。',
          '月度预算自动滚动，上期结余结转至下期。',
          '接近上限（≥80%）显示黄点、超支显示红点并提醒，记账不受阻。',
        ],
      },
      {
        icon: '📁',
        title: '分类管理',
        desc: '自定义收入/支出分类及图标，用于统计归集。',
        steps: [
          '在【设置 → 分类】新建或编辑分类，选择图标。',
          '记账时选择分类，统计数据与图表按分类聚合。',
        ],
      },
      {
        icon: '🏷️',
        title: '标签管理',
        desc: '给交易打标签，用于跨分类的二次归类。',
        steps: [
          '在【设置 → 标签】维护标签列表。',
          '记账或编辑交易时附加标签，统计/洞察可按标签查看。',
        ],
      },
    ],
  },
  {
    key: 'analyze',
    title: '统计 · 洞察 · 对账',
    accent: '#EC4899',
    items: [
      {
        icon: '📈',
        title: '统计报表',
        desc: '收入、支出、盈余、净资产、资金流向与资金去向。',
        steps: [
          '在【统计】切换总览 / 收入 / 支出 / 盈余 / 净资产等页签。',
          '可切换查看本月、上月、年度等口径数据与图表。',
        ],
      },
      {
        icon: '🧠',
        title: '智能洞察',
        desc: '自动给出异常消费、离群交易与下月支出预测。',
        steps: [
          '在【洞察】页面查看月度支出异动与单笔离群提示。',
          '趋势平稳且无异常时洞察自动隐藏，无需手动配置。',
        ],
      },
      {
        icon: '🗓️',
        title: '日历视图',
        desc: '在同一月历上查看周期记账、储蓄计提与借贷到期。',
        steps: [
          '在【日历】页按月浏览未来事件。',
          '点击某天查看当日到期待办清单。',
        ],
      },
      {
        icon: '🧾',
        title: '银行对账',
        desc: '导入银行对账单并与本地交易逐笔核对。',
        steps: [
          '在【银行对账】新建对账批次并导入对账单流水。',
          '自动/手动匹配银行流水与本地交易，拆分可处理多条。',
          '未匹配到的本地交易会列出供你核对。',
        ],
      },
    ],
  },
  {
    key: 'data',
    title: '数据安全与维护',
    accent: '#EF4444',
    items: [
      {
        icon: '📥',
        title: '账目导入',
        desc: '批量导入交易明细，支持自定义模板 Excel/CSV，以及支付宝、微信支付真实账单。',
        steps: [
          '在【设置 → 账目导入】点击选择文件（支付宝导出的 CSV、微信支付账单 xlsx，或下载自定义模板填写）。',
          '系统自动识别表头并映射交易对方、收/支、金额、支付方式、订单号、商家订单号等明细。',
          '账户/分类可自动匹配或自动创建，逐条核对后确认写入。',
        ],
      },
      {
        icon: '🗑️',
        title: '回收站',
        desc: '删除的账户、分类、交易等先进入回收站，可恢复。',
        steps: [
          '在【回收站】查看已删除数据的快照。',
          '勾选后可恢复到原位置（含依赖校验），确认后也可彻底删除。',
        ],
      },
      {
        icon: '💾',
        title: '备份与恢复',
        desc: '导出/导入完整的 SQLite 数据库文件。',
        steps: [
          '在【设置 → 备份恢复】点"导出备份"保存数据库文件。',
          '恢复时选择备份文件并确认覆盖，即可还原全部数据。',
        ],
      },
      {
        icon: '📤',
        title: '报表导出',
        desc: '按日期范围导出交易为 CSV 或 PDF 报表。',
        steps: [
          '在【设置 → 报表导出】选择起始与结束日期。',
          '点「导出 CSV」保存数据表，或「导出 PDF」经打印窗口另存为 PDF。',
          '注：导出列含交易明细字段（支付时间/付款方式/收款方/订单号等），便于留存或二次处理。',
        ],
      },
      {
        icon: '🤖',
        title: 'AI 助手配置',
        desc: '接入大模型凭证，驱动 AI 记账与知识库。',
        steps: [
          '在【设置 → AI 助手】点击「添加凭证」，填地址与 Key。',
          '自动获取模型（也可手动输入模型名），点「测试连接」验证。',
          '开启"启用 AI 助手"，按需开启"允许发送明细"（备注会强制脱敏）。',
        ],
      },
    ],
  },
];

/** kbd 键盘按键样式（暗色/亮色均可读） */
function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="mx-0.5 rounded border border-[var(--border)] bg-black/5 px-1.5 py-0.5 font-mono text-xs dark:bg-white/5">
      {children}
    </kbd>
  );
}

/**
 * 单个功能条目卡片：左侧高亮色条 + 图标 + 标题 + 用途 + 分步说明。
 */
function GuideCard({ item, accent }: { item: GuideItem; accent: string }) {
  return (
    <div className="flex gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 shadow-sm transition-shadow hover:shadow-md">
      {/* 分彩色标识条 */}
      <div className="w-1 shrink-0 self-stretch rounded-full" style={{ backgroundColor: accent }} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-lg leading-none">{item.icon}</span>
          <h4 className="font-semibold">{item.title}</h4>
        </div>
        <p className="mt-1 text-xs text-muted">{item.desc}</p>
        <ol className="mt-2 space-y-1.5">
          {item.steps.map((s, i) => (
            <li key={i} className="flex gap-2 text-sm leading-relaxed text-[var(--fg)]">
              <span
                className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
                style={{ backgroundColor: accent }}
              >
                {i + 1}
              </span>
              <span>{s}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/** 可折叠分组标题 */
function GroupHeader({ g }: { g: GuideGroup }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="sticky top-0 z-10 py-1 backdrop-blur">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-lg bg-[var(--card)]/90 px-2 py-2 text-left"
      >
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: g.accent }} />
        <h3 className="flex-1 text-sm font-bold tracking-wide">{g.title}</h3>
        <span className="text-xs text-muted transition-transform" style={{ transform: open ? 'rotate(180deg)' : 'none' }}>▾</span>
      </button>
      {open && (
        <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {g.items.map((it) => <GuideCard key={it.title} item={it} accent={g.accent} />)}
        </div>
      )}
    </div>
  );
}

export default function Help() {
  const total = GROUPS.reduce((n, g) => n + g.items.length, 0);
  return (
    <div className="space-y-3">
      {/* 页头横幅 */}
      <div className="flex items-center justify-between rounded-xl border border-[var(--border)] bg-gradient-to-r from-[#10B981]/10 to-[#1E6FA9]/10 p-4">
        <div>
          <h2 className="text-lg font-bold">使用说明</h2>
          <p className="mt-0.5 text-xs text-muted">覆盖本应用全部 {total} 项功能，点击分组标题可展开 / 收起。</p>
        </div>
        <span className="hidden text-2xl sm:block">📘</span>
      </div>

      {GROUPS.map((g) => <GroupHeader key={g.key} g={g} />)}

      {/* 快捷提示 */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 text-sm text-muted">
        <p className="font-semibold text-[var(--fg)]">快捷提示</p>
        <p className="mt-1">搜索：顶部 <Kbd>Ctrl/⌘</Kbd> + <Kbd>K</Kbd> 打开命令面板，可快速定位功能 / 分类 / 交易。数据默认仅保存在本机，请及时在「备份与恢复」中导出备份。</p>
      </div>
    </div>
  );
}