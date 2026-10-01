// 回收站数据 hook：列表 / 恢复 / 彻底删除 / 清空，变更后失效相关实体缓存
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listTrash, purgeTrash, restoreTrash, clearTrash, type TrashEntity } from '@/api/trash';

export function useTrash(entity?: TrashEntity) {
  const qc = useQueryClient();
  const invalidateAll = () => {
    // 失效全部业务实体缓存，恢复/删除后各列表即时刷新
    for (const key of ['transactions', 'accounts', 'categories', 'tags', 'budgets', 'savings', 'loans', 'recurring']) {
      qc.invalidateQueries({ queryKey: [key] });
    }
    qc.invalidateQueries({ queryKey: ['stats'] });
    qc.invalidateQueries({ queryKey: ['trash'] });
  };
  const list = useQuery({ queryKey: ['trash', entity], queryFn: () => listTrash(entity) });
  const restore = useMutation({ mutationFn: (id: number) => restoreTrash(id), onSuccess: invalidateAll });
  const purge = useMutation({ mutationFn: (id: number) => purgeTrash(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['trash'] }) });
  const clear = useMutation({ mutationFn: (e?: TrashEntity) => clearTrash(e), onSuccess: invalidateAll });
  return { list, restore, purge, clear };
}