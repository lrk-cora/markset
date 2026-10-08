import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { createServer } from 'vite'
import { resolveRuntimeEnv, privateFilesPlugin, DEFAULT_KEY_FILE } from '../server/runtime-config.js'
import { bailianConfig, publicBailianConfig } from '../server/bailian-config.js'
import { marksetApi } from '../server/plugin.js'
import { createImageJobStore } from '../server/image-jobs.js'

// A deliberately invalid-for-service placeholder; never read a developer's
// .env or Key. All remote requests in these tests are intercepted or forbidden.
const key = 'sk-markset-test-placeholder-not-a-real-key'
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'markset-clone-中文 空格-'))
  assert.equal(dirname(resolve(root)), resolve(tmpdir()), 'cleanup must remain inside the test temp directory')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}
function putKey(root, path = DEFAULT_KEY_FILE, content = key) {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content, 'utf8')
  return file
}

test('fresh clone without .env or Key starts unconfigured on the official Beijing backend', t => {
  const env = resolveRuntimeEnv({}, fixture(t))
  const config = bailianConfig(env)
  assert.equal(config.provider, 'bailian')
  assert.equal(config.region, 'cn-beijing')
  assert.equal(config.apiKey, '')
  assert.equal(env.MARKSET_ALLOW_MODEL_CALLS, '0')
  assert.equal(config.brushModel, 'qwen3.8-flash')
  assert.equal(config.imageModel, 'qwen-image-3.0')
})

test('only placing the default Key enables both backends, even in a Chinese path with spaces', t => {
  const root = fixture(t), file = putKey(root, DEFAULT_KEY_FILE, `\uFEFF${key}\r\n`)
  const env = resolveRuntimeEnv({}, root)
  const config = bailianConfig(env)
  assert.equal(env.MARKSET_BAILIAN_KEY_FILE, file)
  assert.equal(env.MARKSET_ALLOW_MODEL_CALLS, '1')
  assert.equal(config.apiKey, key)
  assert.equal(config.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1')
  assert.doesNotMatch(JSON.stringify(publicBailianConfig(config)), /sk-|KEY_FILE|apiKey|markset-clone/)
})

test('explicit call gate 0 remains disabled; resolving defaults does not mutate the caller', t => {
  const root = fixture(t); putKey(root)
  const input = { MARKSET_ALLOW_MODEL_CALLS: '0' }
  assert.equal(resolveRuntimeEnv(input, root).MARKSET_ALLOW_MODEL_CALLS, '0')
  assert.deepEqual(input, { MARKSET_ALLOW_MODEL_CALLS: '0' })
})

test('blank key file override uses the portable file rather than an old personal directory', t => {
  const root = fixture(t), file = putKey(root)
  const env = resolveRuntimeEnv({ MARKSET_BAILIAN_KEY_FILE: '' }, root)
  assert.equal(env.MARKSET_BAILIAN_KEY_FILE, file)
  assert.equal(bailianConfig(env).apiKey, key)
})

test('explicit relative and absolute private paths take precedence over the default file', t => {
  const root = fixture(t); putKey(root)
  const other = putKey(root, '.markset-private/another.txt', 'sk-second-test-placeholder')
  for (const path of ['.markset-private/another.txt', other]) {
    const env = resolveRuntimeEnv({ MARKSET_BAILIAN_KEY_FILE: path }, root)
    assert.equal(env.MARKSET_BAILIAN_KEY_FILE, other)
    assert.equal(bailianConfig(env).apiKey, 'sk-second-test-placeholder')
  }
})

test('explicit missing path never silently uses a different Key', t => {
  const root = fixture(t); putKey(root)
  const env = resolveRuntimeEnv({ MARKSET_BAILIAN_KEY_FILE: '.markset-private/missing.txt' }, root)
  assert.throws(() => bailianConfig(env), /^Error: 百炼密钥文件无法读取或不包含唯一密钥$/u)
})

test('a missing/wrong-named default file stays unconfigured; malformed or multiple keys fail safely', t => {
  const root = fixture(t)
  putKey(root, '.markset-private/阿里.txt.txt')
  assert.equal(bailianConfig(resolveRuntimeEnv({}, root)).apiKey, '')
  for (const [name, content] of [['empty', ''], ['invalid', 'not-a-key'], ['multiple', `${key}\nsk-other-test-key`]]) {
    putKey(root, `.markset-private/${name}.txt`, content)
    const env = resolveRuntimeEnv({ MARKSET_BAILIAN_KEY_FILE: `.markset-private/${name}.txt` }, root)
    assert.throws(() => bailianConfig(env), /^Error: 百炼密钥文件无法读取或不包含唯一密钥$/u)
  }
})

test('explicit regions retain matching endpoints; unsupported region is never probed or replaced', t => {
  const root = fixture(t); putKey(root)
  for (const [region, origin] of [['ap-southeast-1', 'https://dashscope-intl.aliyuncs.com'], ['us-east-1', 'https://dashscope-us.aliyuncs.com']]) {
    assert.equal(bailianConfig(resolveRuntimeEnv({ MARKSET_BAILIAN_REGION: region }, root)).origin, origin)
  }
  assert.throws(() => bailianConfig(resolveRuntimeEnv({ MARKSET_BAILIAN_REGION: 'unknown' }, root)), /地域/u)
})

test('direct server env Key and explicitly selected legacy providers keep their precedence', t => {
  const root = fixture(t); putKey(root)
  const env = resolveRuntimeEnv({ MARKSET_BAILIAN_API_KEY: 'sk-env-placeholder' }, root)
  assert.equal(env.MARKSET_BAILIAN_KEY_FILE, '')
  assert.equal(bailianConfig(env).apiKey, 'sk-env-placeholder')
  const legacy = { MARKSET_PROVIDER: 'legacy', MARKSET_MODEL_API_KEY: 'legacy-placeholder', MARKSET_ALLOW_MODEL_CALLS: '0' }
  assert.deepEqual(resolveRuntimeEnv(legacy, root), legacy)
})

test('public Key paths are rejected before they can be copied into build output', t => {
  const root = fixture(t); putKey(root, 'public/key.txt')
  assert.throws(() => resolveRuntimeEnv({ MARKSET_BAILIAN_KEY_FILE: 'public/key.txt' }, root), /不能放在 public/u)
})

test('private-file protection extends rather than replaces custom Vite deny rules', t => {
  const root = fixture(t); putKey(root)
  const env = resolveRuntimeEnv({}, root)
  const plugin = privateFilesPlugin(env)
  assert.ok(plugin.config({ server: { fs: { deny: ['**/custom-secret/**'] } } }).server.fs.deny.includes('**/custom-secret/**'))
  const deny = plugin.config({}).server.fs.deny
  assert.ok(deny.includes('.env')); assert.ok(deny.includes('**/.git/**')); assert.ok(deny.includes('**/.markset-private/**'))
})

test('HTTP health is safe; private static/raw/@fs/module access is denied; only explicit probes go upstream', async t => {
  const root = fixture(t), file = putKey(root)
  putKey(root, '.markset-private/image-tasks.json', '[["test-task",{}]]')
  // A custom path must be protected too, not just the portable directory.
  const custom = putKey(root, 'private-custom.txt')
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>clone setup test</title>', 'utf8')
  const env = resolveRuntimeEnv({ MARKSET_BAILIAN_KEY_FILE: custom }, root)
  const nativeFetch = globalThis.fetch
  let upstreamCalls = 0
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('http://127.0.0.1:')) return nativeFetch(url, init)
    // A model-list probe is explicitly triggered below. Any other network call
    // (including paid image/completion endpoints) fails the test immediately.
    assert.equal(String(url), 'https://dashscope.aliyuncs.com/compatible-mode/v1/models')
    assert.equal(init.headers.Authorization, `Bearer ${key}`)
    upstreamCalls++
    return Response.json({ data: ['qwen3.8-flash', 'qwen3.8-max', 'qwen-image-3.0', 'qwen-image-3.0-pro'].map(id => ({ id })) })
  }
  const server = await createServer({
    configFile: false, envFile: false, root, logLevel: 'silent',
    plugins: [privateFilesPlugin(env), marksetApi(env, { imageJobs: createImageJobStore() })],
    server: { port: 0, host: '127.0.0.1', strictPort: true },
  })
  try {
    await server.listen()
    const base = `http://127.0.0.1:${server.httpServer.address().port}`
    const health = await (await nativeFetch(`${base}/api/health`)).json()
    assert.equal(health.provider, 'bailian'); assert.equal(health.region, 'cn-beijing')
    assert.equal(health.allowCalls, true); assert.equal(health.modelGateway, true); assert.equal(health.imageGeneration, true)
    assert.deepEqual(health.lastCalls, { analysis: null, image: null })
    assert.doesNotMatch(JSON.stringify(health), /sk-|阿里\.txt|private-custom|markset-clone/)
    assert.equal(upstreamCalls, 0, 'startup and health must not call providers')
    const fsPath = path => '/@fs/' + path.replaceAll('\\', '/')
    for (const path of [
      '/.markset-private/阿里.txt', '/.markset-private/阿里.txt?raw', '/.MARKSET-PRIVATE/阿里.txt?import',
      '/%2emarkset-private%2f阿里.txt', '/.markset-private/image-tasks.json', fsPath(file), fsPath(file) + '?raw',
      '/private-custom.txt', '/private-custom.txt?raw', '/private-custom.txt?import', fsPath(custom), fsPath(custom) + '?raw',
    ]) {
      const res = await nativeFetch(base + path)
      assert.equal(res.status, 403, path)
      assert.ok(!(await res.text()).includes(key))
    }
    assert.equal(upstreamCalls, 0)
    const status = await (await nativeFetch(`${base}/api/model-status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"target":"all"}' })).json()
    assert.equal(upstreamCalls, 2)
    assert.doesNotMatch(JSON.stringify(status), /sk-|阿里\.txt|private-custom|markset-clone/)
    assert.equal(status.results.length, 2)
    for (const probe of status.results) {
      assert.equal(probe.configured, true); assert.equal(probe.connectionVerified, true)
      assert.equal(probe.invocationVerified, false)
      if (probe.kind === 'image') assert.equal(probe.generationVerified, false)
    }
  } finally {
    await server.close()
    globalThis.fetch = nativeFetch
  }
})
