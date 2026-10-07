// Observable task structure, NOT the model's own confidence, chooses a tier.
export function routeAnalysis(payload, config) {
  const targets = payload.targets || []
  const strokes = payload.strokes || []
  const instruction = String(payload.userInstruction || '')
  const shapes = new Set(strokes.map((stroke) => stroke.shape).filter(Boolean))
  const parents = new Set(targets.map((target) => target.context?.parentId).filter(Boolean))
  const multiStep = /(?:同时|并且|然后|再把|还要|既要|分别|保留.+(?:但是|但|只))/u.test(instruction)
  const crossModule = parents.size > 1 && /移动|布局|重排|排列|合并|分组|挪/u.test(instruction)
  const reasons = []
  if (payload.imageDataUrls?.length) reasons.push('视觉规划（Flash 实测偶发空方案，优先 Max）')
  if (multiStep) reasons.push('多步骤约束')
  // Rendered-case evaluation: Flash returned invalid plans on image insert/
  // edit planning; Max preserved the original and produced usable image specs.
  if (/(?:添加|增加|插入|新增|加一|放一|换|编辑|修改|改成).{0,16}(?:图片|图像|配图|杯子)|(?:图片|图像|配图).{0,16}(?:编辑|修改|换|改变)/u.test(instruction)
    || targets.some((target) => target.kind === 'image') && Boolean(instruction)) reasons.push('图像内容规划（实测优先 Max）')
  if (crossModule || targets.length > 4) reasons.push('跨模块或多对象')
  if (strokes.length >= 4 && shapes.size > 1) reasons.push('组合笔迹')
  if (/复杂|整体布局|重新设计|高质量/u.test(instruction)) reasons.push('复杂设计要求')
  const tier = reasons.length ? 'max' : 'flash'
  return { tier, model: tier === 'max' ? config.maxModel : config.brushModel,
    reason: reasons.join('、') || '单一局部操作', policyVersion: 'bailian-v1' }
}

export function routeImage(payload, config) {
  const pro = payload.quality === 'high' || /高质量|精细文字|海报|复杂版面|排版|印刷|精确文字/u.test(String(payload.prompt || ''))
  return { tier: pro ? 'pro' : 'standard', model: pro ? config.imageProModel : config.imageModel,
    reason: pro ? '高质量或复杂文字版面' : '普通配图与局部编辑' }
}
