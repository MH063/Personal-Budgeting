import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';

export function ConfirmDialog({ open, title = '确认操作', description, confirmText = '确认', danger, onConfirm, onClose }: {
  open: boolean;
  title?: string;
  description: string;
  confirmText?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <p className="text-sm text-muted">{description}</p>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
        <Button variant={danger ? 'danger' : 'default'} size="sm" onClick={() => { onConfirm(); onClose(); }}>
          {confirmText}
        </Button>
      </div>
    </Modal>
  );
}