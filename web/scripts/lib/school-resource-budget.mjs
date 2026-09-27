// Explicit resource contract shared by producer, immutable package and uploader.
// Defaults stay small. A larger complete generation requires an explicit budget.
const MiB = 1024 * 1024
export const SCHOOL_DEFAULT_BUDGET = Object.freeze({
  maxTotalBytes: 64 * MiB, maxFileBytes: 25 * MiB, maxFiles: 20000, maxDecodedBytes: 64 * MiB,
})
export function schoolResourceBudget(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => !Object.hasOwn(SCHOOL_DEFAULT_BUDGET, key))) throw new Error('School resource budget rejected')
  const value = { ...SCHOOL_DEFAULT_BUDGET, ...input }
  const limits = { ...SCHOOL_DEFAULT_BUDGET, maxTotalBytes: 1024 * MiB, maxDecodedBytes: 256 * MiB }
  for (const key of Object.keys(value)) {
    if (!Number.isSafeInteger(value[key]) || value[key] <= 0 || value[key] > limits[key]) throw new Error('School resource budget rejected')
  }
  return Object.freeze(value)
}
export function sameSchoolBudget(left, right) {
  left = schoolResourceBudget(left); right = schoolResourceBudget(right)
  return Object.keys(left).every((key) => left[key] === right[key])
}
export function checkSchoolFileBudget(files, input) {
  const budget = schoolResourceBudget(input)
  if (!(files instanceof Map) || !files.size || files.size > budget.maxFiles) throw new Error('School resource budget rejected')
  let total = 0
  for (const bytes of files.values()) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > budget.maxFileBytes ||
        (total += bytes.length) > budget.maxTotalBytes) throw new Error('School resource budget rejected')
  }
  return budget
}
