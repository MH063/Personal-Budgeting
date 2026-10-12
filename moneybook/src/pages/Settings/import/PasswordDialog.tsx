import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';

/** 解压密码对话框状态：file=待解密文件，text=当前输入，error=上一次尝试的失败提示 */
export interface PasswordModalState {
  file: File;
  text: string;
  error?: string;
}

interface PasswordDialogProps {
  modal: PasswordModalState | null;
  onClose: () => void;
  onTextChange: (text: string) => void;
  onConfirm: () => void;
}

/**
 * 加密账单解压密码对话框：选中加密 zip 后弹出，输入密码即时重试解密。
 * 解密全程在本机完成，不上传任何数据。
 * （自 ImportManage 页拆出，展示与交互保持不变。）
 */
export default function PasswordDialog({ modal, onClose, onTextChange, onConfirm }: PasswordDialogProps) {
  return (
    <Modal open={!!modal} onClose={onClose} title="输入解压密码">
      {modal && (
        <div className="space-y-3">
          <p className="text-sm text-muted">
            文件「{modal.file.name}」为加密压缩包，请输入解压密码以在本机解密后导入（全程离线，不上传）。
            {modal.error && <span className="mt-1 block text-xs text-[var(--color-danger)]">{modal.error}</span>}
          </p>
          <input
            type="password"
            autoFocus
            value={modal.text}
            onChange={(e) => onTextChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onConfirm(); }}
            placeholder="解压密码"
            className="h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 text-sm outline-none focus:border-[var(--color-primary)]"
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
            <Button size="sm" onClick={onConfirm}>解密并导入</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
