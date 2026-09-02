import { insertImageAt, insertParagraphAt, newBlockId, pageRelativeRect } from './editor.js'
import { blockRange } from './hit-test.js'
import { tintedMaskCanvas } from './mask.js'
import { isAddMode, isColorMode, isLassoMode, isSubtractMode, setAddMode, setColorMode, setSubtractMode } from './overlay.js'
import { applyScopeAfterSelect, visibleSuggests } from './scope.js'
import { snapExistingMark } from './contour.js'
import { findSame as runFindSame } from './vision-tasks.js'
import { runWriteback } from './writeback.js'
import { redoChange, restoreChange } from './changes.js'
import {
  appendSpans,
  beginInsertUndo,
  canUndoInsert,
  clearAll,
  finishInsert,
  getSnapshot,
  hasImage,
  hasSlot,
  ping,
  refreshImageLayout,
  removeMark,
  setAnchors,
  setChangeActive,
  setCommandText,
  setScope,
  targets,
  toggleBackground,
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

export function toast(message, ms = 2200) {
  const el = document.getElementById('toast')
  el.hidden = false
  el.textContent = message
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    el.hidden = true
  }, ms)
}

function textAnchor(view, span) {
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
  if (span.maskCanvas && span.imageRect) {
    const overlay = tintedMaskCanvas(span.maskCanvas)
    overlay.className = 'image-mask-canvas'
    overlay.style.left = `${span.imageRect.x}px`
    overlay.style.top = `${span.imageRect.y}px`
    overlay.style.width = `${span.imageRect.w}px`
    overlay.style.height = `${span.imageRect.h}px`
    layer.append(overlay)
  }
  if (!span.screenRect) return
  boxes.push(span.screenRect)
  anchors[span.markId] = { x: span.screenRect.x, y: span.screenRect.y }
  if (span.mode !== 'background') addImageHandles(layer, span)
}

function addSlot(layer, span, boxes, anchors) {
  if (!span.screenRect) return
  const box = document.createElement('div')
  box.className = 'slot-mask'
  box.style.left = `${span.screenRect.x}px`
  box.style.top = `${span.screenRect.y}px`
  box.style.width = `${span.screenRect.w}px`
  box.style.height = `${span.screenRect.h}px`
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
  const slots = slotTargets()
  if (!slots.length) {
    toast('先圈页上还没有字和图的空白（不要圈照片里的桌子）')
    return
  }
  const text = getSnapshot().commandText.trim()
  if (!text) {
    toast('在输入框里写要插入的文字')
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
  if (!slots.length) {
    toast('先圈页上还没有字和图的空白（不要圈照片里的桌子）')
    return
  }
  const slot = [...slots].sort((a, b) => a.screenRect.y - b.screenRect.y)[0]
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.addEventListener('change', async () => {
    const file = input.files?.[0]
    if (!file) return
    const current = slotTargets()
    const target =
      current.find((s) => s.markId === slot.markId) ||
      [...current].sort((a, b) => a.screenRect.y - b.screenRect.y)[0]
    if (!target) {
      toast('空白槽已不在，请再圈一次纸面')
      return
    }
    try {
      const src = await readDataUrl(file)
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
  btn.title = '用这块的大致范围调用 SAM，把选区贴到物体。不点则保持鼠标圈的范围。'
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
      ? '还没有选中。套索圈字、图，或页上空白。'
      : '这是改后的页面。点顶栏「套索」继续改，「撤回」撤销上次。'
    list.append(empty)
  } else {
    for (const span of snap.spans) {
      const li = document.createElement('li')
      const check = document.createElement('input')
      check.type = 'checkbox'
      check.checked = span.willEdit !== false
      check.disabled = Boolean(span.frozen)
      check.title = span.frozen ? '禁改区：价格 / 物流 / 专利' : '将改'
      check.addEventListener('change', () => toggleWillEdit(span.markId))
      const name = document.createElement('strong')
      name.textContent = `#${span.markId}`
      const detail = document.createElement('span')
      if (span.frozen) detail.textContent = `${span.text}（禁改）`
      else if (span.kind === 'text') detail.textContent = span.text
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
    empty.textContent = snap.scope === 'inside'
        ? '仅圈内：提交时只改圈中的。要改别处相同品名请用「辐射式」。'
        : snap.scope === 'follow'
          ? '辐射式不预先圈选圈外。点选一个词、写要求，再点统一风格，系统再改相同品名和印字。'
          : snap.scope === 'anchor'
            ? '锚定式不用填改法。圈已经对的杯身，点「对齐圈中」：圈内不重画，圈外矛盾色词直接改掉。'
            : '圈字时若只碰到一两个字，会出现在这里，点一下可补进选中。'
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
    btn.textContent = restored ? '改回' : '还原'
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

  layer.replaceChildren()

  for (const span of snap.spans) {
    if (span.kind === 'image') addMask(layer, span, boxes, anchors)
    else if (span.kind === 'slot') addSlot(layer, span, boxes, anchors)
    else {
      anchors[span.markId] = textAnchor(editor.view, span)
      addHandles(layer, editor.view, span)
      try {
        const a = editor.view.coordsAtPos(span.from)
        const b = editor.view.coordsAtPos(span.to)
        boxes.push({
          x: Math.min(a.left, b.left),
          y: Math.min(a.top, b.top),
          w: Math.abs(b.left - a.left) || 40,
          h: Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top),
        })
      } catch {
        /* ignore */
      }
    }
  }

  setAnchors(anchors)

  for (const span of snap.spans) {
    const anchor = anchors[span.markId]
    if (!anchor) continue
    const badge = document.createElement('div')
    badge.className = `badge${span.willEdit === false ? ' is-off' : ''}`
    badge.style.left = `${anchor.x}px`
    badge.style.top = `${anchor.y}px`

    const check = document.createElement('input')
    check.type = 'checkbox'
    check.checked = span.willEdit !== false
    check.disabled = Boolean(span.frozen)
    check.title = span.frozen
      ? '禁改区'
      : '将改：这次要不要改这一项。不要用 × 只去掉桌子。'
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

  if (snap.spans.length) {
    const bar = document.createElement('div')
    bar.className = 'toolbar'
    bar.append(bindToolbarMove(bar))

    const scopeRow = document.createElement('div')
    scopeRow.className = 'scope-row'
    for (const [id, label] of [
      ['inside', '仅圈内'],
      ['follow', '辐射式'],
      ['anchor', '锚定式'],
    ]) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = snap.scope === id ? 'is-on' : ''
      btn.textContent = label
      btn.title =
        id === 'inside'
          ? '只改圈中的。圈外不动。'
          : id === 'follow'
            ? '先圈一个词并写要求。提交后圈内和圈外相同品名一并写入。'
            : '圈中当作已对，不用填改法。点「对齐圈中」后圈外矛盾处直接改掉。'
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        setScope(id)
        applyScopeAfterSelect(editor.view)
        toast(
          id === 'inside'
            ? '范围：仅圈内。提交时只改圈中的。'
            : id === 'follow'
              ? '范围：辐射式。提交后圈内和圈外相同品名一并写入。'
              : '范围：锚定式。圈中已对、不用填改法。点「对齐圈中」即可。',
        )
      })
      scopeRow.append(btn)
    }
    bar.append(scopeRow)

    const unify = document.createElement('button')
    unify.type = 'button'
    unify.className = 'primary'
    unify.textContent = snap.scope === 'anchor' ? '对齐圈中' : '统一风格'
    unify.title = snap.scope === 'anchor' ? '圈中当作已对，不用填输入框' : '按输入框改圈中的字和图'
    unify.addEventListener('click', (e) => {
      e.stopPropagation()
      runCommand('unify', editor)
    })
    bar.append(unify)

    if (snap.scope !== 'anchor') {
      for (const [label, kind] of [
        ['改写', 'rewrite'],
        ['替换', 'replace'],
        ['删除', 'delete'],
      ]) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.textContent = label
        btn.addEventListener('click', (e) => {
          e.stopPropagation()
          runCommand(kind, editor)
        })
        bar.append(btn)
      }
    }

    const input = document.createElement('input')
    input.type = 'text'
    input.value = snap.commandText
    input.placeholder =
      snap.scope === 'anchor' ? '可留空。若要指定颜色可写：雾蓝' : '产品名、颜色，如：海盐杯，雾蓝'
    input.addEventListener('input', () => setCommandText(input.value))
    input.addEventListener('pointerdown', (e) => e.stopPropagation())
    bar.append(input)
    if (snap.scope === 'anchor') {
      const hint = document.createElement('span')
      hint.className = 'anchor-hint'
      hint.textContent = '可留空：圈中杯子就是事实。只有要指定颜色时才填。'
      bar.append(hint)
    }

    if (hasSlot()) {
      const addText = document.createElement('button')
      addText.type = 'button'
      addText.textContent = '插入文字'
      addText.title = '把输入框里的字插到圈定的纸面位置'
      addText.addEventListener('click', (e) => {
        e.stopPropagation()
        insertText(editor)
      })
      const addImage = document.createElement('button')
      addImage.type = 'button'
      addImage.textContent = '插入图片'
      addImage.title = '在圈定的纸面位置放入一张本地图片'
      addImage.addEventListener('click', (e) => {
        e.stopPropagation()
        insertImage(editor)
      })
      bar.append(addText, addImage)
    }

    if (canUndoInsert()) {
      const undo = document.createElement('button')
      undo.type = 'button'
      undo.textContent = '撤回'
      undo.title = '撤回上次写入或插入（Ctrl+Z）'
      undo.addEventListener('click', (e) => {
        e.stopPropagation()
        if (undoLastInsert(editor)) toast('已撤回上次修改')
      })
      bar.append(undo)
    }

    if (hasImage()) {
      const bg = document.createElement('button')
      bg.type = 'button'
      bg.textContent = '改背景'
      bg.title = '先圈物体，再点这里：mask 取反（整图减去物体）'
      bg.addEventListener('click', (e) => {
        e.stopPropagation()
        const mode = toggleBackground()
        if (!mode) toast('先圈杯子或图上的一块，再改背景')
        else if (mode === 'background') toast('已改为背景：整图减去刚才圈的物体。再点一次改回')
        else toast('已改回物体')
      })
      bar.append(bg)

      const findSame = document.createElement('button')
      findSame.type = 'button'
      findSame.textContent = '查找相同'
      findSame.title = '在图里找另一件相同的货。开云端后走规划 A；未开时请用 Shift 再圈'
      findSame.addEventListener('click', (e) => {
        e.stopPropagation()
        runFindSame(editor, toast)
      })
      bar.append(findSame)

      for (const [label, kind] of [
        ['＋', 'add'],
        ['－', 'subtract'],
        ['色', 'color'],
      ]) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'pen'
        btn.textContent = label
        if (kind === 'add') {
          btn.classList.toggle('is-on', isAddMode())
          btn.title = '加笔：再圈会并进当前图的选区'
        } else if (kind === 'subtract') {
          btn.classList.toggle('is-on', isSubtractMode())
          btn.title = '减笔：从选区挖掉（也可用 Alt）'
        } else {
          btn.classList.toggle('is-on', isColorMode())
          btn.title = '色笔：涂一笔，只这块会进重画范围'
        }
        btn.addEventListener('click', (e) => {
          e.stopPropagation()
          if (kind === 'subtract') {
            const on = !isSubtractMode()
            setSubtractMode(on)
            ping()
            toast(on ? '减选已开：再圈不要的部分（桌子、空隙），会从选区里挖掉。不要点 ×' : '已关闭减笔')
            return
          }
          if (kind === 'add') {
            const on = !isAddMode()
            setAddMode(on)
            ping()
            toast(on ? '加笔已开：再圈会并进当前图的选区' : '已关闭加笔')
            return
          }
          const on = !isColorMode()
          setColorMode(on)
          ping()
          toast(
            on
              ? '色笔已开：在图上涂一笔，只这块会进重画。未开云端时提交后本地调色'
              : '已关闭色笔',
          )
        })
        bar.append(btn)
      }
    }

    layer.append(bar)
    placeToolbar(bar)
  }

  addChangeBadges(layer, editor)
  renderList(editor)
  inspector.textContent = JSON.stringify(toSpec(), null, 2)
  const undoTop = document.getElementById('btn-undo')
  if (undoTop) {
    undoTop.textContent = '撤回'
    undoTop.title = '撤回上次写入或插入（Ctrl+Z）'
    undoTop.hidden = !canUndoInsert()
  }
}

export function bindChromeKeys(editor) {
  document.getElementById('btn-undo')?.addEventListener('click', () => {
    if (canUndoInsert() && undoLastInsert(editor)) toast('已撤回上次修改')
  })

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      clearAll()
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (canUndoInsert() && undoLastInsert(editor)) {
        e.preventDefault()
        toast('已撤回上次修改')
      }
    }
  })

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
