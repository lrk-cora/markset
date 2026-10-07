import test from 'node:test'
import assert from 'node:assert/strict'
import { createImageJobStore } from '../server/image-jobs.js'

test('concurrent identical requests share a job and replay its completed result', async () => {
  const store = createImageJobStore()
  let calls = 0, release
  const work = () => { calls++; return new Promise((resolve) => { release = resolve }) }
  const first = store.run('operation-1', { prompt: 'mug', width: 100 }, work)
  const second = store.run('operation-1', { width: 100, prompt: 'mug' }, work)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)
  release({ imageUrl: 'one-image' })
  assert.deepEqual(await first, await second)
  assert.deepEqual(await store.run('operation-1', { prompt: 'mug', width: 100 }, work), { imageUrl: 'one-image' })
  assert.equal(calls, 1)
})

test('failed/unknown jobs replay the error rather than generating again', async () => {
  const store = createImageJobStore()
  let calls = 0
  const work = async () => { calls++; throw Object.assign(new Error('unknown'), { code: 'image_timeout' }) }
  await assert.rejects(store.run('operation-1', { prompt: 'mug' }, work), { code: 'image_timeout' })
  await assert.rejects(store.run('operation-1', { prompt: 'mug' }, work), { code: 'image_timeout' })
  assert.equal(calls, 1)
})

test('changing parameters under a reused id fails without executing a new job', async () => {
  const store = createImageJobStore()
  let calls = 0
  const work = async () => { calls++; return { imageUrl: 'first' } }
  await store.run('operation-1', { prompt: 'mug' }, work)
  await assert.rejects(store.run('operation-1', { prompt: 'cat' }, work), { code: 'image_request_conflict', status: 409 })
  assert.equal(calls, 1)
})

test('memory eviction keeps a tombstone so replay cannot accidentally regenerate', async () => {
  const store = createImageJobStore({ maxBytes: 45 })
  let calls = 0
  const work = async () => { calls++; return { imageUrl: 'a'.repeat(20) } }
  await store.run('operation-1', {}, work)
  await store.run('operation-2', {}, work)
  await assert.rejects(store.run('operation-1', {}, work), { code: 'image_result_expired', status: 410 })
  assert.equal(calls, 2)
})

test('pending jobs never expire and capacity limits do not evict active work', async () => {
  let now = 0, release
  const store = createImageJobStore({ maxEntries: 1, ttlMs: 10, now: () => now })
  const first = store.run('operation-1', {}, () => new Promise((resolve) => { release = resolve }))
  await new Promise((resolve) => setImmediate(resolve))
  now = 100
  await assert.rejects(store.run('operation-2', {}, () => 'never'), { code: 'image_jobs_full' })
  release({ imageUrl: 'ready' })
  await first
  now = 111
  assert.deepEqual(await store.run('operation-2', {}, () => ({ imageUrl: 'new' })), { imageUrl: 'new' })
})
