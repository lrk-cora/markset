import { readFileSync } from 'node:fs'

const regions = Object.freeze({
  'cn-beijing': 'https://dashscope.aliyuncs.com',
  'ap-southeast-1': 'https://dashscope-intl.aliyuncs.com',
  'us-east-1': 'https://dashscope-us.aliyuncs.com',
})
const cache = new Map()

// Server only: the key is never placed in VITE_* variables or public metadata.
export function bailianConfig(env) {
  if (env.MARKSET_PROVIDER !== 'bailian') return null
  const region = env.MARKSET_BAILIAN_REGION
  if (!regions[region]) throw new Error('百炼地域未配置或不受支持；禁止自动跨地域尝试')
  let apiKey = env.MARKSET_BAILIAN_API_KEY || ''
  const file = env.MARKSET_BAILIAN_KEY_FILE
  if (!apiKey && file) {
    if (!cache.has(file)) {
      try {
        const values = [...new Set(readFileSync(file, 'utf8').match(/sk-[A-Za-z0-9_-]+/g) || [])]
        if (values.length !== 1) throw new Error('invalid')
        cache.set(file, values[0])
      } catch { throw new Error('百炼密钥文件无法读取或不包含唯一密钥') }
    }
    apiKey = cache.get(file)
  }
  const origin = regions[region]
  return {
    provider: 'bailian', region, origin, baseUrl: `${origin}/compatible-mode/v1`, apiKey,
    brushModel: env.MARKSET_BAILIAN_FLASH_MODEL || 'qwen3.8-flash',
    maxModel: env.MARKSET_BAILIAN_MAX_MODEL || 'qwen3.8-max',
    imageModel: env.MARKSET_BAILIAN_IMAGE_MODEL || 'qwen-image-3.0',
    imageProModel: env.MARKSET_BAILIAN_IMAGE_PRO_MODEL || 'qwen-image-3.0-pro',
    chatOptions: { enable_thinking: false, preserve_thinking: false },
  }
}

export function publicBailianConfig(config) {
  return config ? { provider: config.provider, region: config.region, brushModel: config.brushModel,
    maxModel: config.maxModel, imageModel: config.imageModel, imageProModel: config.imageProModel } : {}
}
