import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  buildProjectLockMetadata,
  buildRepoWriteLeaseMetadata,
  getStaleAfterMs,
  heartbeatLock,
  isStale,
  releaseJsonLock,
  writeJsonAtomic,
} from '../../yak/plugins/planning-files/locks.js'

test('lock metadata includes required project fields', () => {
  const lock = buildProjectLockMetadata({ projectSlug: 'proj-1', ownerID: 'o1', staleAfterMs: 1234 })
  assert.equal(lock.kind, 'project_lock')
  assert.equal(lock.project_slug, 'proj-1')
  assert.equal(lock.owner_id, 'o1')
  assert.equal(lock.stale_after_ms, 1234)
  assert.equal(typeof lock.last_heartbeat_time, 'string')
})

test('lease metadata includes required repo fields', () => {
  const lease = buildRepoWriteLeaseMetadata({
    projectSlug: 'proj-1',
    ownerID: 'o1',
    leaseID: 'lease-1',
    repoRoot: '/repo',
    staleAfterMs: 42,
  })
  assert.equal(lease.kind, 'repo_write_lease')
  assert.equal(lease.lease_id, 'lease-1')
  assert.equal(lease.repo_root, '/repo')
  assert.equal(lease.project_slug, 'proj-1')
  assert.equal(lease.stale_after_ms, 42)
})

test('heartbeat and stale helpers behave', () => {
  const base = { last_heartbeat_time: '2025-01-01T00:00:00.000Z' }
  const hb = heartbeatLock(base, { timestamp: '2025-01-01T00:01:00.000Z' })
  assert.equal(hb.last_heartbeat_time, '2025-01-01T00:01:00.000Z')
  assert.equal(isStale('2025-01-01T00:00:00.000Z', 1), true)
  assert.equal(getStaleAfterMs({ staleAfterMs: 9 }, 3), 9)
})

test('atomic write and release helpers work', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'locks-'))
  const file = path.join(dir, 'lock.json')
  writeJsonAtomic(file, { ok: true })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ok: true })
  assert.equal(releaseJsonLock(file), true)
  assert.equal(fs.existsSync(file), false)
})
