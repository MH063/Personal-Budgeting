import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listCategories, createCategory, deleteCategory } from '@/api/categories';

export function useCategories(type?: 'income' | 'expense') {
  return useQuery({ queryKey: ['categories', type], queryFn: () => listCategories(type) });
}

export function useCategoryMutations() {
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: createCategory,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['categories'] }),
  });
  const remove = useMutation({
    mutationFn: deleteCategory,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['categories'] }),
  });
  return { create, remove };
}