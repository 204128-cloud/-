export function sortByPriority(items) {
  return [...items].sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
}
