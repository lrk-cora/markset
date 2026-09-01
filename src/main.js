import './styles.css'
import { applyDemoPage, createEditor, refreshDecorations } from './editor.js'
import { bindChromeKeys, renderChrome, toast } from './chrome.js'
import { fetchHealth, isClientModelGateOn, setClientModelGate } from './api.js'
import { canSnap, consumePackagingHint, consumeSkipObjectSnap, peekPackagingHint, peekSkipObjectSnap, setSnapOn, snapImageHits } from './contour.js'
import {
  hitImageAt,
  hitImages,
  hitPageSlot,
  hitText,
  hitWordAt,
  isTinyImageSpan,
  looksLikePriceBleed,
} from './hit-test.js'
import { bindLasso, isAddMode, isColorMode, isLassoMode, isSubtractMode, setLassoMode, setSubtractMode } from './overlay.js'
import { applyScopeAfterSelect, describeScopeResult } from './scope.js'
import { guessStrokePrompt } from './vision-tasks.js'
import { exitToView } from './view-mode.js'
import {
  appendSpans,
  applyImageStroke,
  clearAll,
  coversTextPos,
  eraseImageSpan,
  eraseSlots,
  getSnapshot,
  refreshImageLayout,
  replaceSpans,
  subscribe,
  undoLastInsert,
  unionImageSpan,
} from './store.js'

const editor = createEditor(document.getElementById('editor'))
applyDemoPage(editor, 'a')

subscribe(() => {
  refreshDecorations(editor)
  refreshImageLayout(editor.view)
  renderChrome(editor)
})

bindChromeKeys(editor)
setLassoMode(true)
forceModelsOff()
renderChrome(editor)

function forceModelsOff() {
  setClientModelGate(false)
  setSnapOn(false)
  const allow = document.getElementById('allow-models')
  const snap = document.getElementById('snap-contour')
  if (allow) {
    allow.checked = false
    allow.closest('label')?.classList.remove('is-on')
  }
  if (snap) {
    snap.checked = false
    snap.closest('label')?.classList.remove('is-on')
  }
}

let currentPage = 'a'
document.querySelectorAll('[data-demo-page]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const id = btn.getAttribute('data-demo-page')
    if (!id || id === currentPage) return
    currentPage = id
    clearAll()
    applyDemoPage(editor, id)
    document.querySelectorAll('[data-demo-page]').forEach((el) => {
      el.classList.toggle('is-on', el.getAttribute('data-demo-page') === id)
    })
    toast(id === 'b' ? '已换到页 B（锚点演示：杯身已是雾蓝）' : '已换到页 A（标题/正文/规格都有「原木杯」）')
  })
})

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
      ? '之后圈图松手会自动贴到物体（每次消耗 fal 额度）。不勾则保持鼠标圈的范围'
      : '已关闭自动贴物体，选区保持鼠标圈的范围',
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
  if (isSubtractMode() || isAddMode() || isColorMode()) setLassoMode(true)
  else setLassoMode(!isLassoMode())
})
document.getElementById('btn-subtract')?.addEventListener('click', () => {
  setSubtractMode(!isSubtractMode())
})

let ignoreClickUntil = 0

function finishSelect(extra = []) {
  return applyScopeAfterSelect(editor.view, extra)
}

function hintAfterSelect(spans, result) {
  const bits = []
  const msg = describeScopeResult(result, getSnapshot().scope)
  if (msg) bits.push(msg)
  if (looksLikePriceBleed(spans)) bits.push('价格是禁改区，请拖蓝条剔出或不要勾选')
  const hasText = spans.some((s) => s.kind === 'text')
  const hasImage = spans.some((s) => s.kind === 'image')
  if (hasText && hasImage) bits.push('只改字、图不动：取消勾选图上的 #I，或改用范围「锚点」')
  if (hasImage) bits.push('圈多了桌子用 Alt 减选，不要点 ×')
  if (bits.length) toast(bits.join('。'), 4800)
}

function applyHits(textHits, imageHits, polygon, { append, subtract, add, color }) {
  const suggests = [...textHits.suggest]
  const imgs = [...imageHits.found, ...((append || subtract || add || color) ? imageHits.suggest : [])]
  if (!append && !subtract && !add && !color) suggests.push(...imageHits.suggest)

  if (subtract) {
    let did = false
    for (const img of imgs) {
      if (eraseImageSpan(img, polygon)) did = true
    }
    if (eraseSlots(polygon)) did = true
    toast(did ? '已圈掉不要的部分' : '先圈要留的，再按住 Alt 圈不要的（桌边、空隙）。不要点 ×')
    return
  }

  if (color) {
    let did = false
    for (const img of imgs) {
      if (applyImageStroke(img, polygon)) did = true
    }
    toast(did ? '已记下笔迹范围。写要求后点统一风格（未开云端则本地调色）' : '色笔请涂在图上')
    if (did) {
      finishSelect(suggests)
      guessStrokePrompt(editor, toast)
    }
    return
  }

  if (add) {
    let did = false
    for (const img of imgs) {
      if (unionImageSpan(img, polygon)) did = true
      else {
        appendSpans([img], editor.view.state.doc)
        did = true
      }
    }
    toast(did ? '已扩大图上选区' : '加笔请圈在图上。也可先圈一块再加')
    if (did) finishSelect(suggests)
    return
  }

  if (append) {
    const extra = [...textHits.found, ...imgs]
    if (!imgs.length && !textHits.found.length) {
      const slot = hitPageSlot(polygon, editor.view)
      if (slot) extra.push(slot)
    }
    if (extra.length) {
      appendSpans(extra, editor.view.state.doc)
      const addedImg = extra.filter((s) => s.kind === 'image').length
      if (consumePackagingHint() && addedImg) {
        toast('已加上包装上的字（不贴物体）。再点「统一风格」或「替换」', 4200)
        finishSelect(suggests)
      } else {
        toast(addedImg ? '已另作编号加上这块图（一张图两件货用 Shift 再圈）' : '已加上')
        hintAfterSelect(extra, finishSelect(suggests))
      }
    } else if (suggests.length) finishSelect(suggests)
    else toast('按住 Shift 再圈可加上；Alt 圈不要的可挖掉')
    return
  }

  const next = [...textHits.found, ...imageHits.found]
  if (!next.length) {
    if (suggests.length) {
      finishSelect(suggests)
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
  if (consumePackagingHint() && next.some((s) => s.kind === 'image')) {
    toast('已加上包装上的字（不贴物体）。再点「统一风格」或「替换」', 4200)
    finishSelect(suggests)
    return
  }
  hintAfterSelect(next, finishSelect(suggests))
}

bindLasso({
  onBegin() {
    ignoreClickUntil = Number.POSITIVE_INFINITY
  },
  onFinish(polygon, { shift, subtract, add, color }) {
    ignoreClickUntil = performance.now() + 400
    const textHits = hitText(editor.view, polygon, { skipCovered: shift && !subtract })
    const imageHits = hitImages(editor.view, polygon)
    const hasImage = imageHits.found.length + imageHits.suggest.length > 0
    const apply = (images) =>
      applyHits(textHits, images, polygon, {
        append: (shift && !subtract && !add && !color) || (peekPackagingHint() && hasImage),
        subtract,
        add,
        color,
      })
    const skipSnap = peekSkipObjectSnap() && hasImage
    const hasBig = [...imageHits.found, ...imageHits.suggest].some((s) => !isTinyImageSpan(s))
    if (subtract || add || color || skipSnap || !canSnap() || !hasBig) {
      if (skipSnap) consumeSkipObjectSnap()
      apply(imageHits)
      return
    }
    snapImageHits(imageHits, { polygon }, toast).then(apply)
  },
  onCancel({ drew } = {}) {
    ignoreClickUntil = drew ? performance.now() + 200 : 0
  },
})

function isDrawing() {
  return isLassoMode() || isSubtractMode() || isAddMode() || isColorMode()
}

window.addEventListener(
  'click',
  (e) => {
    if (performance.now() < ignoreClickUntil) {
      e.preventDefault()
      return
    }
    const target = e.target instanceof Element ? e.target : e.target.parentElement
    if (target?.closest('.chrome-layer, .inspector, .topbar, .suggest, .toolbar')) return

    const hasSpans = getSnapshot().spans.length > 0
    if (!isDrawing() && !hasSpans) return

    const image = hitImageAt(editor.view, e.clientX, e.clientY)
    const word = image ? null : hitWordAt(editor.view, e.clientX, e.clientY)
    if (!image && !word) {
      if (!hasSpans) return
      e.preventDefault()
      exitToView()
      toast('已结束编辑。这是改后的页面。点「套索」可继续改，「撤回」可撤销')
      return
    }

    if (image) {
      e.preventDefault()
      const subtract = isSubtractMode() || e.altKey || e.ctrlKey
      const finish = (span) => {
        if (subtract) {
          if (!eraseImageSpan(span, span.polygon)) toast('按住 Alt，圈不要的区域。不要点 ×')
          return
        }
        appendSpans([span])
        if (consumePackagingHint()) toast('已加上包装上的字（不贴物体）。再点「统一风格」或「替换」', 4200)
        else toast('已另作编号加上这块图（一张图两件货用 Shift 再圈）')
        finishSelect()
      }
      if (!subtract && canSnap() && !(peekSkipObjectSnap() && consumeSkipObjectSnap()) && !isTinyImageSpan(image)) {
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

    if (word) {
      e.preventDefault()
      if (coversTextPos(word.from)) return
      appendSpans([word], editor.view.state.doc)
      hintAfterSelect([word], finishSelect())
    }
  },
  true,
)

window.addEventListener('resize', () => {
  refreshImageLayout(editor.view)
  renderChrome(editor)
})
