import './styles.css'
import { createEditor, refreshDecorations } from './editor.js'
import { bindChromeKeys, renderChrome, toast } from './chrome.js'
import { fetchHealth, isClientModelGateOn, setClientModelGate } from './api.js'
import { canSnap, setSnapOn, snapImageHits } from './contour.js'
import { hitImageAt, hitImages, hitPageSlot, hitText, hitWordAt } from './hit-test.js'
import { bindLasso, isLassoMode, isSubtractMode, setLassoMode, setSubtractMode } from './overlay.js'
import {
  appendSpans,
  coversTextPos,
  eraseImageSpan,
  eraseSlots,
  getSnapshot,
  refreshImageLayout,
  replaceSpans,
  setSuggest,
  subscribe,
  undoLastInsert,
  unionImageMask,
  unionImageSpan,
} from './store.js'

const editor = createEditor(document.getElementById('editor'))

subscribe(() => {
  refreshDecorations(editor)
  refreshImageLayout(editor.view)
  renderChrome(editor)
})

bindChromeKeys(editor)
renderChrome(editor)
setLassoMode(true)

document.getElementById('allow-models')?.addEventListener('change', (e) => {
  const on = e.target.checked
  setClientModelGate(on)
  e.target.closest('label')?.classList.toggle('is-on', on)
  if (!on) {
    setSnapOn(false)
    const snap = document.getElementById('snap-contour')
    if (snap) {
      snap.checked = false
      snap.closest('label')?.classList.remove('is-on')
    }
  }
  toast(on ? '已允许调用。改写/改图仍会再确认一次' : '已禁止调用云端模型')
})

document.getElementById('snap-contour')?.addEventListener('change', (e) => {
  if (e.target.checked && !isClientModelGateOn()) {
    e.target.checked = false
    toast('先勾「允许调用云端模型」，并把 .env 里 MARKSET_ALLOW_MODEL_CALLS 改为 1 后重启')
    return
  }
  setSnapOn(e.target.checked)
  e.target.closest('label')?.classList.toggle('is-on', e.target.checked)
  toast(
    e.target.checked
      ? '松手将贴物体轮廓。每次圈图会消耗 fal 额度；减选仍用本地像素'
      : '已关闭贴轮廓，仍用套索像素',
  )
})

document.getElementById('btn-api')?.addEventListener('click', async () => {
  try {
    const data = await fetchHealth()
    const dash = data.dashscope
      ? `百炼已接入（改字 ${data.rewriteModel}）`
      : '百炼未填 DASHSCOPE_API_KEY'
    const fal = data.fal ? `fal 已接入（重画 ${data.inpaintModel}）` : 'fal 未填 FAL_KEY'
    const fmt = []
    if (data.dashscope && data.hints && !data.hints.dashscopePrefixOk) fmt.push('百炼密钥格式请再核对')
    if (data.fal && data.hints && !data.hints.falPairOk) fmt.push('fal 密钥应为 id:secret')
    const gate = data.allowCalls ? '服务器允许调用' : '服务器禁止调用（MARKSET_ALLOW_MODEL_CALLS≠1）'
    toast([dash, fal, gate, ...fmt].join('；'))
  } catch {
    toast('检查接口失败：请先 npm run dev，并在 markset/.env 填密钥')
  }
})

document.getElementById('btn-lasso')?.addEventListener('click', () => {
  if (isSubtractMode()) setSubtractMode(false)
  else setLassoMode(!isLassoMode())
})
document.getElementById('btn-subtract')?.addEventListener('click', () => {
  setSubtractMode(!isSubtractMode())
})

let ignoreClickUntil = 0

function applyHits(textHits, imageHits, polygon, { append, subtract }) {
  const suggests = [...textHits.suggest]
  const imgs = [...imageHits.found, ...((append || subtract) ? imageHits.suggest : [])]
  if (!append && !subtract) suggests.push(...imageHits.suggest)

  if (subtract) {
    let did = false
    for (const img of imgs) {
      if (eraseImageSpan(img, polygon)) did = true
    }
    if (eraseSlots(polygon)) did = true
    toast(did ? '已圈掉不要的部分' : '先圈要留的，再按住 Alt 圈不要的（桌边、空隙）')
    return
  }

  if (append) {
    const leftover = []
    let expanded = false
    for (const img of imgs) {
      if (img.maskCanvas && unionImageMask(img, img.maskCanvas)) expanded = true
      else leftover.push(img)
    }
    const extra = [...textHits.found, ...leftover]
    if (!imgs.length && !textHits.found.length) {
      const slot = hitPageSlot(polygon, editor.view)
      if (slot) extra.push(slot)
    }
    if (extra.length) appendSpans(extra, editor.view.state.doc)
    if (expanded) toast('已扩大选区')
    else if (!extra.length) {
      if (suggests.length) setSuggest(suggests)
      else toast('按住 Shift 再圈可加上；Alt 圈不要的可挖掉')
    }
    if (suggests.length) setSuggest(suggests)
    return
  }

  const next = [...textHits.found, ...imageHits.found]
  if (!next.length) {
    if (suggests.length) {
      setSuggest(suggests)
      return
    }
    const slot = hitPageSlot(polygon, editor.view)
    if (slot) {
      replaceSpans([slot])
      toast('空白槽：插入会放在你圈的位置。输入框写字后点「插入文字」，或点「插入图片」')
      return
    }
    toast('圈字、图上的像素（含桌面空白），或页上空白处')
    return
  }
  replaceSpans(next)
  if (suggests.length) setSuggest(suggests)
}

bindLasso({
  onBegin() {
    ignoreClickUntil = Number.POSITIVE_INFINITY
  },
  onFinish(polygon, { shift, subtract }) {
    ignoreClickUntil = performance.now() + 400
    const textHits = hitText(editor.view, polygon, { skipCovered: shift && !subtract })
    const imageHits = hitImages(editor.view, polygon)
    const apply = (images) => applyHits(textHits, images, polygon, { append: shift && !subtract, subtract })
    if (subtract || !canSnap() || (!imageHits.found.length && !imageHits.suggest.length)) {
      apply(imageHits)
      return
    }
    snapImageHits(imageHits, { polygon }, toast).then(apply)
  },
  onCancel({ drew } = {}) {
    ignoreClickUntil = drew ? performance.now() + 200 : 0
  },
})

window.addEventListener(
  'click',
  (e) => {
    if (performance.now() < ignoreClickUntil) {
      e.preventDefault()
      return
    }
    const target = e.target instanceof Element ? e.target : e.target.parentElement
    if (target?.closest('.chrome-layer, .inspector, .topbar, .suggest')) return

    const image = hitImageAt(editor.view, e.clientX, e.clientY)
    if (image) {
      e.preventDefault()
      const subtract = isSubtractMode() || e.altKey || e.ctrlKey
      const finish = (span) => {
        const has = getSnapshot().spans.some((s) => s.kind === 'image' && s.block_id === span.block_id)
        if (has) {
          if (subtract) {
            if (!eraseImageSpan(span, span.polygon)) toast('按住 Alt，圈不要的区域')
          } else if (span.maskCanvas && unionImageMask(span, span.maskCanvas)) {
            toast('已扩大图上选区')
          } else {
            unionImageSpan(span, span.polygon)
            toast('已扩大图上选区')
          }
        } else {
          appendSpans([span])
        }
      }
      if (!subtract && canSnap()) {
        snapImageHits(
          { found: [image], suggest: [] },
          { point: { x: e.clientX, y: e.clientY } },
          toast,
        ).then((hits) => finish(hits.found[0] || image))
        return
      }
      finish(image)
      return
    }

    if (e.altKey) {
      e.preventDefault()
      return
    }

    const word = hitWordAt(editor.view, e.clientX, e.clientY)
    if (word) {
      e.preventDefault()
      if (coversTextPos(word.from)) return
      appendSpans([word], editor.view.state.doc)
    }
  },
  true,
)

window.addEventListener('resize', () => {
  refreshImageLayout(editor.view)
  renderChrome(editor)
})
