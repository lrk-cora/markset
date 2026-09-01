import { fetchHealth, inpaintImage, isClientModelGateOn, planOps, rewriteText } from './api.js'
import { captureMarkedPage } from './capture.js'
import { replaceRangeText, setImageSrcByBlockId } from './editor.js'
import { isForbiddenSpan } from './forbidden.js'
import { resolveInpaintResult } from './inpaint-result.js'
import { maskToFalDataUrl, makeMask, paintMask, rectToPoly } from './mask.js'
import {
  attachSpansToOps,
  buildLocalOps,
  inpaintPromptFor,
  parsePlanOps,
  shouldCallPlanner,
  textAfterFromOp,
} from './ops.js'
import { localPaintMasked } from './pending.js'
import { exitToView } from './view-mode.js'
import { inferAnchorFact, inferCommandText, parseCommand } from './plan-local.js'
import { attachImageOpsFromBboxes, collectCupBody, collectPrintStandIn } from './print-region.js'
import { collectOutsideEdits } from './scope.js'
import {
  beginWriteUndo,
  getSnapshot,
  ping,
  remapAllTextSpans,
  targets,
  undoLastWrite,
} from './store.js'

let running = false

function seedMask(span) {
  if (span.maskCanvas) return span.maskCanvas
  const canvas = makeMask(span.naturalSize || { w: 1, h: 1 })
  if (span.bbox) paintMask(canvas, rectToPoly(span.bbox), 'replace')
  return canvas
}

async function elementToDataUrl(img) {
  if (img.src.startsWith('data:')) return img.src
  const image = await new Promise((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error('image load'))
    el.src = img.src
  })
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth || image.width
  canvas.height = image.naturalHeight || image.height
  canvas.getContext('2d').drawImage(image, 0, 0)
  return canvas.toDataURL('image/jpeg', 0.92)
}

function gateMessage(err) {
  if (err.code === 'client-gate' || err.code === 'no_client_gate') {
    return '未勾选「允许调用云端模型」'
  }
  if (err.code === 'calls_disabled') {
    return '服务器禁止调用：把 markset/.env 里 MARKSET_ALLOW_MODEL_CALLS 改为 1 并重启 npm run dev'
  }
  return err.message || '调用失败'
}

function applyTextSpans(editor, spans, nextText) {
  const work = spans
    .filter((s) => s.kind === 'text' && s.from != null && s.to != null && s.from < s.to)
    .map((s) => ({ ...s }))
    .sort((a, b) => b.from - a.from)
  for (const span of work) {
    if (span.from >= span.to) continue
    let current = span.text
    try {
      current = editor.view.state.doc.textBetween(span.from, span.to)
    } catch {
      continue
    }
    const text = typeof nextText === 'function' ? nextText({ ...span, text: current }) : nextText
    if (text === current) continue
    const mapping = replaceRangeText(editor, span.from, span.to, text)
    remapAllTextSpans(mapping, editor.view.state.doc)
    for (const rest of work) {
      rest.from = mapping.map(rest.from, 1)
      rest.to = mapping.map(rest.to, -1)
    }
  }
}

async function resolveOps(ctx) {
  const local = buildLocalOps(ctx)
  const wantPlan =
    isClientModelGateOn() &&
    shouldCallPlanner(ctx.kind, ctx.scope, ctx.inTexts, ctx.inImages)
  if (!wantPlan) return { ops: local.ops, source: 'local' }
  const health = await fetchHealth().catch(() => ({}))
  if (!health.dashscope) return { ops: local.ops, source: 'local' }
  try {
    const shot = await captureMarkedPage(ctx.editor)
    const data = await planOps({
      task: 'ops',
      instruction: ctx.commandText,
      marks: shot.marks,
      imageDataUrl: shot.imageDataUrl,
      pageText: shot.pageText,
      scope: ctx.scope,
      kind: ctx.kind,
    })
    const parsed = Array.isArray(data.ops) && data.ops.length ? { ops: data.ops } : parsePlanOps(data.text)
    const attached = parsed ? attachSpansToOps(parsed.ops, ctx) : []
    const withBoxes = attachImageOpsFromBboxes(ctx.editor.view, attached).filter(
      (op) => op.span || op.tool === 'none' || op.scope === 'untouched',
    )
    if (!withBoxes.length) return { ops: local.ops, source: 'local-fallback' }
    return { ops: withBoxes, source: 'plan' }
  } catch (err) {
    if (err.code === 'client-gate' || err.code === 'calls_disabled' || err.code === 'no_client_gate') {
      return { ops: local.ops, source: 'local' }
    }
    return { ops: local.ops, source: 'local-fallback' }
  }
}

export async function runWriteback(kind, editor, notify) {
  if (running) return
  const picked = targets().filter((s) => s.kind !== 'slot')
  const scoped = picked.filter((s) => !s.frozen && !isForbiddenSpan(s))
  if (!picked.length) {
    notify('先勾选「将改」。取消勾选即可这次不动某一项')
    return
  }
  if (!scoped.length) {
    notify('价格、专利、物流是禁改区，三种范围都不改它们')
    return
  }
  if (targets().length && targets().every((s) => s.kind === 'slot')) {
    notify('页上空白请用「插入文字」或「插入图片」')
    return
  }

  const snap = getSnapshot()
  const scope = snap.scope || 'inside'
  const texts = scoped.filter((s) => s.kind === 'text')
  let commandText = inferCommandText(snap.commandText, texts)
  let images = scoped.filter((s) => s.kind === 'image')
  if (scope === 'anchor') images = []

  const parsed = parseCommand(commandText)
  const colorIntent = Boolean(parsed.color)
  const productIntent = Boolean(parsed.product)

  if (scope === 'inside' && kind !== 'delete') {
    const next = []
    if (colorIntent) {
      const cup = collectCupBody(editor.view)
      if (cup) next.push(cup)
    }
    if (productIntent) {
      const print = collectPrintStandIn(editor.view)
      if (print) next.push(print)
    }
    if (next.length) images = next
  }

  const fact = scope === 'anchor' ? inferAnchorFact(picked, commandText) : inferAnchorFact([], commandText)
  const anchorNoType = scope === 'anchor' && (kind === 'unify' || kind === 'rewrite')
  if ((kind === 'rewrite' || kind === 'unify' || kind === 'replace') && !commandText && !anchorNoType) {
    notify('先在输入框写要改成什么样。圈了「红色」等色词也可直接点统一风格。')
    return
  }

  const extraTexts =
    kind !== 'delete' && (scope === 'follow' || scope === 'anchor')
      ? collectOutsideEdits(editor.view, commandText, scope)
      : []

  if (scope === 'follow' && !texts.length && !extraTexts.length) {
    notify('跟随：请先圈一个要改的词（例如标题里的品名），再写要求、点统一风格')
    return
  }

  if (scope === 'anchor' && !fact.color && !commandText) {
    notify('锚点：请圈已经正确的杯身（或一句已对的色词）。不用填改法。')
    return
  }

  if (kind === 'delete' && scoped.some((s) => s.kind === 'image')) {
    const ok = window.confirm('删除会抹掉勾选范围内的字，并抹掉图上那一块。确定？')
    if (!ok) return
  }

  const printSpan =
    kind !== 'delete' && (scope === 'follow' || productIntent) ? collectPrintStandIn(editor.view) : null
  const cupSpan = kind !== 'delete' && (scope === 'follow' || colorIntent) ? collectCupBody(editor.view) : null
  const ctx = {
    editor,
    kind,
    commandText,
    scope,
    inTexts: texts,
    inImages: scope === 'anchor' ? scoped.filter((s) => s.kind === 'image') : images,
    extraTexts,
    printSpan,
    cupSpan,
    fact,
  }

  running = true
  try {
    const planned = await resolveOps(ctx)
    const ops = planned.ops

    if (scope === 'anchor' && !extraTexts.length) {
      notify('锚点：说明里没有找到和圈中不一致的色词。')
      return
    }

    await commitInside(editor, ops, kind, commandText, notify, fact, scope)
  } catch (err) {
    notify(gateMessage(err))
  } finally {
    running = false
  }
}

async function commitInside(editor, ops, kind, commandText, notify, fact = null, scope = 'inside') {
  const textOps = ops.filter((op) => op.tool === 'llm_rewrite' && op.span?.kind === 'text')
  const imageOps = ops.filter((op) => op.tool === 'image_inpaint' && op.span?.kind === 'image')
  const planned = textOps.map((op) => ({ ...op.span, op }))
  const images = imageOps.map((op) => ({ ...op.span, op }))

  const wantTextModel = (kind === 'rewrite' || kind === 'unify') && planned.length > 0
  const wantImage =
    images.length > 0 && (kind === 'rewrite' || kind === 'unify' || kind === 'delete' || kind === 'replace')
  const gateOn = isClientModelGateOn()
  const health = gateOn && (wantTextModel || wantImage) ? await fetchHealth().catch(() => ({})) : {}
  const useTextModel = wantTextModel && gateOn && Boolean(health.dashscope)
  const useImageModel = wantImage && gateOn && Boolean(health.fal)
  const localText = planned.length > 0 && (kind === 'replace' || kind === 'delete' || !useTextModel)
  const localImage = wantImage && !useImageModel
  const canDoSomething =
    localText || useTextModel || useImageModel || localImage || (kind === 'delete' && planned.length)

  if (!planned.length && !images.length) {
    notify('没有要改的字或图')
    return
  }

  if (!canDoSomething) {
    notify('没有可执行的改动')
    return
  }

  if (useTextModel || useImageModel) {
    const parts = []
    if (useTextModel) parts.push(`改字 ${planned.length} 次`)
    if (useImageModel) parts.push(`重画 ${images.length} 次`)
    const ok = window.confirm(`将调用云端（${parts.join('，')}），会消耗额度。确定？`)
    if (!ok) return
  }

  beginWriteUndo(editor)
  try {
    if (useTextModel) {
      for (const span of planned) {
        const data = await rewriteText(commandText, span.text)
        span.next = data.text
      }
    }

    const latest = new Map()
    if (useImageModel) {
      for (const span of images) {
        const img = editor.view.dom.querySelector(`img[data-block-id="${span.block_id}"]`)
        if (!img) throw new Error('找不到原图')
        const imageDataUrl = latest.get(span.block_id) || (await elementToDataUrl(img))
        const mask = seedMask(span)
        const data = await inpaintImage({
          prompt: span.op?.args?.prompt || inpaintPromptFor(kind, commandText),
          imageDataUrl,
          maskDataUrl: maskToFalDataUrl(mask),
        })
        latest.set(span.block_id, await resolveInpaintResult(imageDataUrl, data.imageUrl, mask))
      }
    } else if (localImage) {
      for (const span of images) {
        const img = editor.view.dom.querySelector(`img[data-block-id="${span.block_id}"]`)
        if (!img) throw new Error('找不到原图')
        const imageDataUrl = latest.get(span.block_id) || (await elementToDataUrl(img))
        const mask = seedMask(span)
        const stamp = span.op?.args?.print ? parseCommand(commandText).product : null
        latest.set(span.block_id, await localPaintMasked(imageDataUrl, mask, commandText, kind, stamp, fact))
      }
    }

    if (kind === 'delete') applyTextSpans(editor, planned, '')
    else if (useTextModel) {
      applyTextSpans(editor, planned, (live) => live.next || live.text)
    } else if (planned.length && (kind === 'replace' || kind === 'unify' || kind === 'rewrite')) {
      applyTextSpans(editor, planned, (live) => textAfterFromOp(live.op, live, commandText, kind, fact))
    }

    for (const [blockId, src] of latest) {
      if (!setImageSrcByBlockId(editor, blockId, src)) throw new Error('写回图片失败')
    }

    ping()
    exitToView()
    const skippedModel = wantTextModel && !useTextModel && planned.length
    const usedLocalImage = localImage && images.length
    const head =
      scope === 'follow' ? '跟随已写入' : scope === 'anchor' ? '锚点已写入（圈内未改）' : '仅圈内已写入'
    const bits = [head]
    if (skippedModel) bits.push('字按输入改')
    if (usedLocalImage) bits.push('图为选区内调色（未调用 fal）')
    bits.push('已结束圈选。点「套索」继续改，「撤回」撤销')
    notify(bits.join('。'))
  } catch (err) {
    undoLastWrite(editor)
    throw err
  }
}
