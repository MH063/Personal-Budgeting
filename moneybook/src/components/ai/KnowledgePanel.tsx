import { useState, useRef } from 'react';
import { toast } from 'sonner';
import { useKnowledgeStore, type KnowledgeEntry } from '@/stores/useKnowledgeStore';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/hint';
import { Input } from '@/components/ui/input';

/**
 * 知识库面板（智能规则页的「参考知识与规则」区块，随智能规则与 AI 统一管理）。
 * 设计：所有参考内容保存在本机，调用 AI 时随请求发送给当前生效的服务商——
 * 对 DeepSeek / OpenAI / 通义 / 智谱 / Ollama 等全部服务商一致生效，
 * 不再存在「云端参考文档仅 DeepSeek 可用」的限制（原 DeepSeek /files 面板已移除）。
 * 录入方式：① 手动添加/编辑文本条目；② 导入本地文档（txt / md / csv 等纯文本文件）。
 * 注入逻辑在 llm.ts 的 knowledgeBlock()，与凭证服务商无关，与页面挂载位置无关。
 */
export default function KnowledgePanel() {
  const entries = useKnowledgeStore((s) => s.entries);
  const add = useKnowledgeStore((s) => s.add);
  const update = useKnowledgeStore((s) => s.update);
  const remove = useKnowledgeStore((s) => s.remove);

  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [importing, setImporting] = useState(false);
  const docInputRef = useRef<HTMLInputElement>(null);

  /** 允许导入的纯文本扩展名（不做 PDF/Word 二进制解析：易出错且需额外重依赖） */
  const DOC_EXT = ['txt', 'md', 'markdown', 'csv', 'json', 'log', 'yaml', 'yml', 'ini'];
  /** 单条知识内容上限（字符数）：超出即截断，避免超大文档撑爆 prompt、无谓消耗 Token */
  const DOC_MAX_CHARS = 50000;

  function onAdd() {
    if (!title.trim() && !content.trim()) {
      toast.error('请输入标题或内容');
      return;
    }
    add({ title: title.trim() || '未命名知识', content: content.trim() });
    setTitle('');
    setContent('');
    toast.success('已添加知识条目，写入后将随 AI 请求参与上下文');
  }

  /**
   * 导入本地文档：读取纯文本文件内容作为知识条目（存本机 settings 表，随 AI 请求发送）。
   * 校验：① 扩展名白名单，拒收其它类型（含二进制）；② 内容含 NUL 视为二进制拒收；
   * ③ 超长截断至 DOC_MAX_CHARS 并汇总提示，避免用户无感知地送出超大上下文。
   */
  async function onImportDocs(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!files.length) return;
    setImporting(true);
    let okCount = 0;
    let truncatedCount = 0;
    const failed: string[] = [];
    for (const f of files) {
      const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
      if (!DOC_EXT.includes(ext)) {
        failed.push(`${f.name}（仅支持 ${DOC_EXT.join('/')} 纯文本）`);
        continue;
      }
      try {
        const text = await f.text();
        if (text.includes('\u0000')) {
          failed.push(`${f.name}（疑似二进制文件）`);
          continue;
        }
        const body = text.trim();
        if (!body) {
          failed.push(`${f.name}（内容为空）`);
          continue;
        }
        const clipped = body.length > DOC_MAX_CHARS;
        if (clipped) truncatedCount++;
        add({ title: f.name, content: clipped ? body.slice(0, DOC_MAX_CHARS) : body });
        okCount++;
      } catch {
        failed.push(`${f.name}（读取失败）`);
      }
    }
    setImporting(false);
    if (okCount) {
      toast.success(
        `已导入 ${okCount} 个文档${truncatedCount ? `（其中 ${truncatedCount} 个超长已截断至 ${DOC_MAX_CHARS} 字符）` : ''}`
      );
    }
    if (failed.length) toast.error(`未导入：${failed.join('；')}`);
  }

  function startEdit(e: KnowledgeEntry) {
    setEditingId(e.id);
    setEditTitle(e.title);
    setEditContent(e.content);
  }

  function onUpdate() {
    if (editingId === null) return;
    update(editingId, { title: editTitle.trim() || '未命名知识', content: editContent.trim() });
    setEditingId(null);
    toast.success('已保存知识条目');
  }

  const textareaCls =
    'w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--color-primary)]';

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-center gap-1.5 text-sm font-semibold">
          📝 参考知识与规则
          <Hint text="参考资料仅保存在本机，调用 AI 时随请求发送给当前生效的服务商——对全部服务商一致生效。" />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <input
            ref={docInputRef}
            type="file"
            hidden
            multiple
            accept=".txt,.md,.markdown,.csv,.json,.log,.yaml,.yml,.ini"
            onChange={onImportDocs}
          />
          <Button size="sm" variant="outline" onClick={() => docInputRef.current?.click()} disabled={importing}>
            {importing ? '导入中…' : '导入文档'}
          </Button>
        </div>
      </div>

      {/* 新增 */}
      <div className="space-y-2 rounded-lg border border-dashed border-[var(--border)] p-3">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="标题（例：预算规则、记账偏好）"
        />
        <textarea
          rows={2}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="知识 / 规则内容…"
          className={textareaCls}
        />
        <div className="flex justify-end">
          <Button size="sm" onClick={onAdd}>添加知识</Button>
        </div>
      </div>

      <div className="mt-3">
        {entries.length === 0 ? (
          <p className="py-3 text-center text-xs text-muted">暂无知识条目。可添加如「每月 20 号为房租扣款」「餐饮占比超 30% 需预警」等规则。</p>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {entries.map((e) => (
              <li key={e.id} className="py-2">
                {editingId === e.id ? (
                  <div className="space-y-2">
                    <Input value={editTitle} onChange={(ev) => setEditTitle(ev.target.value)} placeholder="标题" />
                    <textarea
                      rows={3}
                      value={editContent}
                      onChange={(ev) => setEditContent(ev.target.value)}
                      className={textareaCls}
                      placeholder="内容…"
                    />
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="outline" onClick={() => setEditingId(null)}>取消</Button>
                      <Button size="sm" onClick={onUpdate}>保存</Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-2">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{e.title}</span>
                      <span className="block truncate text-xs text-muted">{e.content}</span>
                    </span>
                    <Button size="sm" variant="outline" onClick={() => startEdit(e)}>编辑</Button>
                    <Button size="sm" variant="danger" onClick={() => { remove(e.id); toast.success('已删除'); }}>删除</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
