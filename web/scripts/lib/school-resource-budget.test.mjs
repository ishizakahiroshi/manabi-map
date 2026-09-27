import test from 'node:test'
import assert from 'node:assert/strict'
import { checkSchoolFileBudget, schoolResourceBudget, sameSchoolBudget } from './school-resource-budget.mjs'

const MiB = 1024 * 1024
test('complete large generations require an explicit finite budget; no per-file or count bypass', () => {
  // Shared synthetic buffers exercise logical inventory size without allocating
  // a real source dataset or >500 MiB to test simple bounds.
  const bytes = Buffer.alloc(19 * MiB), files = new Map(Array.from({ length: 30 }, (_, i) => [`synthetic-${i}.html`, bytes]))
  assert.throws(() => checkSchoolFileBudget(files))
  const budget = schoolResourceBudget({ maxTotalBytes: 768 * MiB })
  assert.equal(checkSchoolFileBudget(files, budget).maxTotalBytes, 768 * MiB)
  assert.throws(() => checkSchoolFileBudget(files, { ...budget, maxFiles: 29 }))
  assert.throws(() => checkSchoolFileBudget(files, { ...budget, maxFileBytes: MiB }))
  assert.throws(() => checkSchoolFileBudget(files, { ...budget, maxTotalBytes: 256 * MiB }))
})
test('budgets reject unbounded, unknown or widened non-total limits', () => {
  for (const value of [{ maxTotalBytes: Infinity }, { maxTotalBytes: 1024 * MiB + 1 }, { maxFiles: 20001 },
    { maxFileBytes: 26 * MiB }, { maxDecodedBytes: 65 * MiB }, { maxTotalBytes: -1 }, { unknown: 1 }, null]) {
    assert.throws(() => schoolResourceBudget(value))
  }
  assert.equal(sameSchoolBudget({}, schoolResourceBudget()), true)
  assert.equal(sameSchoolBudget({}, { maxTotalBytes: 768 * MiB }), false)
})
