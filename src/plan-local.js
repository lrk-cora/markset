import { colorRgb, parseHexColor } from './colors.js'
import { getDemoPage } from './editor.js'
import { COLOR_TERMS, MATERIAL_TERMS, PRODUCT_ALIASES } from './forbidden.js'

export function parseCommand(commandText) {
  const raw = String(commandText || '').trim()
  const parts = raw.split(/[，,、;；]/).map((s) => s.trim()).filter(Boolean)
  const named = [...COLOR_TERMS].sort((a, b) => b.length - a.length).find((c) => raw.includes(c))
  const color = named || parseHexColor(raw) || null
  const product = parts.find((p) => !COLOR_TERMS.includes(p) && !parseHexColor(p) && !COLOR_TERMS.some((c) => p === c)) || null
  return { raw, parts, color, product }
}

export function isColorOrMaterialTerm(text) {
  const t = String(text || '')
  return COLOR_TERMS.includes(t) || MATERIAL_TERMS.includes(t)
}

/** Anchor: circled content is already true. Do not require a typed command. */
export function inferAnchorFact(spans = [], commandText = '') {
  const typed = parseCommand(commandText)
  if (typed.color || typed.product) {
    return { color: typed.color, product: typed.product, source: 'typed' }
  }
  const texts = spans.filter((s) => s.kind === 'text').map((s) => s.text || '').join('')
  const colorInSel = COLOR_TERMS.find((c) => texts.includes(c)) || null
  const hasImage = spans.some((s) => s.kind === 'image')
  const page = getDemoPage()
  let color = colorInSel
  if (!color && hasImage) color = page === 'b' ? '雾蓝' : '暖茶'
  return { color, product: null, source: colorInSel ? 'selection' : hasImage ? 'image' : 'none' }
}

export function localNextText(span, commandText, kind, fact = null) {
  if (kind === 'delete') return ''
  const parsed = parseCommand(commandText)
  if ((kind === 'replace' || kind === 'rewrite') && parsed.raw) return parsed.raw
  const color = parsed.color || fact?.color || null
  const product = parsed.product || fact?.product || null
  const t = String(span?.text || '')
  if (isColorOrMaterialTerm(t)) return color || t
  const isPrint = Object.values(PRODUCT_ALIASES).some((list) => list.includes(t)) || Boolean(PRODUCT_ALIASES[t])
  if (isPrint && product) return product
  if (product) return product
  if (color && COLOR_TERMS.includes(t)) return color
  return parsed.raw || t
}

export function targetRgb(commandText, fact = null) {
  const color = parseCommand(commandText).color || fact?.color
  return colorRgb(color)
}

/** If the input is empty, a circled color word is the instruction (apply that color). */
export function inferCommandText(commandText, texts = []) {
  const typed = String(commandText || '').trim()
  if (typed) return typed
  const joined = texts.map((s) => s.text || '').join(' ')
  return COLOR_TERMS.find((c) => joined.includes(c)) || ''
}
