export function paginate<T>(items: readonly T[], page: number, pageSize: number): { items: T[]; totalPages: number } {
  if (!Number.isInteger(page) || page < 1) throw new RangeError("page must be a positive integer");
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError("pageSize must be a positive integer");
  const offset = (page - 1) * pageSize;
  return {
    items: items.slice(offset, offset + pageSize),
    totalPages: Math.max(1, Math.ceil(items.length / pageSize)),
  };
}
