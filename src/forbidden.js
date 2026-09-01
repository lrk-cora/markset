export const FORBIDDEN_BLOCKS = new Set(['p-price', 'p-ship'])

export const FORBIDDEN_RE = /¥\s*\d+|售价|专利|发货|物流|顺延|偏远/

export const COLOR_TERMS = ['暖茶', '红色', '雾蓝']
export const MATERIAL_TERMS = ['原木']
export const RELATED_TERMS = ['暖茶', '红色', '雾蓝', '原木']

export function contradictionNeedles(fact) {
  const truth = fact?.color || null
  const needles = COLOR_TERMS.filter((c) => c !== truth)
  if (truth && truth !== '暖茶' && truth !== '红色') needles.push(...MATERIAL_TERMS)
  return needles
}

/** 跟随：品名中英对照。不是 OCR，是同一商品的别名。 */
export const PRODUCT_ALIASES = {
  原木杯: ['OAK CUP', 'Oak Cup'],
  'OAK CUP': ['原木杯'],
  'Oak Cup': ['原木杯'],
}

export function isForbiddenSpan(span) {
  if (!span || span.kind !== 'text') return false
  if (FORBIDDEN_BLOCKS.has(span.block_id)) return true
  return FORBIDDEN_RE.test(String(span.text || ''))
}

export function tagFrozen(spans) {
  return (spans || []).map((span) => {
    if (span.kind === 'text' && isForbiddenSpan(span)) {
      return { ...span, willEdit: false, frozen: true }
    }
    return span
  })
}
