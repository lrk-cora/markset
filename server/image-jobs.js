import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { requestFailure as failure } from './retry.js'

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  return value
}

/** Per-process job identity. Pending requests share work; completed/error results
 * are replayed. Provider-unknown failures never start a second job for this ID. */
export function createImageJobStore({ ttlMs = 600_000, maxEntries = 64, maxLedgerEntries = 4096, maxBytes = 64 * 1024 * 1024, now = Date.now, ledgerFile } = {}) {
  const jobs = new Map()
  if (ledgerFile) {
    try {
      for (const [id, entry] of JSON.parse(readFileSync(ledgerFile, 'utf8'))) {
        const expired = entry.expiresAt <= now()
        jobs.set(id, { ...entry, status: 'failed', bytes: 0, error: failure(
          expired ? '图片任务已过查询时限；未重复生成，请新建明确的图片操作' : entry.taskId ? '服务已重启，可查询原图片任务' : '图片提交结果未确认；不会重复提交',
          expired ? 'image_operation_expired' : 'image_recovery_required', expired ? 410 : 409, { taskId: entry.taskId || '', ambiguous: true }) })
      }
    } catch (error) { if (error.code !== 'ENOENT') throw failure('图片任务记录无法读取，已禁止重复提交', 'image_ledger_invalid', 503) }
  }
  const persist = () => {
    if (!ledgerFile) return
    mkdirSync(dirname(ledgerFile), { recursive: true })
    // No key, prompt, source image, or signed result URL is persisted.
    const rows = [...jobs].map(([id, job]) => [id, { fingerprint: job.fingerprint, taskId: job.taskId,
      taskMeta: job.taskMeta, expiresAt: job.expiresAt || now() + ttlMs }])
    writeFileSync(`${ledgerFile}.tmp`, JSON.stringify(rows), { mode: 0o600 })
    renameSync(`${ledgerFile}.tmp`, ledgerFile)
  }
  let usedBytes = 0
  const expire = () => {
    for (const [key, job] of jobs) if (job.status !== 'pending' && now() >= job.expiresAt) {
      usedBytes -= job.bytes || 0
      if (!ledgerFile) jobs.delete(key)
      else {
        // Expiry retires the result, NOT the paid operation's identity. Even
        // after a restart an old retry must not become a fresh generation.
        job.bytes = 0; job.result = null; job.status = 'failed'
        job.error = failure('图片任务已过查询时限；未重复生成，请新建明确的图片操作',
          'image_operation_expired', 410, { taskId: job.taskId || '', ambiguous: true })
      }
    }
  }
  const retain = (entry, result) => {
    const bytes = Buffer.byteLength(JSON.stringify(result))
    for (const job of jobs.values()) {
      if (usedBytes + bytes <= maxBytes) break
      if (job === entry || job.status !== 'completed' || !job.result) continue
      usedBytes -= job.bytes
      job.bytes = 0
      job.result = null
      job.error = failure('该请求已生成图片，但本地结果缓存已释放；不会自动重新生成', 'image_result_expired', 410)
      job.status = 'failed'
    }
    if (usedBytes + bytes > maxBytes) {
      entry.error = failure('该请求已完成，但图片超过本地缓存容量；不会自动重新生成', 'image_result_expired', 410)
      entry.status = 'failed'
      return
    }
    entry.result = result
    entry.bytes = bytes
    usedBytes += bytes
    entry.status = 'completed'
  }
  return {
    async run(id, payload, task) {
      if (!/^[\w.-]{1,128}$/u.test(id || '')) throw failure('图片请求标识无效', 'image_invalid_request_id', 400)
      expire()
      const fingerprint = createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex')
      const existing = jobs.get(id)
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw failure('同一图片请求不能更换参数，请使用新的请求标识', 'image_request_conflict', 409)
        if (existing.error?.code === 'image_operation_expired') throw existing.error
        if (existing.status === 'pending') return existing.promise
        if (existing.error && !(existing.taskId && existing.error.code !== 'image_task_failed')) throw existing.error
        if (existing.taskId && existing.error) {
          existing.status = 'pending'
          existing.promise = Promise.resolve().then(() => task({ ...existing.taskMeta, taskId: existing.taskId })).then((result) => {
            existing.error = null; retain(existing, result); return result
          }).catch((error) => { existing.status = 'failed'; existing.error = error; throw error })
            .finally(() => { existing.promise = null; persist() })
          return existing.promise
        }
        return existing.result
      }
      if (ledgerFile) {
        if (jobs.size >= maxLedgerEntries) throw failure('图片任务账本已满，已停止新提交；请先管理已完成任务记录', 'image_ledger_full', 503)
        // Tombstones are small metadata, not live image jobs. Never sacrifice
        // idempotency to free a concurrent-job slot.
        if ([...jobs.values()].filter((job) => job.status === 'pending').length >= maxEntries) throw failure('图片任务较多，请稍后再试', 'image_jobs_full', 503)
      } else if (jobs.size >= maxEntries) throw failure('图片任务较多，请稍后再试', 'image_jobs_full', 503)
      const entry = { fingerprint, status: 'pending', bytes: 0, promise: null }
      jobs.set(id, entry)
      persist()
      const onTask = (meta) => { entry.taskId = meta.taskId; entry.taskMeta = meta; persist() }
      entry.promise = Promise.resolve().then(() => task({ onTask })).then((result) => {
        retain(entry, result)
        return result
      }).catch((error) => {
        entry.status = 'failed'
        entry.error = error
        throw error
      }).finally(() => {
        entry.expiresAt = now() + ttlMs
        entry.promise = null
        persist()
      })
      return entry.promise
    },
  }
}
