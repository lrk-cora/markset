import { inpaintImage, isClientModelGateOn, rewriteText } from './api.js'
import { replaceRangeText, setImageSrcByBlockId } from './editor.js'
import { maskToFalDataUrl, makeMask, paintMask, rectToPoly } from './mask.js'
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

function applyTextFromEnd(editor, markIds, nextText) {
  const ordered = getSnapshot()
    .spans.filter((s) => s.kind === 'text' && markIds.has(s.markId))
    .sort((a, b) => b.from - a.from)
  for (const span of ordered) {
    const live = getSnapshot().spans.find((s) => s.markId === span.markId)
    if (!live || live.kind !== 'text') continue
    const text = typeof nextText === 'function' ? nextText(live) : nextText
    const mapping = replaceRangeText(editor, live.from, live.to, text)
    remapAllTextSpans(mapping, editor.view.state.doc)
  }
}

export async function runWriteback(kind, editor, notify) {
  if (running) return
  const scoped = targets().filter((s) => s.kind !== 'slot')
  if (!scoped.length) {
    notify('先勾选「将改」。取消勾选即可这次不动某一项')
    return
  }
  if (targets().length && targets().every((s) => s.kind === 'slot')) {
    notify('页上空白请用「插入文字」或「插入图片」')
    return
  }

  const commandText = getSnapshot().commandText.trim()
  const texts = scoped.filter((s) => s.kind === 'text')
  const images = scoped.filter((s) => s.kind === 'image')
  const textIds = new Set(texts.map((s) => s.markId))

  if ((kind === 'rewrite' || kind === 'unify' || kind === 'replace') && !commandText) {
    notify('先在输入框写要改成什么样')
    return
  }
  if (kind === 'delete' && images.length) {
    const ok = window.confirm('删除会抹掉勾选范围内的字，并抹掉图上那一块（重画会消耗额度）。确定？')
    if (!ok) return
  }

  const textCalls = kind === 'rewrite' || kind === 'unify' ? texts.length : 0
  const imageCalls = images.length ? images.length : 0
  const needsPaid =
    textCalls > 0 ||
    (imageCalls > 0 && (kind === 'rewrite' || kind === 'unify' || kind === 'delete' || kind === 'replace'))

  if (needsPaid && !isClientModelGateOn()) {
    notify('未勾选「允许调用云端模型」。纯替换/删字不用额度；改写、统一风格、改图会消耗额度')
    return
  }

  if (needsPaid) {
    const parts = []
    if (textCalls) parts.push(`改字 ${textCalls} 次`)
    if (imageCalls) parts.push(`重画 ${imageCalls} 次`)
    const ok = window.confirm(`将调用云端（${parts.join('，')}），会消耗额度。确定？`)
    if (!ok) return
  }

  running = true
  beginWriteUndo(editor)
  try {
    const rewriteResults = new Map()
    if (textCalls) {
      for (const span of texts) {
        const data = await rewriteText(commandText, span.text)
        rewriteResults.set(span.markId, data.text)
      }
    }

    const inpaintResults = []
    if (needsPaid && imageCalls) {
      const prompt = inpaintPrompt(kind, commandText)
      for (const span of images) {
        const img = editor.view.dom.querySelector(`img[data-block-id="${span.block_id}"]`)
        if (!img) throw new Error('找不到原图')
        const imageDataUrl = await elementToDataUrl(img)
        const mask = seedMask(span)
        const data = await inpaintImage({
          prompt,
          imageDataUrl,
          maskDataUrl: maskToFalDataUrl(mask),
        })
        inpaintResults.push({
          blockId: span.block_id,
          src: await compositeMasked(imageDataUrl, data.imageUrl, mask),
        })
      }
    }

    if (kind === 'replace') applyTextFromEnd(editor, textIds, commandText)
    else if (kind === 'delete') applyTextFromEnd(editor, textIds, '')
    else if (textCalls) {
      applyTextFromEnd(editor, textIds, (live) => rewriteResults.get(live.markId) || live.text)
    }

    for (const item of inpaintResults) {
      if (!setImageSrcByBlockId(editor, item.blockId, item.src)) throw new Error('写回图片失败')
    }

    ping()
    notify('已写回这一页。Ctrl+Z 可撤销')
  } catch (err) {
    undoLastWrite(editor)
    notify(gateMessage(err))
  } finally {
    running = false
  }
}
