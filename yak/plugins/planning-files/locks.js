import fs from 'fs'
import path from 'path'

function nowIso() {
  return new Date().toISOString()
}

function buildBaseMetadata(input, kind) {
  const timestamp = input.timestamp || nowIso()
  return {
    kind,
    project_slug: input.projectSlug,
    owner_id: input.ownerID,
    process_id: process.pid,
    hostname: input.hostname || process.env.HOSTNAME || 'unknown',
    created_at: input.createdAt || timestamp,
    updated_at: timestamp,
  }
}

export function buildProjectLockMetadata(input) {
  return {
    ...buildBaseMetadata(input, 'project_lock'),
    project_slug: input.projectSlug,
    start_time: input.startTime || nowIso(),
    last_heartbeat_time: input.lastHeartbeatTime || nowIso(),
    stale_after_ms: input.staleAfterMs ?? null,
  }
}

export function buildRepoWriteLeaseMetadata(input) {
  return {
    ...buildBaseMetadata(input, 'repo_write_lease'),
    lease_id: input.leaseID,
    repo_root: input.repoRoot,
    project_slug: input.projectSlug,
    write_scope: input.writeScope || 'repo',
    granted_at: input.grantedAt || nowIso(),
    last_heartbeat_time: input.lastHeartbeatTime || nowIso(),
    stale_after_ms: input.staleAfterMs ?? null,
  }
}

export function heartbeatLock(lock, input = {}) {
  const timestamp = input.timestamp || nowIso()
  return {
    ...lock,
    updated_at: timestamp,
    last_heartbeat_time: timestamp,
  }
}

export function writeJsonAtomic(filePath, data) {
  const tempPath = `${filePath}.tmp-${process.pid}`
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2))
  fs.renameSync(tempPath, filePath)
}

export function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

export function isStale(lastHeartbeatIso, staleAfterMs) {
  if (!lastHeartbeatIso) return true
  if (!staleAfterMs || staleAfterMs <= 0) return false
  const parsed = Date.parse(lastHeartbeatIso)
  if (Number.isNaN(parsed)) return true
  return Date.now() - parsed > staleAfterMs
}

export function getStaleAfterMs(config = {}, fallbackMs = 0) {
  return config.stale_after_ms ?? config.staleAfterMs ?? fallbackMs
}

export function acquireJsonLock(filePath, nextValue) {
  if (fs.existsSync(filePath)) {
    throw new Error(`Lock already exists: ${filePath}`)
  }
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(tempPath, JSON.stringify(nextValue, null, 2))
  fs.renameSync(tempPath, filePath)
  return nextValue
}

export function releaseJsonLock(filePath) {
  if (!fs.existsSync(filePath)) return false
  fs.unlinkSync(filePath)
  return true
}
