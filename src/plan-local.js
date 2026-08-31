import { COLOR_TERMS, PRODUCT_ALIASES } from './forbidden.js'

export function parseCommand(commandText) {
  const raw = String(commandText || '').trim()
  const parts = raw.split(/[，,、;；]/).map((s) => s.trim()).filter(Boolean)
  const color = COLOR_TERMS.find((c) => raw.includes(c)) || null
  const product = parts.find((p) => !COLOR_TERMS.includes(p) && !COLOR_TERMS.some((c) => p === c)) || null
  return { raw, parts, color, product }
}

export function localNextText(span, commandText, kind) {
  if (kind === 'delete') return ''
  if (kind === 'replace' || kind === 'rewrite') return commandText
  const { raw, color, product } = parseCommand(commandText)
  const t = String(span?.text || '')
  if (COLOR_TERMS.includes(t)) return color || t
  const isPrint = Object.values(PRODUCT_ALIASES).some((list) => list.includes(t)) || Boolean(PRODUCT_ALIASES[t])
  if (isPrint && product) return product
  if (product) return product
  return raw
}
