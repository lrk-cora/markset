const listeners = new Set()

const state = {
  spans: [],
  links: [],
  focusedMarkId: null,
  suggest: null,
}

function emit() {
  for (const fn of listeners) fn(getSnapshot())
}

function withMarks(spans) {
  return spans.map((span, i) => {
    const prefix = span.kind === 'text' ? 'T' : 'I'
    return { ...span, markId: `${prefix}${i + 1}` }
  })
}

export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getSnapshot() {
  return {
    spans: state.spans.map((s) => ({ ...s })),
    links: [...state.links],
    focusedMarkId: state.focusedMarkId,
    suggest: state.suggest ? { ...state.suggest } : null,
  }
}

export function toSpec() {
  return {
    spans: state.spans.map((span) => {
      if (span.kind === 'text') {
        return {
          block_id: span.block_id,
          start: span.start,
          end: span.end,
          text: span.text,
        }
      }
      return {
        block_id: span.block_id,
        mask: { ...span.mask },
        bbox: { ...span.bbox },
      }
    }),
    marks: state.spans.map((span) => ({
      id: span.markId,
      anchor: span.anchor ? { ...span.anchor } : null,
    })),
    links: [...state.links],
  }
}

export function setAnchors(anchorsById) {
  state.spans = state.spans.map((span) => ({
    ...span,
    anchor: anchorsById[span.markId] ?? span.anchor,
  }))
}

export function replaceSpans(spans) {
  state.spans = withMarks(spans)
  state.focusedMarkId = null
  state.suggest = null
  emit()
}

export function appendSpans(spans) {
  if (!spans.length) return
  state.spans = withMarks([...state.spans, ...spans])
  state.suggest = null
  emit()
}

export function removeMark(markId) {
  state.spans = withMarks(state.spans.filter((s) => s.markId !== markId))
  if (state.focusedMarkId === markId) state.focusedMarkId = null
  emit()
}

export function focusMark(markId) {
  if (state.focusedMarkId === markId) {
    removeMark(markId)
    return
  }
  state.focusedMarkId = markId
  emit()
}

export function setSuggest(suggest) {
  state.suggest = suggest
  emit()
}

export function clearAll() {
  state.spans = []
  state.links = []
  state.focusedMarkId = null
  state.suggest = null
  emit()
}

export function hasImage() {
  return state.spans.some((s) => s.kind === 'image')
}

export function coversTextPos(pos) {
  return state.spans.some((s) => s.kind === 'text' && pos >= s.from && pos < s.to)
}
