import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { UnsavedCloseDialog } from '@/components/ui/unsaved-guard';

/**
 * 通用弹窗。
 *
 * 交互设计（用户反馈：弹窗应支持拖动与调整大小）：
 *  - 拖动移动：按住标题栏任意位置可拖动弹窗到屏幕任意位置；
 *  - 调整大小：右下角缩放手柄可拖动改变弹窗宽高（最小 320×240，最大不超过视口）；
 *  - 内容自适应：内容区为 flex-1 + 内部滚动——高度变大时内容区自动填满、变小时出现
 *    滚动条；宽度变化时内部文档流自动重排，无需任何额外适配；
 *  - 未保存守卫（guard）：dirty 时 Esc / ✕ 关闭前弹出「有未保存的修改」确认，
 *    提供继续编辑 / 不保存关闭 / 保存并关闭，防止录到一半误关丢内容；
 *  - 侧栏（side）贴边固定尺寸，不启用拖动/缩放，保持原语义；
 *  - 遮罩点击不关闭（历史缺陷：点外部会关闭正在编辑的弹窗导致表单内容丢失），
 *    关闭入口仅保留：标题栏 ✕、调用方按钮、Esc。
 */
const MIN_W = 320;
const MIN_H = 240;

/** 未保存守卫配置：dirty 为真时 Esc/✕ 先确认再关；onSave 存在则提供「保存并关闭」 */
export interface ModalGuard {
  dirty: boolean;
  /** 是否提供「保存并关闭」出路（无保存语义时省略） */
  onSave?: () => void;
}

export function Modal({ open, onClose, title, children, wide, side, className, guard }: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  wide?: boolean;
  side?: boolean;
  /** 追加到弹窗容器的自定义类（用于覆盖默认卡片背景/边框，如 AI 助手的深色渐变容器） */
  className?: string;
  /** 未保存守卫：录到一半误按 Esc/✕ 时不直接关闭，先确认（防输入内容丢失） */
  guard?: ModalGuard;
}) {
  // —— 位置与尺寸状态 ——
  // pos=null 表示尚未拖动（默认水平居中、顶部 96px）；拖动标题栏后转为像素坐标
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  // 未保存守卫确认弹窗的开关
  const [guardOpen, setGuardOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  // 拖拽会话（move=移动 / resize=缩放）：记录起点与基准值，交给全局 pointermove 增量计算
  const dragRef = useRef<{
    kind: 'move' | 'resize';
    startX: number; startY: number;
    baseX: number; baseY: number; baseW: number; baseH: number;
  } | null>(null);

  // 默认宽度基准：wide → max-w-2xl（672px）；普通 → max-w-md（448px）
  const baseW = wide ? 672 : 448;
  const isSide = !!side;
  const draggable = !isSide;

  // 统一关闭入口：Esc / ✕ 都走这里；有未保存内容时先弹确认，不直接关。
  // useCallback 稳定引用：避免表单输入导致 Modal 重渲染时 keydown 监听反复重挂
  const handleClose = useCallback(() => {
    if (guard?.dirty) {
      setGuardOpen(true);
      return;
    }
    onClose();
  }, [guard?.dirty, onClose]);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose(); };
    window.addEventListener('keydown', h);
    // 全局 pointermove/pointerup：拖拽移出弹窗边界后仍能持续跟踪，释放时才结束
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (d.kind === 'move') {
        // 移动：基于起始弹窗坐标 + 鼠标位移，并钳制在可视区内——
        // 至少让标题栏（约 48px 高）始终留在视口内，避免拖到屏幕外标题栏被切掉/无法再拖动
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const x = Math.min(Math.max(d.baseX + e.clientX - d.startX, -(d.baseW - 120)), vw - 120);
        const y = Math.min(Math.max(d.baseY + e.clientY - d.startY, 0), vh - 48);
        setPos({ x, y });
      } else {
        // 缩放：基于起始尺寸 + 鼠标位移，钳制在 [最小, 视口] 之间
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const w = Math.min(Math.max(d.baseW + e.clientX - d.startX, MIN_W), vw - 16);
        const h = Math.min(Math.max(d.baseH + e.clientY - d.startY, MIN_H), vh - 16);
        setSize({ w, h });
      }
    };
    const up = () => { dragRef.current = null; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('keydown', h);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [open, handleClose]);

  if (!open) return null;

  /** 开始移动弹窗：记录起始鼠标位置与弹窗当前坐标（未拖过则取默认居中位置） */
  const startDrag = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const w = size?.w ?? baseW;
    dragRef.current = {
      kind: 'move',
      startX: e.clientX,
      startY: e.clientY,
      baseX: pos?.x ?? (window.innerWidth - w) / 2,
      baseY: pos?.y ?? 96,
      baseW: w,
      baseH: size?.h ?? 0,
    };
  };

  /** 开始缩放：以弹窗当前实际宽高为基准（height 未显式设定时取 DOM 实测高度） */
  const startResize = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = boxRef.current;
    const w = el?.offsetWidth ?? baseW;
    const h = el?.offsetHeight ?? Math.round(window.innerHeight * 0.8);
    dragRef.current = {
      kind: 'resize',
      startX: e.clientX,
      startY: e.clientY,
      baseX: 0,
      baseY: 0,
      baseW: w,
      baseH: h,
    };
  };

  // —— 内容区（header + body） ——
  const header = title && (
    <div
      className={cn(
        'flex items-center justify-between border-b border-[var(--border)] px-5 py-4',
        draggable && 'cursor-move touch-none select-none'
      )}
      onPointerDown={draggable ? startDrag : undefined}
      title={draggable ? '按住拖动移动弹窗' : undefined}
    >
      <h2 className="font-semibold">{title}</h2>
      <button className="rounded p-1 hover:bg-black/5 dark:hover:bg-white/5" onClick={handleClose}>✕</button>
    </div>
  );

  const body = (
    <>
      {/* 内容区：min-h-0 + flex-1 + overflow 使内容随弹窗尺寸自适应（变大填满、变小滚动） */}
      <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
      {/* 缩放手柄（右下角）：视觉为对角线三角，按住拖拽改变弹窗大小 */}
      {!isSide && (
        <div
          className="absolute bottom-0 right-0 h-4 w-4 cursor-se-resize touch-none opacity-50 hover:opacity-100"
          onPointerDown={startResize}
          title="按住拖动调整大小"
          style={{ background: 'linear-gradient(135deg, transparent 50%, var(--border) 50%)' }}
        />
      )}
    </>
  );

  // —— 未保存守卫确认弹窗（置顶渲染，覆盖主弹窗） ——
  const guardDialog = guard && guardOpen && (
    <UnsavedCloseDialog
      open={guardOpen}
      canSave={!!guard.onSave}
      onContinue={() => setGuardOpen(false)}
      onDiscard={() => { setGuardOpen(false); onClose(); }}
      onSave={guard.onSave ? () => { setGuardOpen(false); guard.onSave?.(); } : undefined}
    />
  );

  // —— 布局：侧栏贴右侧固定尺寸；普通弹窗 fixed 定位（默认居中，可拖动/缩放） ——
  if (isSide) {
    return (
      <div className="fixed inset-0 z-50 bg-black/40">
        <div className="flex h-full justify-end">
          <div className="flex h-full w-[460px] flex-col overflow-hidden rounded-l-xl bg-[var(--card)] shadow-2xl">
            {header}
            {body}
          </div>
        </div>
        {guardDialog}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40">
      <div
        ref={boxRef}
        className={cn(
          'flex flex-col overflow-hidden rounded-xl bg-[var(--card)] shadow-2xl',
          className
        )}
        style={{
          position: 'fixed',
          width: size?.w ?? baseW,
          height: size?.h ?? 'auto',
          maxWidth: 'calc(100vw - 32px)',
          maxHeight: size?.h ? 'calc(100vh - 32px)' : '80vh',
          left: pos?.x ?? '50%',
          top: pos?.y ?? 96,
          // 默认居中：translateX(-50%) 抵消 left:50%；一旦拖动则使用精确像素坐标
          transform: pos ? undefined : 'translateX(-50%)',
        }}
      >
        {header}
        {body}
      </div>
      {guardDialog}
    </div>
  );
}

export function Sheet({ open, onClose, title, children, guard }: {
  open: boolean; onClose: () => void; title?: string; children: React.ReactNode;
  /** 未保存守卫：透传给内部 Modal（记账/编辑等侧栏表单防误关丢输入） */
  guard?: ModalGuard;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} side guard={guard}>
      {children}
    </Modal>
  );
}
