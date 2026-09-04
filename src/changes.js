import { inpaintImage, rewriteText } from './api.js'
import { replaceRangeText, setImageSrcByBlockId } from './editor.js'
import { isForbiddenSpan } from './forbidden.js'
import { resolveInpaintResult } from './inpaint-result.js'
import { makeMask, maskToFalDataUrl, paintMask, rectToPoly } from './mask.js'
import { textAfterFromOp } from './ops.js'
import { localPaintMasked } from './pending.js'
import { parseCommand } from './plan-local.js'
import {
  beginWriteUndo,
  captureWriteBaseline,
  clearChanges,
  getChangeBaseline,
  getSnapshot,
  patchChange,
  ping,
  remapAllTextSpans,
  replaceChangeList,
  restoreEditorFromBaseline,
  setChanges,
} from './store.js'

function seedMask(span) {
  if (span.maskCanvas) return span.maskCanvas
  const canvas = makeMask(span.naturalSize || { w: 1, h: 1 })
  if (span.bbox) paintMask(canvas, rectToPoly(span.bbox), 'replace')
  return canvas
}

function liveText(editor, span) {
  try {
    return editor.view.state.doc.textBetween(span.from, span.to)
  } catch {
    return span.text || ''
  }
}

function applyTextsFromEnd(editor, items, useAfter) {
  const work = items
    .filter((p) => p.kind === 'text' && p.status !== 'untouched')
    .map((p) => ({ ...p }))
    .sort((a, b) => b.from - a.from)
  for (const item of work) {
    if (item.from == null || item.to == null || item.from >= item.to) continue
    const takeAfter = typeof useAfter === 'function' ? useAfter(item) : useAfter
    const text = takeAfter ? item.after : item.before
    let current = item.before
    try {
      current = editor.view.state.doc.textBetween(item.from, item.to)
    } catch {
      continue
    }
    if (current === (text ?? '')) continue
    const mapping = replaceRangeText(editor, item.from, item.to, text ?? '')
    remapAllTextSpans(mapping, editor.view.state.doc)
    for (const rest of work) {
      rest.from = mapping.map(rest.from, 1)
      rest.to = mapping.map(rest.to, -1)
    }
  }
}

async function applyImages(editor, items, baseline) {
  const byBlock = new Map()
  for (const item of items) {
    if (item.kind !== 'image') continue
    const list = byBlock.get(item.block_id) || []
    list.push(item)
    byBlock.set(item.block_id, list)
  }
  for (const [blockId, list] of byBlock) {
    const src = baseline.imageSrcs?.[blockId] || ''
    const kept = list.filter((item) => item.keep !== false && item.status !== 'untouched')
    if (!kept.length) {
      if (src) setImageSrcByBlockId(editor, blockId, src)
      continue
    }
    const last = kept[kept.length - 1]
    if (last.after) {
      setImageSrcByBlockId(editor, blockId, last.after)
      continue
    }
    let next = src
    for (const item of kept) {
      if (!item.maskCanvas) continue
      next = await localPaintMasked(
        next,
        item.maskCanvas,
        item.commandText || '',
        item.opKind || 'unify',
        null,
        item.fact,
      )
    }
    if (next) setImageSrcByBlockId(editor, blockId, next)
  }
}

export async function refreshChangeVisuals(editor) {
  const baseline = getChangeBaseline()
  if (!baseline) return
  restoreEditorFromBaseline(editor, baseline)
  const reset = getSnapshot().changes.map((item) =>
    item.kind === 'text' && item.origFrom != null
      ? { ...item, from: item.origFrom, to: item.origTo }
      : item,
  )
  replaceChangeList(reset)
  applyTextsFromEnd(editor, getSnapshot().changes, (item) => item.keep !== false)
  await applyImages(editor, getSnapshot().changes, baseline)
  ping()
}

export async function restoreChange(editor, id) {
  const item = getSnapshot().changes.find((p) => p.id === id)
  if (!item || item.status === 'untouched') return
  patchChange(id, { keep: false })
  await refreshChangeVisuals(editor)
}

export async function redoChange(editor, id) {
  const item = getSnapshot().changes.find((p) => p.id === id)
  if (!item || item.status === 'untouched') return
  patchChange(id, { keep: true })
  await refreshChangeVisuals(editor)
}

export function dismissChanges() {
  if (!getSnapshot().changes.length) return false
  clearChanges()
  return true
}

export async function presentChanges({
  editor,
  kind,
  commandText,
  ops = [],
  useTextModel = false,
  useImageModel = false,
  fact = null,
}) {
  const baseline = captureWriteBaseline(editor)
  const items = []
  let n = 1
  const modelsText = Boolean(useTextModel)
  const modelsImage = Boolean(useImageModel)
  const imageLatest = new Map()

  for (const op of ops) {
    const span = op.span
    const where = op.scope || 'in'
    if (where === 'untouched' || op.tool === 'none') continue
    if (span?.kind === 'text' || op.tool === 'llm_rewrite') {
      if (!span || isForbiddenSpan(span)) continue
      const before = liveText(editor, span) || span.text || ''
      let after = before
      let status = 'ok'
      try {
        if (modelsText && op.tool === 'llm_rewrite') {
          const data = await rewriteText(commandText, before)
          after = data.text
        } else {
          after = textAfterFromOp(op, { ...span, text: before }, commandText, kind, fact)
        }
      } catch {
        status = 'fail'
        after = before
      }
      if (status !== 'fail' && after === before) continue
      items.push({
        id: op.id || `C${n}`,
        scope: where,
        kind: 'text',
        block_id: span.block_id,
        from: span.from,
        to: span.to,
        origFrom: span.from,
        origTo: span.to,
        before,
        after,
        keep: status !== 'fail',
        status,
        markId: span.markId || null,
        commandText,
        opKind: kind,
        fact,
      })
      n += 1
      continue
    }
    if ((span?.kind === 'image' || op.tool === 'image_inpaint') && span) {
      const isPrint = Boolean(span.printStandIn || op.args?.print)
      if (isPrint && !modelsImage) continue
      const src = imageLatest.get(span.block_id) || baseline.imageSrcs[span.block_id]
      const mask = seedMask(span)
      let afterSrc = src
      let status = 'ok'
      const stampText = isPrint ? parseCommand(commandText).product || commandText || '原木杯' : null
      if (src) {
        try {
          if (modelsImage && op.tool === 'image_inpaint' && !isPrint) {
            const data = await inpaintImage({
              prompt: op.args?.prompt || commandText,
              imageDataUrl: src,
              maskDataUrl: maskToFalDataUrl(mask),
            })
            afterSrc = await resolveInpaintResult(src, data.imageUrl, mask)
          } else {
            afterSrc = await localPaintMasked(src, mask, commandText, kind, stampText, fact)
          }
        } catch {
          status = 'fail'
          afterSrc = src
        }
      }
      if (status !== 'fail' && afterSrc === src) continue
      imageLatest.set(span.block_id, afterSrc)
      items.push({
        id: op.id || `C${n}`,
        scope: where,
        kind: 'image',
        block_id: span.block_id,
        maskCanvas: mask,
        bbox: span.bbox || { x: 0, y: 0, w: span.naturalSize?.w || 1, h: span.naturalSize?.h || 1 },
        screenRect: span.screenRect,
        naturalSize: span.naturalSize,
        imageRect: span.imageRect,
        before: src,
        after: afterSrc,
        keep: status !== 'fail',
        status,
        markId: span.markId || null,
        stampText,
        commandText,
        opKind: kind,
        fact,
      })
      n += 1
    }
  }

  if (!items.length) return { ok: false, count: 0 }

  beginWriteUndo(editor, baseline)
  setChanges(items, baseline)
  await refreshChangeVisuals(editor)
  return { ok: true, count: items.length }
}
