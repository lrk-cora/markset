import {
  collectAliasSuggests,
  collectContradictionSuggests,
  collectDuplicateSuggests,
  findSameText,
  uniqueSuggests,
} from './hit-test.js'
import { COLOR_TERMS, isForbiddenSpan } from './forbidden.js'
import { parseCommand } from './plan-local.js'
import { getSnapshot, setImagesWillEdit, setSuggest } from './store.js'

export function visibleSuggests(_view, extra = []) {
  return uniqueSuggests(extra || [])
}

function withoutOverlap(spans) {
  const sorted = [...spans].sort(
    (a, b) => b.to - b.from - (a.to - a.from) || a.from - b.from,
  )
  const kept = []
  for (const span of sorted) {
    if (kept.some((k) => span.from < k.to && span.to > k.from)) continue
    kept.push(span)
  }
  return kept.sort((a, b) => a.from - b.from)
}

export function collectOutsideEdits(view, commandText, scope) {
  if (scope === 'follow') {
    const { color } = parseCommand(commandText)
    const occupied = getSnapshot().spans.filter((s) => s.kind === 'text')
    const hits = [...collectDuplicateSuggests(view), ...collectAliasSuggests(view)]
    if (color) {
      for (const term of COLOR_TERMS) {
        hits.push(
          ...findSameText(view, term, occupied).map((s) => ({ ...s, suggestReason: 'semantic' })),
        )
      }
    }
    return withoutOverlap(
      uniqueSuggests(hits).filter((s) => s.kind === 'text' && !isForbiddenSpan(s) && s.block_id !== 'p-note'),
    )
  }
  if (scope === 'anchor') {
    return withoutOverlap(collectContradictionSuggests(view).filter((s) => !isForbiddenSpan(s)))
  }
  return []
}

export function applyScopeAfterSelect(view, extra = []) {
  const snap = getSnapshot()
  if (snap.scope === 'anchor') setImagesWillEdit(false)
  setSuggest(uniqueSuggests(extra || []))
  return { auto: 0, leftover: 0, semantic: 0 }
}

export function describeScopeResult(_result, scope) {
  if (scope === 'inside') return '仅圈内：提交时只改圈中的。'
  if (scope === 'follow') return '跟随：先圈一个词并写要求，点统一风格后才按输入改圈外相同品名。'
  if (scope === 'anchor') return '锚点：圈中当作已对（图不重画）。点统一风格后才改正文里矛盾的色词。'
  return ''
}

export function previewOutside(outside) {
  const names = outside.map((s) => s.text).filter(Boolean)
  const uniq = [...new Set(names)]
  if (uniq.length <= 6) return uniq.join('、')
  return `${uniq.slice(0, 5).join('、')} 等 ${outside.length} 处`
}
