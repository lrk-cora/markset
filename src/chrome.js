import { insertImageAt, insertParagraphAt, newBlockId, pageRelativeRect } from './editor.js'
import { insertWebImage, insertWebText, isWebDocActive, liveScreenRect, listWebEdits, redoWebEdit, restoreWebEdit, webEditAnchor } from './web-doc.js'
import { blockRange } from './hit-test.js'
import { tintedMaskCanvas } from './mask.js'
import { isLassoMode } from './overlay.js'
import { applyScopeAfterSelect, visibleSuggests } from './scope.js'
import { snapExistingMark } from './contour.js'
import { redoChange, restoreChange } from './changes.js'
import { colorFill, paperFill, parseHexColor, pickerSwatches } from './colors.js'
import {
  addCoachMarks,
  canUndoLocal,
  clickGuessAt,
  eraseWrittenNote,
  fillNoviceCard,
  getCard,
  idleCard,
  peekLocalUndoAt,
  peekLocalUndoLabel,
  closeSchemeSlot,
  restoreSchemeModuleColor,
  setSchemeModuleColor,
  startReview,
  toggleSchemeSlot,
  undoLastLocalAction,
} from './card-flow.js'
import { moduleSwatch } from './scheme.js'
import { clearInk, hasInk, undoLastInkStroke } from './ink.js'
import {
  appendSpans,
  beginInsertUndo,
  canUndoInsert,
  clearAll,
  lastWriteUndoAt,
  finishInsert,
  getSnapshot,
  refreshImageLayout,
  replaceCommandText,
  removeMark,
  setAnchors,
  setChangeActive,
  targets,
  toggleWillEdit,
  undoLastInsert,
  updateImageScreenRect,
  updateTextRange,
  toSpec,
} from './store.js'

const TOOLBAR_POS_KEY = 'markset-toolbar-pos'

let toastTimer = 0
let drag = null
let barDrag = null
let toolbarPos = loadToolbarPos()

function loadToolbarPos() {
  try {
    const raw = localStorage.getItem(TOOLBAR_POS_KEY)
    if (!raw) return null
    const pos = JSON.parse(raw)
    if (typeof pos?.x !== 'number' || typeof pos?.y !== 'number') return null
    return pos
  } catch {
    return null
  }
}

function saveToolbarPos(pos) {
  toolbarPos = pos
  try {
    if (pos) localStorage.setItem(TOOLBAR_POS_KEY, JSON.stringify(pos))
    else localStorage.removeItem(TOOLBAR_POS_KEY)
  } catch {
    /* ignore */
  }
}

function clampToolbarPos(x, y, bar) {
  const w = bar?.offsetWidth || 420
  const h = bar?.offsetHeight || 96
  return {
    x: Math.min(Math.max(8, x), Math.max(8, window.innerWidth - w - 8)),
    y: Math.min(Math.max(56, y), Math.max(56, window.innerHeight - h - 8)),
  }
}

function dockToolbarPos(bar) {
  return clampToolbarPos(16, window.innerHeight - (bar?.offsetHeight || 96) - 20, bar)
}

function placeToolbar(bar) {
  const pos = clampToolbarPos(
    (toolbarPos ?? dockToolbarPos(bar)).x,
    (toolbarPos ?? dockToolbarPos(bar)).y,
    bar,
  )
  bar.style.left = `${pos.x}px`
  bar.style.top = `${pos.y}px`
}

function bindToolbarMove(bar) {
  const grip = document.createElement('button')
  grip.type = 'button'
  grip.className = 'toolbar-grip'
  grip.title = '拖到别处，避免挡住正文或图。双击回到左下角'
  grip.setAttribute('aria-label', '拖动工具栏')
  grip.textContent = '⋮⋮'
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const rect = bar.getBoundingClientRect()
    barDrag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top }
    bar.classList.add('is-moving')
    grip.setPointerCapture(e.pointerId)
  })
  grip.addEventListener('pointermove', (e) => {
    if (!barDrag) return
    e.preventDefault()
    const next = clampToolbarPos(e.clientX - barDrag.dx, e.clientY - barDrag.dy, bar)
    bar.style.left = `${next.x}px`
    bar.style.top = `${next.y}px`
    toolbarPos = next
  })
  const endMove = () => {
    if (!barDrag) return
    barDrag = null
    bar.classList.remove('is-moving')
    const rect = bar.getBoundingClientRect()
    saveToolbarPos(clampToolbarPos(rect.left, rect.top, bar))
  }
  grip.addEventListener('pointerup', endMove)
  grip.addEventListener('pointercancel', endMove)
  grip.addEventListener('dblclick', (e) => {
    e.preventDefault()
    e.stopPropagation()
    saveToolbarPos(null)
    placeToolbar(bar)
  })
  return grip
}

export function toast(message, ms = 3200) {
  const el = document.getElementById('toast')
  el.hidden = false
  el.textContent = message
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    el.hidden = true
  }, ms)
}

function textAnchor(view, span) {
  const box = liveScreenRect(span)
  if (box) return { x: box.x, y: box.y }
  try {
    const coords = view.coordsAtPos(span.from)
    return { x: coords.left, y: coords.top }
  } catch {
    return { x: 24, y: 72 }
  }
}

function unionRect(rects) {
  let x = Infinity
  let y = Infinity
  let r = -Infinity
  let b = -Infinity
  for (const box of rects) {
    x = Math.min(x, box.x)
    y = Math.min(y, box.y)
    r = Math.max(r, box.x + box.w)
    b = Math.max(b, box.y + box.h)
  }
  if (!Number.isFinite(x)) return null
  return { x, y, w: r - x, h: b - y }
}

function suggestRect(view, item) {
  if (item.screenRect) return item.screenRect
  if (item.kind !== 'text') return null
  try {
    const start = view.domAtPos(item.from)
    const end = view.domAtPos(item.to)
    const range = document.createRange()
    range.setStart(start.node, start.offset)
    range.setEnd(end.node, end.offset)
    const rects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1)
    if (rects.length) {
      return unionRect(
        rects.map((r) => ({ x: r.left, y: r.top, w: r.width, h: r.height })),
      )
    }
    const a = view.coordsAtPos(item.from)
    const b = view.coordsAtPos(item.to)
    return {
      x: a.left,
      y: a.top,
      w: Math.max(24, Math.abs(b.left - a.left)),
      h: Math.max(18, a.bottom - a.top),
    }
  } catch {
    return null
  }
}

function suggestLabel(item) {
  if (item.suggestReason === 'same') return '相同文案，加入'
  if (item.suggestReason === 'short') return '字太短，加入'
  if (item.suggestReason === 'semantic') return '语义辅改，加入'
  if (item.suggestReason === 'print') return '盒侧印字，加入'
  if (item.suggestReason === 'contradiction') return '矛盾处，加入'
  return '建议加入'
}

function addMask(layer, span, boxes, anchors) {
  const live = liveScreenRect(span)
  if (live) {
    span = { ...span, screenRect: live, imageRect: span.kind === 'image' ? live : span.imageRect }
  }
  if (span.maskCanvas && span.imageRect) {
    const overlay = tintedMaskCanvas(span.maskCanvas)
    overlay.className = `image-mask-canvas${span.willEdit === false ? ' is-off' : ''}`
    overlay.style.left = `${span.imageRect.x}px`
    overlay.style.top = `${span.imageRect.y}px`
    overlay.style.width = `${span.imageRect.w}px`
    overlay.style.height = `${span.imageRect.h}px`
    layer.append(overlay)
  }
  const box = span.screenRect || span.imageRect
  if (!box) return
  boxes.push(box)
  anchors[span.markId] = { x: box.x, y: box.y }
  if (span.screenRect && span.mode !== 'background') addImageHandles(layer, span)
}

function addSlot(layer, span, boxes, anchors) {
  if (!span.screenRect) return
  const box = document.createElement('div')
  box.className = 'slot-mask'
  box.style.left = `${span.screenRect.x}px`
  box.style.top = `${span.screenRect.y}px`
  box.style.width = `${span.screenRect.w}px`
  box.style.height = `${span.screenRect.h}px`
  if (span.layoutColor) {
    box.style.setProperty('--slot', span.layoutColor)
    box.style.outlineColor = span.layoutColor
    box.style.background = `${span.layoutColor}22`
  }
  layer.append(box)
  boxes.push(span.screenRect)
  anchors[span.markId] = { x: span.screenRect.x, y: span.screenRect.y }
}

function addImageHandles(layer, span) {
  const box = span.screenRect
  if (!box) return
  const places = {
    nw: [box.x, box.y],
    n: [box.x + box.w / 2, box.y],
    ne: [box.x + box.w, box.y],
    e: [box.x + box.w, box.y + box.h / 2],
    se: [box.x + box.w, box.y + box.h],
    s: [box.x + box.w / 2, box.y + box.h],
    sw: [box.x, box.y + box.h],
    w: [box.x, box.y + box.h / 2],
  }
  for (const [dir, [x, y]] of Object.entries(places)) {
    const handle = document.createElement('button')
    handle.type = 'button'
    handle.className = `img-handle img-handle-${dir}`
    handle.setAttribute('aria-label', '拖动以缩小或扩大图上选区')
    handle.style.left = `${x}px`
    handle.style.top = `${y}px`
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      drag = {
        type: 'image',
        markId: span.markId,
        dir,
        orig: { ...box },
        startX: e.clientX,
        startY: e.clientY,
      }
    })
    layer.append(handle)
  }
}

function resizeBox(orig, dir, dx, dy) {
  let { x, y, w, h } = orig
  if (dir.includes('n')) {
    y += dy
    h -= dy
  }
  if (dir.includes('s')) h += dy
  if (dir.includes('w')) {
    x += dx
    w -= dx
  }
  if (dir.includes('e')) w += dx
  return { x, y, w, h }
}

function addHandles(layer, view, span) {
  const live = liveScreenRect(span)
  if (span.webId && live) {
    const h = document.createElement('div')
    h.className = 'slot-mask'
    h.style.left = `${live.x}px`
    h.style.top = `${live.y}px`
    h.style.width = `${live.w}px`
    h.style.height = `${live.h}px`
    layer.append(h)
    return
  }
  try {
    const start = view.coordsAtPos(span.from)
    const end = view.coordsAtPos(span.to)
    for (const [which, coords] of [
      ['start', start],
      ['end', end],
    ]) {
      const h = document.createElement('button')
      h.type = 'button'
      h.className = `hl-handle hl-handle-${which}`
      h.setAttribute('aria-label', which === 'start' ? '缩短起点' : '缩短终点')
      h.style.left = `${coords.left}px`
      h.style.top = `${coords.top + (coords.bottom - coords.top) / 2}px`
      h.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        drag = { type: 'text', markId: span.markId, which }
      })
      layer.append(h)
    }
  } catch {
    /* ignore */
  }
}

function runCommand(kind, editor) {
  runWriteback(kind, editor, toast)
}

function slotTargets() {
  return targets()
    .filter((s) => s.kind === 'slot' && s.screenRect)
    .sort((a, b) => b.screenRect.y - a.screenRect.y)
}

function relayoutAfterInsert(editor) {
  requestAnimationFrame(() => {
    refreshImageLayout(editor.view)
    renderChrome(editor)
  })
}

function insertText(editor) {
  const text = getSnapshot().commandText.trim()
  if (!text) {
    toast('在输入框里写要插入的文字')
    return
  }
  if (isWebDocActive()) {
    const result = insertWebText(text)
    toast(result.ok ? result.message : result.reason)
    return
  }
  const slots = slotTargets()
  if (!slots.length) {
    toast('先圈页上还没有字和图的空白（不要圈照片里的桌子）')
    return
  }
  const slot = [...slots].sort((a, b) => a.screenRect.y - b.screenRect.y)[0]
  const placed = pageRelativeRect(slot.screenRect)
  beginInsertUndo(editor)
  const { mapping, span } = insertParagraphAt(editor, 0, text, newBlockId('p'), placed)
  finishInsert({
    slotId: slot.markId,
    mapping,
    doc: editor.view.state.doc,
    added: [span],
  })
  relayoutAfterInsert(editor)
  toast('已插到你圈的位置。点「撤回」或 Ctrl+Z 可撤销')
}

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

function naturalSizeOf(src) {
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve({ w: image.naturalWidth, h: image.naturalHeight })
    image.onerror = () => resolve({ w: 360, h: 360 })
    image.src = src
  })
}

function fitInSlot(slot, nat) {
  const maxW = Math.min(360, Math.max(96, Math.round(slot.screenRect.w)))
  const maxH = Math.min(360, Math.max(72, Math.round(slot.screenRect.h)))
  const scale = Math.min(maxW / Math.max(1, nat.w), maxH / Math.max(1, nat.h), 1)
  return {
    width: Math.max(48, Math.round(nat.w * scale)),
    height: Math.max(48, Math.round(nat.h * scale)),
  }
}

function insertImage(editor) {
  const slots = slotTargets()
  if (!isWebDocActive() && !slots.length) {
    toast('先圈页上还没有字和图的空白（不要圈照片里的桌子）')
    return
  }
  const slot = slots[0]
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.addEventListener('change', async () => {
    const file = input.files?.[0]
    if (!file) return
    try {
      const src = await readDataUrl(file)
      if (isWebDocActive()) {
        const result = insertWebImage(src)
        toast(result.ok ? result.message : result.reason)
        if (result.ok) startReview()
        return
      }
      const current = slotTargets()
      const target =
        current.find((s) => s.markId === slot?.markId) ||
        [...current].sort((a, b) => a.screenRect.y - b.screenRect.y)[0]
      if (!target) {
        toast('空白槽已不在，请再圈一次纸面')
        return
      }
      const nat = await naturalSizeOf(src)
      const size = fitInSlot(target, nat)
      const placed = pageRelativeRect(target.screenRect)
      beginInsertUndo(editor)
      const { mapping } = insertImageAt(editor, 0, {
        src,
        alt: file.name.replace(/\.[^.]+$/, ''),
        width: size.width,
        height: size.height,
        blockId: newBlockId('img'),
        placed,
      })
      finishInsert({
        slotId: target.markId,
        mapping,
        doc: editor.view.state.doc,
      })
      relayoutAfterInsert(editor)
      toast('已插到你圈的位置。点「撤回」或 Ctrl+Z 可撤销')
    } catch {
      toast('没能读入这张图')
    }
  })
  input.click()
}

function addSnapButton(parent, markId, className = 'snap-one') {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = className
  btn.textContent = '贴物体'
  btn.title = '云端贴物体已关掉。选区保持鼠标圈的范围。'
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    snapExistingMark(markId, toast)
  })
  parent.append(btn)
}

function renderList(editor) {
  const list = document.getElementById('selection-list')
  if (!list) return
  list.replaceChildren()
  const snap = getSnapshot()
  if (!snap.spans.length) {
    const empty = document.createElement('li')
    empty.className = 'muted'
    empty.textContent = isLassoMode()
      ? '还没有选中。先用画笔涂过字或图，再在旁边写出要做什么。'
      : '这是改后的页面。点顶栏「画笔」继续改，「撤回全部」撤销上次。'
    list.append(empty)
  } else {
    for (const span of snap.spans) {
      const li = document.createElement('li')
      const check = document.createElement('input')
      check.type = 'checkbox'
      check.checked = span.willEdit !== false
      check.disabled = Boolean(span.frozen)
      check.title = span.frozen ? '禁改区：价格 / 物流 / 专利' : '勾上才改这一块。取消勾则不改。'
      check.addEventListener('change', () => toggleWillEdit(span.markId))
      const name = document.createElement('strong')
      name.textContent = `#${span.markId}`
      const detail = document.createElement('span')
      if (span.frozen) detail.textContent = `${span.text}（禁改）`
      else if (span.kind === 'text') detail.textContent = span.text
      else if (span.indentMark) detail.textContent = '段前格子 · 再画一个可空两格'
      else if (span.paintMark) detail.textContent = '空白笔迹 · 阴影 / 空两格 / 插入'
      else if (span.kind === 'slot') detail.textContent = '页上空白 · 插入文字或图'
      else detail.textContent = span.mode === 'background' ? '图 · 背景' : '图 · 一块像素'
      li.append(check, name, detail)
      if (span.kind === 'image') addSnapButton(li, span.markId)
      list.append(li)
    }
  }

  const suggestBox = document.getElementById('suggest-list')
  if (!suggestBox || !editor) return
  suggestBox.replaceChildren()
    const suggests = visibleSuggests(editor.view, snap.suggest)
  if (!suggests.length) {
    const empty = document.createElement('li')
    empty.className = 'muted'
    empty.textContent = '圈外相同的名字不会预先加进选中。提交时按你选的「还改别处吗」一并改。'
    suggestBox.append(empty)
    return
  }
  for (const item of suggests) {
    const li = document.createElement('li')
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'suggest-add'
    btn.textContent = suggestLabel(item)
    btn.addEventListener('click', () => {
      appendSpans([item], editor.view.state.doc)
      applyScopeAfterSelect(editor.view)
    })
    const detail = document.createElement('span')
    detail.textContent = item.text || item.suggestReason
    li.append(btn, detail)
    suggestBox.append(li)
  }
}

function changeAnchor(view, item) {
  if (item.kind === 'image') {
    if (item.screenRect) return { x: item.screenRect.x, y: item.screenRect.y }
    return null
  }
  try {
    const coords = view.coordsAtPos(item.from)
    return { x: coords.left, y: coords.top }
  } catch {
    return null
  }
}

function schemeModuleAnchor(editor, module) {
  if (module.webId) {
    const r = liveScreenRect({ webId: module.webId })
    if (r) return { x: r.x + r.w + 6, y: r.y }
  }
  if (module.kind === 'paper') {
    const page = document.querySelector('.page')
    if (!page) return null
    const r = page.getBoundingClientRect()
    return { x: r.right - 12, y: r.top + 12, flip: true }
  }
  if (module.kind === 'image') {
    const img = document.querySelector(`img[data-block-id="${module.blockId || 'img-1'}"]`)
    if (!img) return null
    const r = img.getBoundingClientRect()
    return { x: r.right + 6, y: r.top }
  }
  try {
    let node = null
    if (module.blockId) {
      node = editor.view.dom.querySelector(`[data-block-id="${CSS.escape(module.blockId)}"]`)
    }
    if (!node && module.from != null) {
      const d = editor.view.domAtPos(module.from)
      const el = d.node.nodeType === 1 ? d.node : d.node.parentElement
      node = el?.closest?.('p, h1, h2, h3, li, [data-block-id]') || el
    }
    const r = node?.getBoundingClientRect?.()
    if (r && r.width) return { x: Math.max(8, r.left - 68), y: r.top }
    const c = editor.view.coordsAtPos(module.from)
    return { x: Math.max(8, c.left - 68), y: c.top }
  } catch {
    return null
  }
}

function addSchemeTags(layer, editor) {
  const card = getCard()
  if (card.intent !== 'scheme' || card.step !== 'values') return
  if (!card.schemeAssign || !card.schemeModules?.length) return
  for (const module of card.schemeModules) {
    const anchor = schemeModuleAnchor(editor, module)
    if (!anchor) continue
    const sw = moduleSwatch(card.schemeAssign, module)
    const open = card.schemeSlot === module.id
    const tag = document.createElement('div')
    tag.className = `scheme-tag${open ? ' is-open' : ''}${anchor.flip ? ' is-flip' : ''}`
    const x = Math.min(Math.max(8, anchor.x), window.innerWidth - 96)
    const y = Math.min(Math.max(48, anchor.y), window.innerHeight - 36)
    tag.style.left = `${x}px`
    tag.style.top = `${y}px`

    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `scheme-tag-btn${open ? ' is-on' : ''}`
    btn.title = `单独改：${module.label}`
    const dot = document.createElement('i')
    dot.className = 'scheme-tag-dot'
    dot.style.background = sw.fill
    const name = document.createElement('span')
    name.textContent = sw.name
    btn.append(dot, name)
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      toggleSchemeSlot(module.id)
    })
    tag.append(btn)

    if (open) {
      const pal = document.createElement('div')
      pal.className = 'scheme-tag-palette'
      const cap = document.createElement('div')
      cap.className = 'scheme-tag-cap-row'
      const capText = document.createElement('p')
      capText.className = 'scheme-tag-cap'
      capText.textContent = '只改这里'
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'scheme-tag-close'
      cancel.textContent = '取消'
      cancel.title = '关掉色板，不改颜色'
      cancel.addEventListener('click', (e) => {
        e.stopPropagation()
        closeSchemeSlot()
      })
      cap.append(capText, cancel)
      pal.append(cap)
      const currentId = module.kind === 'paper' ? card.schemeAssign.paper || '' : card.schemeAssign[module.id] || ''
      const currentFill = (
        module.kind === 'paper'
          ? String(currentId).startsWith('#')
            ? currentId
            : paperFill(currentId)
          : colorFill(currentId)
      ).toLowerCase()
      for (const swatch of pickerSwatches()) {
        const chip = document.createElement('button')
        chip.type = 'button'
        chip.className = 'scheme-tag-chip'
        const fill = module.kind === 'paper' ? paperFill(swatch.id) : swatch.fill
        const selected =
          module.kind === 'paper'
            ? fill.toLowerCase() === currentFill
            : String(currentId) === swatch.id || fill.toLowerCase() === currentFill
        if (selected) chip.classList.add('is-on')
        chip.style.background = fill
        chip.title = swatch.id
        chip.setAttribute('aria-label', swatch.id)
        chip.addEventListener('click', (e) => {
          e.stopPropagation()
          setSchemeModuleColor(editor, module.id, swatch.id, toast)
        })
        pal.append(chip)
      }
      const custom = document.createElement('label')
      custom.className = `scheme-tag-custom${String(currentId).startsWith('#') ? ' is-on' : ''}`
      const picker = document.createElement('input')
      picker.type = 'color'
      picker.value = parseHexColor(currentFill) || '#5884b0'
      picker.title = '打开调色盘'
      picker.addEventListener('pointerdown', (e) => e.stopPropagation())
      picker.addEventListener('click', (e) => e.stopPropagation())
      picker.addEventListener('change', () => {
        setSchemeModuleColor(editor, module.id, picker.value, toast)
      })
      const customName = document.createElement('span')
      customName.textContent = '调色盘'
      custom.append(picker, customName)
      pal.append(custom)
      const reset = document.createElement('button')
      reset.type = 'button'
      reset.className = 'scheme-tag-reset'
      reset.textContent = '恢复这套色'
      reset.title = '这一块改回刚才那套风格的颜色'
      reset.addEventListener('click', (e) => {
        e.stopPropagation()
        restoreSchemeModuleColor(editor, module.id, toast)
      })
      pal.append(reset)
      tag.append(pal)
    }

    layer.append(tag)
  }
}

function addWebEditBadges(layer) {
  const used = new Map()
  for (const item of listWebEdits()) {
    const anchor = webEditAnchor(item)
    if (!anchor) continue
    const key = `${Math.round(anchor.x / 8)}:${Math.round(anchor.y / 8)}`
    const n = used.get(key) || 0
    used.set(key, n + 1)
    const restored = item.keep === false
    const badge = document.createElement('div')
    badge.className = `badge change-badge${restored ? ' is-off' : ''}`
    badge.style.left = `${anchor.x}px`
    badge.style.top = `${anchor.y - 18 + n * 28}px`
    badge.addEventListener('pointerdown', (e) => e.stopPropagation())
    const tag = document.createElement('span')
    tag.className = 'tag'
    tag.textContent = restored ? '已还原' : '已改'
    badge.append(tag)
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'change-toggle'
    btn.textContent = restored ? '改回' : '撤回'
    btn.title = restored ? '再应用这一处' : '只撤回这一处'
    btn.addEventListener('pointerdown', (e) => e.stopPropagation())
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const ok = restored ? redoWebEdit(item.id) : restoreWebEdit(item.id)
      toast(ok ? (restored ? `已改回「${item.label}」` : `已撤回「${item.label}」`) : '这一处没能撤回')
    })
    badge.append(btn)
    layer.append(badge)
  }
}

function addChangeBadges(layer, editor) {
  const snap = getSnapshot()
  for (const item of snap.changes || []) {
    const anchor = changeAnchor(editor.view, item)
    if (!anchor) continue
    const badge = document.createElement('div')
    badge.className = `badge change-badge${snap.changeActive === item.id ? ' is-on' : ''}${
      item.keep === false ? ' is-off' : ''
    }${item.status === 'fail' ? ' is-fail' : ''}`
    badge.style.left = `${anchor.x}px`
    badge.style.top = `${anchor.y - 18}px`
    const restored = item.keep === false
    const label =
      item.kind === 'text'
        ? `${item.before || '（空）'} → ${restored ? item.before || '（空）' : item.after || '（删）'}`
        : '图'
    badge.title = restored ? `#${item.id} 已还原` : `#${item.id} ${label}`
    const tag = document.createElement('span')
    tag.className = 'tag'
    tag.textContent = `#${item.id}`
    badge.append(tag)
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'change-toggle'
    btn.textContent = restored ? '改回' : '还原这一处'
    btn.title = restored ? '再应用这一处' : '只还原这一处，其它改动不动'
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const run = restored ? redoChange(editor, item.id) : restoreChange(editor, item.id)
      run.then(() => toast(restored ? `已改回 #${item.id}` : `已还原 #${item.id}`))
    })
    badge.append(btn)
    badge.addEventListener('click', (e) => {
      e.stopPropagation()
      setChangeActive(item.id)
    })
    layer.append(badge)
  }
}

export function renderChrome(editor) {
  const layer = document.getElementById('chrome-layer')
  const inspector = document.getElementById('inspector-json')
  const snap = getSnapshot()
  const anchors = {}
  const boxes = []
  const corners = {}

  const typedEl = layer.querySelector('[data-typed-req]')
  const typedCaret =
    typedEl && document.activeElement === typedEl
      ? { start: typedEl.selectionStart, end: typedEl.selectionEnd }
      : null
  layer.replaceChildren()

  for (const span of snap.spans) {
    if (span.kind === 'image') {
      addMask(layer, span, boxes, anchors)
      const box = span.screenRect || span.imageRect
      if (box) corners[span.markId] = { x: box.x, y: box.y }
    } else if (span.kind === 'slot') addSlot(layer, span, boxes, anchors)
    else if (span.webId || (span.screenRect && span.from == null)) {
      const box = liveScreenRect(span)
      if (box) {
        addHandles(layer, editor.view, span)
        boxes.push(box)
        anchors[span.markId] = { x: box.x, y: box.y }
        corners[span.markId] = { x: box.x, y: box.y }
      }
    } else {
      anchors[span.markId] = textAnchor(editor.view, span)
      addHandles(layer, editor.view, span)
      try {
        const a = editor.view.coordsAtPos(span.from)
        const b = editor.view.coordsAtPos(span.to)
        const box = {
          x: Math.min(a.left, b.left),
          y: Math.min(a.top, b.top),
          w: Math.abs(b.left - a.left) || 40,
          h: Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top),
        }
        boxes.push(box)
        corners[span.markId] = { x: box.x, y: box.y }
      } catch {
        /* ignore */
      }
    }
  }

  setAnchors(anchors)

  for (const span of snap.spans) {
    if (span.kind !== 'text' && span.kind !== 'image') continue
    const corner = corners[span.markId] || anchors[span.markId]
    if (!corner) continue
    const badge = document.createElement('div')
    badge.className = `badge${span.willEdit === false ? ' is-off' : ''}`
    badge.style.left = `${corner.x}px`
    badge.style.top = `${corner.y}px`

    const check = document.createElement('input')
    check.type = 'checkbox'
    check.checked = span.willEdit !== false
    check.disabled = Boolean(span.frozen)
      check.title = span.frozen ? '禁改区' : '勾上才改这一块。取消勾则不改。'
    check.addEventListener('click', (e) => e.stopPropagation())
    check.addEventListener('change', (e) => {
      e.stopPropagation()
      toggleWillEdit(span.markId)
    })

    const tag = document.createElement('span')
    tag.className = 'tag'
    tag.textContent = `#${span.markId}`

    const x = document.createElement('button')
    x.type = 'button'
    x.className = 'x'
    x.setAttribute('aria-label', '从选中里去掉')
    x.textContent = '×'
    x.addEventListener('click', (e) => {
      e.stopPropagation()
      removeMark(span.markId)
    })

    badge.append(check, tag)
    if (span.kind === 'image') addSnapButton(badge, span.markId, 'snap-one')
    badge.append(x)
    layer.append(badge)
  }

  const suggestItems = visibleSuggests(editor.view, snap.suggest)
  for (const item of suggestItems) {
    const rect = suggestRect(editor.view, item)
    if (!rect) continue
    const s = document.createElement('div')
    s.className = `suggest${item.suggestReason ? ` is-${item.suggestReason}` : ''}`
    s.style.left = `${rect.x}px`
    s.style.top = `${rect.y}px`
    s.style.width = `${rect.w}px`
    s.style.height = `${rect.h}px`
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = suggestLabel(item)
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      appendSpans([item], editor.view.state.doc)
      applyScopeAfterSelect(editor.view)
    })
    s.append(btn)
    layer.append(s)
  }

  const card = getCard()
  const annotating =
    snap.spans.length ||
    (!card.hideCard && (card.step === 'propose' || card.step === 'values' || card.guessing))
  if (annotating) {
    const bar = document.createElement('div')
    bar.className = 'toolbar novice-card'
    bar.append(bindToolbarMove(bar))
    fillNoviceCard(bar, editor, {
      runCommand,
      insertText,
      insertImage,
      toast,
      setChangeActive,
    })
    if (bar.childElementCount > 1) {
      layer.append(bar)
      placeToolbar(bar)
    }
  }

  addCoachMarks(layer, editor)
  addChangeBadges(layer, editor)
  addWebEditBadges(layer)
  addSchemeTags(layer, editor)
  renderList(editor)
  inspector.textContent = JSON.stringify(toSpec(), null, 2)
  syncUndoButton()
  if (typedCaret) {
    const next = layer.querySelector('[data-typed-req]')
    if (next) {
      next.focus({ preventScroll: true })
      try {
        const start = Number.isFinite(typedCaret.start) ? typedCaret.start : next.value.length
        const end = Number.isFinite(typedCaret.end) ? typedCaret.end : start
        next.setSelectionRange(start, end)
      } catch {
        /* ignore */
      }
    }
  }
}

function localUndoIsLatest() {
  if (!canUndoLocal()) return false
  if (!canUndoInsert()) return true
  return peekLocalUndoAt() >= lastWriteUndoAt()
}

function syncUndoButton() {
  const undoTop = document.getElementById('btn-undo')
  if (!undoTop) return
  if (localUndoIsLatest()) {
    const label = peekLocalUndoLabel()
    undoTop.hidden = false
    undoTop.textContent = '撤回刚才'
    undoTop.title = `撤回「${label}」（Ctrl+Z）`
    return
  }
  if (canUndoInsert()) {
    undoTop.hidden = false
    undoTop.textContent = '撤回全部'
    undoTop.title = '撤回上次写入或插入（Ctrl+Z）'
    return
  }
  undoTop.hidden = true
}

function performUndo(editor) {
  if (localUndoIsLatest()) {
    const label = undoLastLocalAction(editor)
    if (label) toast(`已撤回${label}`)
    return true
  }
  if (canUndoInsert() && undoLastInsert(editor)) {
    idleCard()
    toast('已撤回整次修改')
    return true
  }
  return false
}

export function bindChromeKeys(editor) {
  const layer = document.getElementById('chrome-layer')
  if (layer && !layer.dataset.guessBound) {
    layer.dataset.guessBound = '1'
    layer.addEventListener(
      'pointerdown',
      (e) => {
        const hit = e.target instanceof Element ? e.target.closest('[data-guess-index]') : null
        if (!hit || hit.disabled) return
        e.preventDefault()
        e.stopPropagation()
        clickGuessAt(Number(hit.dataset.guessIndex), editor, hit)
      },
      true,
    )
    layer.addEventListener(
      'click',
      (e) => {
        const hit = e.target instanceof Element ? e.target.closest('[data-guess-index]') : null
        if (!hit || hit.disabled) return
        e.preventDefault()
        e.stopPropagation()
        clickGuessAt(Number(hit.dataset.guessIndex), editor, hit)
      },
      true,
    )
  }

  document.getElementById('btn-undo')?.addEventListener('click', () => {
    performUndo(editor)
  })

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (getCard().schemeSlot) {
        e.preventDefault()
        closeSchemeSlot()
        return
      }
      clearAll()
      idleCard()
      clearInk()
    }
    if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (hasInk()) {
        e.preventDefault()
        undoLastInkStroke()
        toast(hasInk() ? '已擦掉上一笔，可继续写' : '字已擦掉，可再写')
        return
      }
      if (getCard().noteText) {
        e.preventDefault()
        eraseWrittenNote()
        toast('字已擦掉，可再写')
        return
      }
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (performUndo(editor)) e.preventDefault()
    }
  })

  window.addEventListener(
    'pointerdown',
    (e) => {
      if (!getCard().schemeSlot) return
      const el = e.target instanceof Element ? e.target : e.target.parentElement
      if (el?.closest?.('.scheme-tag')) return
      closeSchemeSlot()
    },
    true,
  )

  window.addEventListener(
    'pointermove',
    (e) => {
      if (!drag) return
      e.preventDefault()
      const span = getSnapshot().spans.find((s) => s.markId === drag.markId)
      if (!span) return
      if (drag.type === 'image') {
        const dx = e.clientX - drag.startX
        const dy = e.clientY - drag.startY
        updateImageScreenRect(drag.markId, resizeBox(drag.orig, drag.dir, dx, dy))
        return
      }
      if (span.kind !== 'text') return
      const hit = editor.view.posAtCoords({ left: e.clientX, top: e.clientY })
      if (!hit) return
      const range = blockRange(editor.view.state.doc, span)
      let from = span.from
      let to = span.to
      if (drag.which === 'start') from = Math.max(range.start, Math.min(hit.pos, to - 1))
      else to = Math.min(range.end, Math.max(hit.pos, from + 1))
      updateTextRange(drag.markId, from, to, editor.view.state.doc)
    },
    true,
  )

  window.addEventListener(
    'pointerup',
    () => {
      drag = null
    },
    true,
  )
}
