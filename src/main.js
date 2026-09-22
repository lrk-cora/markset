import './styles.css'
import { applyDemoPage, applyImportedPage, createEditor, refreshDecorations, showStartGuide } from './editor.js'
import { bindChromeKeys, renderChrome, toast } from './chrome.js'
import { fetchHealth, importPage } from './api.js'
import { canSnap, consumePackagingHint, consumeSkipObjectSnap, peekPackagingHint, peekSkipObjectSnap, setSnapOn, snapImageHits } from './contour.js'
import { aabb, classifyStrokeKind, markTargetPolygon, looksLikeBoxStroke, looksLikeDrawnLine, looksLikeEnclosingStroke } from './geometry.js'
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
import { bindLasso, getPaintMarks, getStrokeColor, isAddMode, isColorMode, isLassoMode, isLayoutPen, isSubtractMode, LAYOUT_PENS, SELECT_COLOR, setAddMode, setLassoMode, setStrokeColor, setSubtractMode } from './overlay.js'
import { applyScopeAfterSelect } from './scope.js'
import { guessStrokePrompt } from './vision-tasks.js'
import { strokeKindOptions } from './capture.js'
import { ingestLayoutStroke } from './layout.js'
import { exportWebDoc, hitWebDoc, isWebDocActive, looksLikeWebLayoutDest, pairWebLayoutDest, rememberPaintBox, unmountWebDoc } from './web-doc.js'
import { clearLocalUndos, closeHabitPanel, dismissCoach, getCard, idleCard, keepCardForAppend, openHabitPanel, openPageRecolor, applyWrittenNote, resetCardForNewSelection, resetPagePaper, setPaintGesture, shouldTreatStrokeAsInk, canUndoLocal } from './card-flow.js'
import { addInkStroke, clearInk, hasInk, isLikelyInk, onInkRecognized } from './ink.js'
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
  removeSpansByWebIds,
  replaceCommandText,
  replaceSpans,
  subscribe,
  subtractSpansByPolygon,
  undoLastInsert,
  unionImageSpan,
} from './store.js'

const editor = createEditor(document.getElementById('editor'))
showStartGuide()

subscribe(() => {
  refreshDecorations(editor)
  refreshImageLayout(editor.view)
  renderChrome(editor)
})

bindChromeKeys(editor)
setLassoMode(true)
forceModelsOff()
onInkRecognized(({ text, confident }) => {
  applyWrittenNote(text, { confident, silent: true })
})
renderChrome(editor)

function forceModelsOff() {
  setSnapOn(false)
  const snap = document.getElementById('snap-contour')
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
    unmountWebDoc()
    document.querySelectorAll('[data-demo-page]').forEach((el) => {
      el.classList.toggle('is-on', el.getAttribute('data-demo-page') === id)
    })
    toast(id === 'b' ? '已换到页 B：杯身已是雾蓝，说明还写着红色 / 原木' : '已换到页 A：标题、正文、规格都有「原木杯」')
  })
})

function resetWorkspace() {
  clearAll()
  idleCard()
  clearInk()
  clearLocalUndos()
  resetPagePaper()
  unmountWebDoc()
}

async function loadImported(payload, waitText) {
  toast(waitText)
  const page = await importPage(payload)
  resetWorkspace()
  const mode = await applyImportedPage(editor, page)
  currentPage = 'import'
  document.querySelectorAll('[data-demo-page]').forEach((el) => el.classList.remove('is-on'))
  const extra = (page.warnings || []).filter(Boolean).slice(0, 2).join('；')
  const head =
    mode === 'html'
      ? `已导入「${page.title}」，可圈选修改，导出仍是网页`
      : mode === 'snapshot'
        ? `已用整页图放入「${page.title}」，导出仍是含该图的网页`
        : `未能保住版式，已放入「${page.title}」的文字和图片`
  toast(extra ? `${head}。${extra}` : `${head}`)
}

document.getElementById('btn-import-html')?.addEventListener('click', () => {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.html,.htm,text/html'
  input.addEventListener('change', async () => {
    const file = input.files?.[0]
    if (!file) return
    try {
      const html = await file.text()
      if (!html.trim()) {
        toast('这个文件是空的')
        return
      }
      await loadImported(
        {
          html,
        },
        '正在读入 HTML…',
      )
    } catch (err) {
      toast(err.message || '没能读入这个 HTML')
    }
  })
  input.click()
})

document.getElementById('btn-export-html')?.addEventListener('click', () => {
  if (exportWebDoc()) toast('已导出为网页文件，可用浏览器打开')
  else toast('先导入 HTML 文件，再导出')
})

document.getElementById('snap-contour')?.addEventListener('change', (e) => {
  e.target.checked = false
  setSnapOn(false)
  e.target.closest('label')?.classList.remove('is-on')
  toast('云端贴物体已关掉。选区就是鼠标圈的范围')
})

document.getElementById('btn-api')?.addEventListener('click', async () => {
  try {
    const data = await fetchHealth()
    const dash = data.dashscope
      ? `百炼已接入（改字 ${data.rewriteModel}）`
      : '百炼未填 DASHSCOPE_API_KEY'
    const wanx = data.wanx || data.dashscope
      ? `万相已接入（重画 ${data.inpaintModel || 'wanx2.1-imageedit'}）`
      : '万相未接入：先填 DASHSCOPE_API_KEY 并开通 wanx2.1-imageedit'
    const fmt = []
    if (data.dashscope && data.hints && !data.hints.dashscopePrefixOk) fmt.push('百炼密钥格式请再核对')
    const gate = data.allowCalls ? '服务器允许调用' : '服务器禁止调用（MARKSET_ALLOW_MODEL_CALLS≠1）'
    toast([dash, wanx, gate, ...fmt].join('；'))
  } catch {
    toast('检查接口失败：请先 npm run dev，并在 markset/.env 填密钥')
  }
})

document.getElementById('btn-lasso')?.addEventListener('click', () => {
  if (isSubtractMode() || isAddMode() || isColorMode() || isLayoutPen()) {
    setStrokeColor(SELECT_COLOR)
    setLassoMode(true)
  } else setLassoMode(!isLassoMode())
  if (isLassoMode() && !isAddMode() && !isSubtractMode()) toast('圈选：圈要改的地方。下一笔会换成新选区')
})
document.getElementById('btn-add')?.addEventListener('click', () => {
  const on = !isAddMode()
  setAddMode(on)
  if (on) {
    toast(
      getSnapshot().spans.length || getPaintMarks().length
        ? '加选：再圈漏掉的地方，会加进当前选区。按住 Shift 也可加选'
        : '加选已打开。先圈一块，再圈漏掉的会自动加上',
    )
  }
})
document.getElementById('btn-habits')?.addEventListener('click', () => {
  const card = getCard()
  if (card.habitPanel) closeHabitPanel()
  else openHabitPanel()
})

document.getElementById('btn-subtract')?.addEventListener('click', () => {
  const on = !isSubtractMode()
  setSubtractMode(on)
  if (on) {
    toast(
      getSnapshot().spans.length || getPaintMarks().length
        ? '减选：再圈不要的部分，会从选区挖掉。按住 Alt 也可减选'
        : '先圈要留的，再点减选圈掉不要的',
    )
  }
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

function sameTextHit(a, b) {
  if (a.kind !== 'text' || b.kind !== 'text') return false
  if (a.webId && b.webId) return a.webId === b.webId
  return a.from === b.from && a.to === b.to
}

function finishSelect(extra = []) {
  return applyScopeAfterSelect(editor.view, extra)
}

function hintAfterSelect(spans) {
  if (looksLikePriceBleed(spans)) toast('价格是禁改区，请拖蓝条剔出或不要勾选', 4200)
}

function emptyPaintSpan(rawPoints, polygon) {
  const pts = rawPoints?.length ? rawPoints : polygon
  const box = aabb(pts)
  const asLine = looksLikeDrawnLine(rawPoints)
  const long = Math.max(box.w, box.h)
  if (!asLine && !(box.w > 6 && box.h > 6)) return null
  if (asLine && long < 24) return null
  return {
    kind: 'slot',
    screenRect: box,
    poly: polygon,
    paintMark: true,
    lineMark: Boolean(asLine),
    why: asLine ? 'paint-line' : 'paint-empty',
  }
}

function emptyPaintToast(slot) {
  if (slot?.lineMark) return '看成一条线。可选沿你画的方向，或水平 / 垂直的直线、波浪线、双线和粗细'
  return '没涂到字或杯子。可加阴影、空两格，或加框 / 线 / 插入'
}

function applyWebRefine(textHits, imgs, polygon, { subtract, suggests, rawPoints }) {
  const extra = [...textHits.found, ...imgs]
  if (subtract) {
    const ids = extra.map((s) => s.webId).filter(Boolean)
    let did = false
    if (ids.length && removeSpansByWebIds(ids)) did = true
    if (subtractSpansByPolygon(polygon)) did = true
    if (eraseSlots(polygon)) did = true
    keepCardForAppend()
    toast(did ? '已从选区去掉这一块' : '已记下挖掉的范围，执行时不再改这里')
    return
  }
  if (!extra.length) {
    const slot = emptyPaintSpan(rawPoints, polygon) || hitPageSlot(polygon, editor.view)
    if (slot) extra.push(slot)
  }
  if (!extra.length) {
    toast('再圈要加上的那一块')
    return
  }
  appendSpans(extra, editor.view.state.doc)
  keepCardForAppend()
  finishSelect(suggests)
  toast('已加进选区')
}

function applyHits(textHits, imageHits, polygon, { append, subtract, add, color, rawPoints }) {
  if (hasChanges()) dismissChanges()
  const suggests = [...textHits.suggest]
  const imgs = [...imageHits.found, ...((append || subtract || add || color) ? imageHits.suggest : [])]
  if (!append && !subtract && !add && !color) suggests.push(...imageHits.suggest)

  if (isWebDocActive() && (subtract || add || append)) {
    applyWebRefine(textHits, imgs, polygon, { subtract, suggests, rawPoints })
    return
  }

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
        toast(addedImg ? '已另作编号加上这块图（一张图两件货用 Shift 再圈）' : extra.some((s) => s.lineMark) ? emptyPaintToast(extra.find((s) => s.lineMark)) : extra.some((s) => s.paintMark) ? '已记下这笔。没涂到字或杯子' : '已加上')
        finishSelect(suggests)
        hintAfterSelect(extra)
      }
    } else if (suggests.length) {
      finishSelect(suggests)
    } else toast('按住 Shift 再圈可加上；Alt 圈不要的可挖掉')
    return
  }

  const objectHits = isWebDocActive()
    ? { found: imageHits.found, suggest: imageHits.suggest }
    : contentImageHits(imageHits)
  const next = [...textHits.found, ...objectHits.found]
  if (!next.length) {
    const slot = emptyPaintSpan(rawPoints, polygon) || hitPageSlot(polygon, editor.view)
    const existing = getSnapshot().spans
    const keepContent = existing.some((s) => s.kind === 'text' || s.kind === 'image')
    if (slot && keepContent) {
      keepCardForAppend()
      appendSpans([slot], editor.state.doc)
      dismissCoach()
      toast(emptyPaintToast(slot))
      return
    }
    if (slot) {
      resetCardForNewSelection()
      replaceSpans([slot])
      dismissCoach()
      toast(emptyPaintToast(slot))
      return
    }
    if (suggests.length) {
      finishSelect(suggests)
      return
    }
    toast('涂过字或杯子，或在空白处画一笔')
    return
  }
  resetCardForNewSelection()
  replaceSpans(next)
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
  if (looksLikeDrawnLine(rawPoints)) return null
  const box = aabb(rawPoints)
  const compact =
    box.w >= 10 && box.h >= 10 && box.w <= 110 && box.h <= 110 && box.w / Math.max(1, box.h) >= 0.4 && box.w / Math.max(1, box.h) <= 2.5
  if (!looksLikeBoxStroke(rawPoints) && !compact) return null
  if (isWebDocActive()) {
    const hits = hitWebDoc(polygon)
    if (hits.images.found.length) return null
    const text = hits.texts.found[0]
    if (!text?.webId || !text.screenRect) return null
    const coversText = box.x + box.w > text.screenRect.x + 10
    if (coversText) return null
    return {
      kind: 'slot',
      indentMark: true,
      webId: text.webId,
      block_id: text.block_id,
      screenRect: box,
      poly: polygon,
      why: 'indent-box',
    }
  }
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

function symbolHitPoly(rawPoints, shape = '') {
  return markTargetPolygon(rawPoints, shape)
}

bindLasso({
  onBegin() {
    ignoreClickUntil = Number.POSITIVE_INFINITY
  },
  onFinish(polygon, flags = {}) {
    ignoreClickUntil = performance.now() + 400
    let { shift, subtract, add, color, rawPoints } = flags
    const priorSel =
      getSnapshot().spans.some((s) => s.layoutRole !== 'dest') ||
      getPaintMarks().some((m) => m.role !== 'subtract' && m.role !== 'symbol' && m.points?.length >= 3)
    if ((add || shift) && !subtract && !priorSel) {
      add = false
      shift = false
    }
    const kindOpts = strokeKindOptions()
    const strokeKind =
      subtract || add || shift || color || isLayoutPen()
        ? { kind: add || shift ? 'refine' : subtract ? 'refine' : 'select', shape: '', label: '', fingerprint: '' }
        : classifyStrokeKind(rawPoints, { ...kindOpts, refine: false })
    const asMark = strokeKind.kind === 'symbol' || strokeKind.kind === 'symbol-target'
    let hitPoly = polygon
    if (strokeKind.kind === 'symbol-target') hitPoly = symbolHitPoly(rawPoints, strokeKind.shape)
    if (
      !asMark &&
      !shift &&
      !subtract &&
      !add &&
      !color &&
      !isLayoutPen() &&
      (shouldTreatStrokeAsInk(rawPoints) ||
        (hasInk() && isLikelyInk(rawPoints, { hasSelection: true, hasNewContent: false, ...kindOpts })))
    ) {
      addInkStroke(rawPoints)
      return false
    }
    if (rawPoints?.length) setPaintGesture(rawPoints, { silent: true, kind: strokeKind })
    if (strokeKind.kind === 'symbol') {
      addInkStroke(rawPoints)
      keepCardForAppend()
      dismissCoach()
      toast(`认出${strokeKind.label}，已留在圈上。请点「开始判断」确认后再执行`)
      return { append: true, role: 'symbol', shape: strokeKind.shape, fingerprint: strokeKind.fingerprint }
    }
    if (hitPoly?.length) rememberPaintBox(hitPoly, { union: add || shift, subtract })
    const webHits = isWebDocActive()
      ? hitWebDoc(hitPoly, { loose: strokeKind.kind === 'symbol-target' || looksLikeEnclosingStroke(rawPoints) })
      : null
    const textHits = webHits ? webHits.texts : hitText(editor.view, hitPoly, { skipCovered: shift && !subtract })
    const rawImageHits = webHits ? webHits.images : hitImages(editor.view, hitPoly)
    const imageHits =
      subtract || add || color || isWebDocActive() ? rawImageHits : contentImageHits(rawImageHits)
    const hasImage = imageHits.found.length + imageHits.suggest.length > 0
    const selected = getSnapshot().spans
    const newText = textHits.found.filter((s) => !selected.some((c) => sameTextHit(c, s)))
    const newImg = imageHits.found.filter(
      (s) =>
        (s.webId || !isTinyImageSpan(s)) &&
        !selected.some((c) => c.kind === 'image' && ((c.webId && s.webId && c.webId === s.webId) || c.block_id === s.block_id)),
    )
    if (
      !asMark &&
      !shift &&
      !subtract &&
      !add &&
      !color &&
      !isLayoutPen() &&
      isLikelyInk(rawPoints, {
        hasSelection: selected.length > 0,
        hasNewContent: newText.length + newImg.length > 0,
        ...kindOpts,
      })
    ) {
      addInkStroke(rawPoints)
      return false
    }
    if (subtract && !getSnapshot().spans.length && !getPaintMarks().length) {
      toast('先圈要留的，再点减选圈掉不要的')
      return false
    }
    if (
      isWebDocActive() &&
      !subtract &&
      !add &&
      !color &&
      !asMark &&
      looksLikeWebLayoutDest(rawPoints, polygon)
    ) {
      clearInk()
      keepCardForAppend()
      pairWebLayoutDest(rawPoints, polygon, getStrokeColor())
      dismissCoach()
      toast('已把后一圈当成落点，不会当成新选区。可点「移到画出的位置」')
      return { append: true }
    }
    if (isLayoutPen() && !subtract && !add && !color) {
      clearInk()
      const result = ingestLayoutStroke(editor, {
        color: getStrokeColor(),
        polygon,
        rawPoints,
        textHits,
        imageHits: rawImageHits,
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
    if (!(shift || subtract || add || color || asMark)) clearInk()
    const apply = (images) =>
      applyHits(textHits, images, hitPoly, {
        append: (shift && !subtract && !add && !color) || (peekPackagingHint() && hasImage),
        subtract,
        add,
        color,
        rawPoints,
      })
    const skipSnap = isWebDocActive() || (peekSkipObjectSnap() && hasImage)
    const hasBig = [...imageHits.found, ...imageHits.suggest].some((s) => !isTinyImageSpan(s))
    const persistMark = asMark
      ? { role: 'symbol', shape: strokeKind.shape, fingerprint: strokeKind.fingerprint }
      : undefined
    if (subtract || add || color || skipSnap || !canSnap() || !hasBig) {
      if (skipSnap) consumeSkipObjectSnap()
      apply(imageHits)
      if (strokeKind.kind === 'symbol-target' && strokeKind.shape) {
        toast(`认出${strokeKind.label}，已点中这块。请点「开始判断」确认后再执行`)
      }
      return persistMark
    }
    snapImageHits(imageHits, { polygon: hitPoly }, toast).then(apply)
    return persistMark
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
    const target = e.target instanceof Element ? e.target : e.target.parentElement
    if (target?.closest('.chrome-layer, .inspector, .topbar, .suggest, .toolbar, .novice-card, .coach, .change-badge, .scheme-tag')) return
    if (performance.now() < ignoreClickUntil) {
      e.preventDefault()
      return
    }

    const hasSpans = getSnapshot().spans.length > 0
    const changing = hasChanges()
    if (!isDrawing() && !hasSpans && !changing) {
      if (canUndoLocal() && !getCard().hideCard) {
        idleCard({ accept: true })
        toast('已收下这次修改')
      }
      return
    }

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
        idleCard({ accept: true })
        toast('已收下这次修改')
        return
      }
      if (!hasSpans) {
        idleCard({ accept: true })
        toast('已收下这次修改')
        return
      }
      exitToView()
      idleCard({ accept: true })
      toast('已收下这次修改')
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
