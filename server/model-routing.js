// Explicit user-selected Flash trial. Screenshots, task complexity and failures
// must not silently switch back to Max or chain both paid tiers.
export function routeAnalysis(_payload, config) {
  return { tier: 'flash', model: config.brushModel,
    reason: 'Flash 快速规划（用户指定，不自动升级 Max）', policyVersion: 'flash-fast-v1' }
}

export function routeImage(payload, config) {
  const pro = payload.quality === 'high' || /高质量|精细文字|海报|复杂版面|排版|印刷|精确文字/u.test(String(payload.prompt || ''))
  return { tier: pro ? 'pro' : 'standard', model: pro ? config.imageProModel : config.imageModel,
    reason: pro ? '高质量或复杂文字版面' : '普通配图与局部编辑' }
}
