import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  assertInsideRoot,
  ensureInsideRoot,
} from '../../yak/plugins/planning-files/root-resolution.js'

test('assertInsideRoot accepts path inside root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'root-resolution-'))
  const inside = path.join(root, 'nested', 'file.txt')
  fs.mkdirSync(path.dirname(inside), { recursive: true })
  fs.writeFileSync(inside, 'x')

  assert.equal(assertInsideRoot(root, inside), true)
  assert.equal(ensureInsideRoot(root, inside), fs.realpathSync.native(inside))
})

test('assertInsideRoot rejects escape path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'root-resolution-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'))

  assert.equal(assertInsideRoot(root, outside), false)
  assert.throws(() => ensureInsideRoot(root, outside), /Path escapes repo root:/)
})

test('ensureInsideRoot accepts missing path inside root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'root-resolution-'))
  const missing = path.join(root, 'nested', 'new-file.txt')
  const expected = path.join(fs.realpathSync.native(root), 'nested', 'new-file.txt')

  assert.equal(assertInsideRoot(root, missing), true)
  assert.equal(ensureInsideRoot(root, missing), expected)
})

test('ensureInsideRoot rejects missing path outside root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'root-resolution-'))
  const outside = path.join(root, '..', 'escape.txt')

  assert.equal(assertInsideRoot(root, outside), false)
  assert.throws(() => ensureInsideRoot(root, outside), /Path escapes repo root:/)
})
