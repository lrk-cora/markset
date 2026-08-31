import { inpaintImage, isClientModelGateOn, rewriteText } from './api.js'
import { replaceRangeText, setImageSrcByBlockId } from './editor.js'
import { isForbiddenSpan } from './forbidden.js'
import { maskToFalDataUrl, makeMask, paintMask, rectToPoly } from './mask.js'
import { localNextText } from './plan-local.js'
import {
  collectOutsideEdits,
  previewOutside,
} from './scope.js'
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

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('image load'))
    image.src = src
  })
}

async function elementToDataUrl(img) {
  if (img.src.startsWith('data:')) return img.src
  const image = await loadImage(img.src)
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth || image.width
  canvas.height = image.naturalHeight || image.height
  canvas.getContext('2d').drawImage(image, 0, 0)
  return canvas.toDataURL('image/jpeg', 0.92)
}

async function compositeMasked(originalUrl, resultUrl, maskCanvas) {
  const orig = await loadImage(originalUrl)
  const result = await loadImage(resultUrl)
  const out = document.createElement('canvas')
  out.width = orig.naturalWidth || orig.width
  out.height = orig.naturalHeight || orig.height
  const ctx = out.getContext('2d')
  ctx.drawImage(orig, 0, 0)
  const tmp = document.createElement('canvas')
  tmp.width = out.width
  tmp.height = out.height
  const tctx = tmp.getContext('2d')
  tctx.drawImage(result, 0, 0, out.width, out.height)
  tctx.globalCompositeOperation = 'destination-in'
  tctx.drawImage(maskCanvas, 0, 0, out.width, out.height)
  ctx.drawImage(tmp, 0, 0)
  return out.toDataURL('image/png')
}

function inpaintPrompt(kind, commandText) {
  if (kind === 'delete') return 'remove the selected object and fill with plausible background'
  return `Product photo. Apply only inside the masked region, keep everything else unchanged: ${commandText}`
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

  const commandText = getSnapshot().commandText.trim()
  const scope = getSnapshot().scope || 'inside'
  const texts = scoped.filter((s) => s.kind === 'text')
  let images = scoped.filter((s) => s.kind === 'image')
  if (scope === 'anchor') images = []

  if ((kind === 'rewrite' || kind === 'unify' || kind === 'replace') && !commandText) {
    notify('先在输入框写要改成什么样')
    return
  }

  const outside =
    kind !== 'delete' && (scope === 'follow' || scope === 'anchor')
      ? collectOutsideEdits(editor.view, commandText, scope)
      : []
  const seen = new Set(texts.map((s) => `${s.from}:${s.to}`))
  const extraTexts = outside.filter((s) => !seen.has(`${s.from}:${s.to}`))
  const allTexts = [...texts, ...extraTexts]

  if (scope === 'follow' && !texts.length && !extraTexts.length) {
    notify('跟随：请先圈一个要改的词（例如标题里的品名），再写要求、点统一风格')
    return
  }

  if (kind === 'delete' && images.length && isClientModelGateOn()) {
    const ok = window.confirm('删除会抹掉勾选范围内的字，并抹掉图上那一块（重画会消耗额度）。确定？')
    if (!ok) return
  }

  const planned = allTexts.map((s) => ({ ...s }))
  const wantTextModel = (kind === 'rewrite' || kind === 'unify') && planned.length > 0
  const wantImage =
    images.length > 0 && (kind === 'rewrite' || kind === 'unify' || kind === 'delete' || kind === 'replace')
  const useTextModel = wantTextModel && isClientModelGateOn()
  const useImageModel = wantImage && isClientModelGateOn()
  const localText = planned.length > 0 && (kind === 'replace' || kind === 'delete' || !useTextModel)
  const canDoSomething = localText || useTextModel || useImageModel || (kind === 'delete' && planned.length)

  if (!planned.length && !images.length) {
    notify(
      scope === 'anchor'
        ? '锚点：圈中不重画。说明里没有找到要改的矛盾色词。'
        : '没有要改的字或图',
    )
    return
  }

  if (!canDoSomething && wantImage && !isClientModelGateOn()) {
    notify('未开云端：图不会重画。请只勾字，或用「替换」改勾选的字')
    return
  }

  if (useTextModel || useImageModel) {
    const parts = []
    if (useTextModel) parts.push(`改字 ${planned.length} 次`)
    if (useImageModel) parts.push(`重画 ${images.length} 次`)
    const ok = window.confirm(`将调用云端（${parts.join('，')}），会消耗额度。确定？`)
    if (!ok) return
  }

  running = true
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
      const prompt = inpaintPrompt(kind, commandText)
      for (const span of images) {
        const img = editor.view.dom.querySelector(`img[data-block-id="${span.block_id}"]`)
        if (!img) throw new Error('找不到原图')
        const imageDataUrl = latest.get(span.block_id) || (await elementToDataUrl(img))
        const mask = seedMask(span)
        const data = await inpaintImage({
          prompt,
          imageDataUrl,
          maskDataUrl: maskToFalDataUrl(mask),
        })
        latest.set(span.block_id, await compositeMasked(imageDataUrl, data.imageUrl, mask))
      }
    }

    if (kind === 'delete') applyTextSpans(editor, planned, '')
    else if (useTextModel) {
      applyTextSpans(editor, planned, (live) => live.next || live.text)
    } else if (planned.length && (kind === 'replace' || kind === 'unify' || kind === 'rewrite')) {
      applyTextSpans(editor, planned, (live) => localNextText(live, commandText, kind))
    }

    for (const [blockId, src] of latest) {
      if (!setImageSrcByBlockId(editor, blockId, src)) throw new Error('写回图片失败')
    }

    ping()
    const skippedImage = wantImage && !useImageModel
    const extraNote = extraTexts.length
      ? `圈外按${scope === 'follow' ? '跟随' : '锚点'}改了 ${extraTexts.length} 处（${previewOutside(extraTexts)}）。`
      : ''
    const skippedModel = wantTextModel && !useTextModel && planned.length
    if (skippedImage && skippedModel) {
      notify(`已按输入框改字（统一风格为本地：品名/色词分开写）。${extraNote}图未动。Ctrl+Z 可撤销`)
    } else if (skippedImage) {
      notify(`已改字。${extraNote}图未动（未开云端）。Ctrl+Z 可撤销`)
    } else if (skippedModel) {
      notify(`已按输入框改字（未开云端）。${extraNote}Ctrl+Z 可撤销`)
    } else {
      notify(`已写回这一页。${extraNote}Ctrl+Z 可撤销`)
    }
  } catch (err) {
    undoLastWrite(editor)
    notify(gateMessage(err))
  } finally {
    running = false
  }
}
