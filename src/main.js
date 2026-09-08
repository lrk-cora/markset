import './styles.css'
import { applyDemoPage, createEditor, refreshDecorations } from './editor.js'
import { bindChromeKeys, renderChrome, toast } from './chrome.js'
import { fetchHealth, isClientModelGateOn, setClientModelGate } from './api.js'
import { canSnap, consumePackagingHint, consumeSkipObjectSnap, peekPackagingHint, peekSkipObjectSnap, setSnapOn, snapImageHits } from './contour.js'
import { aabb, looksLikeBoxStroke } from './geometry.js'
import {
  contentImageHits,
  findIndentTarget,
  hitImageAt,
  hitImages,
  hitPageSlot,
  hitText,
  hitWordAt,
  isTinyImageSpan,
  looksLikePriceBleed,
} from './hit-test.js'
import { bindLasso, getStrokeColor, isAddMode, isColorMode, isLassoMode, isLayoutPen, isSubtractMode, LAYOUT_PENS, SELECT_COLOR, setLassoMode, setStrokeColor, setSubtractMode } from './overlay.js'
import { applyScopeAfterSelect } from './scope.js'
import { guessStrokePrompt } from './vision-tasks.js'
import { ingestLayoutStroke } from './layout.js'
import { clearLocalUndos, dismissCoach, getCard, idleCard, keepCardForAppend, markCrossOut, openPageRecolor, applyWrittenNote, paintLooksLikeCupShadow, resetCardForNewSelection, resetPagePaper, setPaintGesture } from './card-flow.js'
import { addInkStroke, clearInk, hasInk, isLikelyInk, onInkRecognized } from './ink.js'
import { exitToView } from './view-mode.js'
import {
  appendSpans,
  applyImageStroke,
  clearAll,
  coversTextPos,
  eraseImageSpan,
  eraseSlots,
  getSnapshot,
  hasChanges,
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
onInkRecognized(({ text, confident }) => {
  applyWrittenNote(text, { confident })
  if (!text) toast('字没认清，先给通用项。可在旁边再写')
})
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
    idleCard()
    clearInk()
    clearLocalUndos()
    resetPagePaper()
    applyDemoPage(editor, id)
    document.querySelectorAll('[data-demo-page]').forEach((el) => {
      el.classList.toggle('is-on', el.getAttribute('data-demo-page') === id)
    })
    toast(id === 'b' ? '已换到页 B：杯身已是雾蓝，说明还写着红色 / 原木' : '已换到页 A：标题、正文、规格都有「原木杯」')
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
  if (isSubtractMode() || isAddMode() || isColorMode() || isLayoutPen()) {
    setStrokeColor(SELECT_COLOR)
    setLassoMode(true)
  } else setLassoMode(!isLassoMode())
})
document.getElementById('btn-subtract')?.addEventListener('click', () => {
  setSubtractMode(!isSubtractMode())
})

function bindPenColors() {
  const host = document.getElementById('pen-colors')
  if (!host) return
  const selectGroup = document.createElement('div')
  selectGroup.className = 'pen-group'
  const selectCap = document.createElement('span')
  selectCap.className = 'pen-group-label'
  selectCap.textContent = '圈选批注'
  selectGroup.append(selectCap)
  const layoutGroup = document.createElement('div')
  layoutGroup.className = 'pen-group'
  const layoutCap = document.createElement('span')
  layoutCap.className = 'pen-group-label'
  layoutCap.textContent = '调整布局'
  layoutGroup.append(layoutCap)
  for (const pen of LAYOUT_PENS) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `pen-chip${pen.id === 'select' ? ' is-on' : ''}`
    b.dataset.pen = pen.hex
    b.dataset.penId = pen.id
    b.title = pen.id === 'select' ? '圈选批注：圈要改的字或图' : `调整布局 · ${pen.label}笔：先圈模块，再用同一颜色圈落点`
    b.setAttribute('aria-label', pen.id === 'select' ? '圈选批注' : `调整布局 ${pen.label}`)
    b.style.setProperty('--pen', pen.hex)
    b.addEventListener('click', () => {
      setStrokeColor(pen.hex)
      setLassoMode(true)
      toast(
        pen.id === 'select'
          ? '蓝笔是圈选批注，圈要改的字或图'
          : `${pen.label}笔用来调整布局：先圈模块，再用同一颜色圈落点，不会画出画面`,
      )
    })
    if (pen.id === 'select') selectGroup.append(b)
    else layoutGroup.append(b)
  }
  host.append(selectGroup, layoutGroup)
}
bindPenColors()

document.getElementById('btn-recolor')?.addEventListener('click', () => {
  if (openPageRecolor(editor)) toast('点一套配色：标题、正文、杯子、纸面会各用一色。再点某一块可单独改')
  else toast('页上没有现成色词。先圈要改颜色的字或图，再在旁边写「色」')
})

let ignoreClickUntil = 0

function finishSelect(extra = []) {
  return applyScopeAfterSelect(editor.view, extra)
}

function hintAfterSelect(spans) {
  if (looksLikePriceBleed(spans)) toast('价格是禁改区，请拖蓝条剔出或不要勾选', 4200)
}

function emptyPaintSpan(rawPoints, polygon) {
  const box = aabb(rawPoints?.length ? rawPoints : polygon)
  if (!(box.w > 6 && box.h > 6)) return null
  return {
    kind: 'slot',
    screenRect: box,
    poly: polygon,
    paintMark: true,
    why: 'paint-empty',
  }
}

function applyHits(textHits, imageHits, polygon, { append, subtract, add, color, rawPoints }) {
  if (hasChanges()) dismissChanges()
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
    toast(did ? '已记下笔迹范围。未开云端则提交后本地调色' : '色笔请涂在图上')
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
    if (did) {
      keepCardForAppend()
      finishSelect(suggests)
    }
    return
  }

  if (append) {
    const objectHits = contentImageHits({ found: imgs, suggest: [] }).found
    const extra = [...textHits.found, ...objectHits]
    if (!extra.length) {
      const slot = emptyPaintSpan(rawPoints, polygon) || hitPageSlot(polygon, editor.view)
      if (slot) extra.push(slot)
    }
    if (extra.length) {
      appendSpans(extra, editor.view.state.doc)
      keepCardForAppend()
      dismissCoach()
      const addedImg = extra.filter((s) => s.kind === 'image').length
      if (consumePackagingHint() && addedImg) {
        toast('已加上包装上的字（不贴物体）', 4200)
        finishSelect(suggests)
      } else {
        toast(addedImg ? '已另作编号加上这块图（一张图两件货用 Shift 再圈）' : extra.some((s) => s.paintMark) ? '已记下这笔。没涂到字或杯子' : '已加上')
        finishSelect(suggests)
        hintAfterSelect(extra)
      }
    } else if (suggests.length) finishSelect(suggests)
    else toast('按住 Shift 再圈可加上；Alt 圈不要的可挖掉')
    return
  }

  const objectHits = contentImageHits(imageHits)
  const next = [...textHits.found, ...objectHits.found]
  if (!next.length) {
    const slot = emptyPaintSpan(rawPoints, polygon) || hitPageSlot(polygon, editor.view)
    const existing = getSnapshot().spans
    const keepContent = existing.some((s) => s.kind === 'text' || s.kind === 'image')
    if (slot && keepContent) {
      appendSpans([slot], editor.state.doc)
      keepCardForAppend()
      dismissCoach()
      toast('没涂到字或杯子。可加阴影、空两格，或加框 / 线 / 插入')
      return
    }
    if (slot) {
      replaceSpans([slot])
      resetCardForNewSelection()
      dismissCoach()
      toast('没涂到字或杯子。可加阴影、空两格，或加框 / 线 / 插入')
      return
    }
    if (suggests.length) {
      finishSelect(suggests)
      return
    }
    toast('涂过字或杯子，或在空白处画一笔')
    return
  }
  replaceSpans(next)
  resetCardForNewSelection()
  dismissCoach()
  if (consumePackagingHint() && next.some((s) => s.kind === 'image')) {
    toast('已加上包装上的字（不贴物体）', 4200)
    finishSelect(suggests)
    return
  }
  finishSelect(suggests)
  hintAfterSelect(next)
}

function indentSpanFromStroke(rawPoints, polygon) {
  const box = aabb(rawPoints)
  const compact =
    box.w >= 10 && box.h >= 10 && box.w <= 110 && box.h <= 110 && box.w / Math.max(1, box.h) >= 0.4 && box.w / Math.max(1, box.h) <= 2.5
  if (!looksLikeBoxStroke(rawPoints) && !compact) return null
  let para = findIndentTarget(editor.view, box)
  const existing = getSnapshot().spans.filter((s) => s.indentMark || (s.paintMark && s.screenRect && s.screenRect.w <= 110))
  if (!para && existing.length) {
    const prev = existing[existing.length - 1]
    const pr = prev.screenRect
    const nearPrev = pr && Math.abs(box.y - pr.y) < 100 && Math.abs(box.x - pr.x) < 120
    if (nearPrev) para = { block_id: prev.block_id, pos: prev.paraPos }
  }
  if (!para) return null
  return {
    kind: 'slot',
    indentMark: true,
    block_id: para.block_id,
    paraPos: para.pos,
    screenRect: box,
    poly: polygon,
    why: 'indent-box',
  }
}

bindLasso({
  onBegin() {
    ignoreClickUntil = Number.POSITIVE_INFINITY
  },
  onFinish(polygon, { shift, subtract, add, color, crossOut, rawPoints }) {
    ignoreClickUntil = performance.now() + 400
    if (crossOut && getSnapshot().spans.length && !shift && !subtract && !add && !color) {
      markCrossOut()
      toast('圈上打了 ×，当作删除。点一项确认')
      return false
    }
    if (
      !shift &&
      !subtract &&
      !add &&
      !color &&
      !isLayoutPen() &&
      hasInk() &&
      isLikelyInk(rawPoints, { hasSelection: true, hasNewContent: false })
    ) {
      addInkStroke(rawPoints)
      return false
    }
    const indentSpan = !subtract && !add && !color && !isLayoutPen() ? indentSpanFromStroke(rawPoints, polygon) : null
    if (indentSpan) {
      const existing = getSnapshot().spans.filter((s) => s.indentMark)
      clearInk()
      setPaintGesture(rawPoints, { silent: true })
      if (existing.length === 0) {
        replaceSpans([indentSpan])
        resetCardForNewSelection()
        dismissCoach()
        toast('再在段前画一个小方格，就会空两格')
      } else {
        appendSpans([indentSpan], editor.state.doc)
        keepCardForAppend()
        dismissCoach()
        toast('已记下两个格子。点「这段空两格」')
      }
      return
    }
    if (rawPoints?.length) setPaintGesture(rawPoints, { silent: true })
    const textHits = hitText(editor.view, polygon, { skipCovered: shift && !subtract })
    const rawImageHits = hitImages(editor.view, polygon)
    const imageHits = subtract || add || color ? rawImageHits : contentImageHits(rawImageHits)
    const hasImage = imageHits.found.length + imageHits.suggest.length > 0
    const selected = getSnapshot().spans
    const newText = textHits.found.filter((s) => !selected.some((c) => c.kind === 'text' && c.from === s.from && c.to === s.to))
    const newImg = imageHits.found.filter(
      (s) => !isTinyImageSpan(s) && !selected.some((c) => c.kind === 'image' && c.block_id === s.block_id),
    )
    const asShadow = paintLooksLikeCupShadow(rawPoints, editor)
    if (
      !shift &&
      !subtract &&
      !add &&
      !color &&
      !isLayoutPen() &&
      !asShadow &&
      isLikelyInk(rawPoints, {
        hasSelection: selected.length > 0,
        hasNewContent: newText.length + newImg.length > 0,
      })
    ) {
      addInkStroke(rawPoints)
      return false
    }
    if (isLayoutPen() && !subtract && !add && !color) {
      clearInk()
      const result = ingestLayoutStroke(editor, {
        color: getStrokeColor(),
        polygon,
        rawPoints,
        textHits,
        imageHits,
      })
      keepCardForAppend()
      dismissCoach()
      if (result.phase === 'source') {
        toast(`${result.label}笔已圈中「${result.preview}」。再用同一颜色圈要放到的位置`)
      } else if (result.phase === 'paired') {
        toast(`${result.label}笔已标明落点。可换一支颜色再挪另一块，或点「移到画出的位置」`)
      } else {
        toast(`${result.label}笔请先圈要挪的字或图，再圈它要去的位置`)
      }
      return
    }
    if (!(shift || subtract || add || color)) clearInk()
    const apply = (images) =>
      applyHits(textHits, images, polygon, {
        append: (shift && !subtract && !add && !color) || (peekPackagingHint() && hasImage),
        subtract,
        add,
        color,
        rawPoints,
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
    if (target?.closest('.chrome-layer, .inspector, .topbar, .suggest, .toolbar, .novice-card, .coach, .change-badge, .scheme-tag')) return

    const hasSpans = getSnapshot().spans.length > 0
    const changing = hasChanges()
    if (!isDrawing() && !hasSpans && !changing) return

    const image = hitImageAt(editor.view, e.clientX, e.clientY)
    const word = image ? null : hitWordAt(editor.view, e.clientX, e.clientY)
    if (!image && !word) {
      e.preventDefault()
      if (getCard().coachOn) {
        dismissCoach()
        return
      }
      if (changing) {
        dismissChanges()
        idleCard()
        toast('已收起改处标记。这是改后的页面。点「画笔」可继续改，「撤回全部」可撤销')
        return
      }
      if (!hasSpans) return
      exitToView()
      idleCard()
      toast('已结束编辑。这是改后的页面。点「画笔」可继续改，「撤回全部」可撤销')
      return
    }

    if (image) {
      e.preventDefault()
      if (changing) dismissChanges()
      const subtract = isSubtractMode() || e.altKey || e.ctrlKey
      const finish = (span) => {
        if (subtract) {
          if (!eraseImageSpan(span, span.polygon)) toast('按住 Alt，圈不要的区域。不要点 ×')
          return
        }
        appendSpans([span])
        keepCardForAppend()
        dismissCoach()
        if (consumePackagingHint()) toast('已加上包装上的字（不贴物体）', 4200)
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
      if (changing) dismissChanges()
      if (coversTextPos(word.from)) return
      appendSpans([word], editor.view.state.doc)
      keepCardForAppend()
      dismissCoach()
      finishSelect()
      hintAfterSelect([word])
    }
  },
  true,
)

window.addEventListener('resize', () => {
  refreshImageLayout(editor.view)
  renderChrome(editor)
})

document.querySelector('.stage')?.addEventListener(
  'scroll',
  () => {
    refreshImageLayout(editor.view)
    renderChrome(editor)
  },
  { passive: true },
)
