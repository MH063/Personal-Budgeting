import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listTags, createTag, updateTag, deleteTag } from '@/api/tags';

export function useTags() {
  return useQuery({ queryKey: ['tags'], queryFn: listTags });
}

export function useTagMutations() {
  const qc = useQueryClient();
  const inval = () => qc.invalidateQueries({ queryKey: ['tags'] });
  const create = useMutation({ mutationFn: ({ name, color }: { name: string; color?: string }) => createTag(name, color), onSuccess: inval });
  const update = useMutation({ mutationFn: ({ id, name, color }: { id: number; name: string; color?: string }) => updateTag(id, name, color), onSuccess: inval });
  const remove = useMutation({ mutationFn: deleteTag, onSuccess: inval });
  return { create, update, remove };
}