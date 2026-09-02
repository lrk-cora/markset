import { isForbiddenSpan } from './forbidden.js'
import { localNextText } from './plan-local.js'

export function shouldCallPlanner(kind, scope, texts, images) {
  if (scope === 'follow' || scope === 'anchor') return true
  if (kind === 'unify') return true
  if ((kind === 'rewrite' || kind === 'replace') && texts.length && images.length) return true
  return false
}

export function inpaintPromptFor(kind, commandText) {
  if (kind === 'delete') return 'remove the selected object and fill with plausible background'
  return `Product photo. Apply only inside the masked region, keep everything else unchanged: ${commandText}`
}

function afterOf(span, commandText, kind, fact) {
  if (kind === 'delete') return ''
  return localNextText(span, commandText, kind, fact)
}

export function buildLocalOps({
  kind,
  commandText,
  scope,
  inTexts = [],
  inImages = [],
  extraTexts = [],
  printSpan = null,
  cupSpan = null,
  fact = null,
}) {
  const ops = []
  let n = 1
  const cid = () => `C${n++}`

  const pushText = (span, where) => {
    if (!span || isForbiddenSpan(span)) return
    if (where === 'untouched') {
      ops.push({
        id: cid(),
        scope: 'untouched',
        target: span.markId || null,
        tool: 'none',
        args: { before: span.text, after: span.text },
        span,
      })
      return
    }
    ops.push({
      id: cid(),
      scope: where,
      target: span.markId || null,
      tool: 'llm_rewrite',
      args: {
        block_id: span.block_id,
        start: span.start,
        end: span.end,
        before: span.text,
        after: afterOf(span, commandText, kind, fact),
      },
      span,
    })
  }

  const pushImage = (span, where, extraArgs = {}) => {
    if (!span) return
    if (where === 'untouched') {
      ops.push({
        id: cid(),
        scope: 'untouched',
        target: span.markId || null,
        tool: 'none',
        args: {},
        span,
      })
      return
    }
    ops.push({
      id: cid(),
      scope: where,
      target: span.markId || null,
      tool: 'image_inpaint',
      args: {
        prompt: inpaintPromptFor(kind, commandText),
        print: Boolean(span.printStandIn) || Boolean(extraArgs.print),
        ...extraArgs,
      },
      span,
    })
  }

  if (scope === 'anchor') {
    for (const span of inTexts) pushText(span, 'untouched')
    for (const span of inImages) pushImage(span, 'untouched')
    for (const span of extraTexts) pushText(span, 'out')
    return { ops }
  }

  for (const span of inTexts) pushText(span, 'in')
  for (const span of extraTexts) pushText(span, 'out')
  for (const span of inImages) pushImage(span, 'in')

  if (scope === 'follow') {
    const hasColor =
      Boolean(fact?.color) ||
      [...inTexts, ...extraTexts].some((s) => /暖茶|红色|雾蓝/.test(s.text || '')) ||
      /暖茶|红色|雾蓝/.test(commandText || '')
    if (cupSpan && hasColor) pushImage(cupSpan, 'out', { cup: true })
  }

  return { ops }
}

export function parsePlanOps(text) {
  const raw = String(text || '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const json = JSON.parse(raw.slice(start, end + 1))
    if (!Array.isArray(json.ops)) return null
    return json
  } catch {
    return null
  }
}

function spanKey(span) {
  if (!span) return ''
  if (span.kind === 'text' && span.from != null) return `t:${span.from}:${span.to}`
  if (span.kind === 'image') {
    const b = span.bbox || {}
    return `i:${span.block_id}:${Math.round(b.x || 0)}:${Math.round(b.y || 0)}:${Math.round(b.w || 0)}:${Math.round(b.h || 0)}`
  }
  return span.markId ? `m:${span.markId}` : ''
}

/** Local ops decide which spans to edit (辐射式圈外相同品名). Planner may refine how. */
export function mergePlanOps(planOps, localOps) {
  const planned = new Map()
  for (const op of planOps || []) {
    const key = spanKey(op.span)
    if (key) planned.set(key, op)
  }
  const used = new Set()
  const merged = []
  for (const local of localOps || []) {
    const key = spanKey(local.span)
    const hit = key ? planned.get(key) : null
    if (local.tool === 'none' || local.scope === 'untouched') {
      merged.push(local)
    } else if (hit && hit.tool !== 'none' && hit.scope !== 'untouched') {
      merged.push({ ...hit, span: local.span, scope: local.scope || hit.scope })
    } else {
      merged.push(local)
    }
    if (key) used.add(key)
  }
  for (const op of planOps || []) {
    const key = spanKey(op.span)
    if (key && used.has(key)) continue
    if (!op.span && !(op.tool === 'image_inpaint' && op.args?.bbox)) continue
    merged.push(op)
  }
  return merged
}

export function attachSpansToOps(ops, { inTexts = [], inImages = [], extraTexts = [], printSpan = null, cupSpan = null }) {
  const byMark = new Map()
  for (const span of [...inTexts, ...inImages, ...extraTexts, printSpan, cupSpan].filter(Boolean)) {
    if (!span.markId) continue
    const id = String(span.markId).replace(/^#/, '')
    byMark.set(id, span)
    byMark.set(`#${id}`, span)
  }
  const texts = [...inTexts, ...extraTexts]
  return (ops || [])
    .map((op) => {
      if (op.span) return op
      const key = String(op.target || '').replace(/^#/, '')
      let span = byMark.get(key) || byMark.get(op.target)
      if (!span && op.tool === 'llm_rewrite' && op.args?.block_id != null) {
        span = texts.find(
          (s) =>
            s.block_id === op.args.block_id &&
            (op.args.start == null || s.start === op.args.start),
        )
      }
      if (!span && op.args?.print && printSpan) span = printSpan
      if (!span && op.args?.cup && cupSpan) span = cupSpan
      if (!span && op.tool === 'image_inpaint' && inImages.length === 1) span = inImages[0]
      return { ...op, span }
    })
    .filter(
      (op) =>
        op.span ||
        op.tool === 'none' ||
        op.scope === 'untouched' ||
        (op.tool === 'image_inpaint' && op.args?.bbox),
    )
}

export function textAfterFromOp(op, span, commandText, kind, fact = null) {
  if (op?.args?.after != null) return op.args.after
  return afterOf(span, commandText, kind, fact)
}
