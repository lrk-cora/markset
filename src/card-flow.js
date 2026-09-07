import { COLORS, COLOR_SCHEMES } from './colors.js'
import { DEMO_CUP, getDemoPage, pageRelativeRect } from './editor.js'
import { COLOR_TERMS } from './forbidden.js'
import { aabb, convexHull, intersectBoxes, pathLength, strokeToPolygon } from './geometry.js'
import { findSameText, imageSpanFromNaturalBox } from './hit-test.js'
import { collectOutsideEdits } from './scope.js'
import {
  canUndoInsert,
  getSnapshot,
  ping,
  replaceCommandText,
  replaceSpans,
  setScope,
  keepKindsWillEdit,
  toggleBackground,
  undoLastInsert,
} from './store.js'
import { clearPaintMarks, setSubtractMode } from './overlay.js'
import { redoChange, restoreChange } from './changes.js'
import { clearInk, hasInk, undoLastInkStroke } from './ink.js'

const COACH_KEY = 'markset-coach-done'

const FOLLOW_INTENTS = new Set([
  'name',
  'color',
  'name-color',
  'scheme',
  'indent',
  'spoken',
  'formal',
  'polish',
  'underline',
  'wavy',
  'strike',
  'box',
  'highlight',
  'bold',
])

const LOCAL_ANNO = new Set(['underline', 'wavy', 'strike', 'box', 'highlight', 'bold', 'frame', 'line'])

const LOCAL_LABELS = {
  indent: '空两格',
  shadow: '阴影',
  underline: '下划线',
  wavy: '波浪线',
  strike: '删除线',
  box: '方框',
  highlight: '高亮',
  bold: '加粗',
  frame: '方框',
  line: '线条',
  'clear-anno': '去掉批注',
}

let localUndos = []

function localLabel(id) {
  return LOCAL_LABELS[id] || '这项'
}

function snapshotLocal(editor, label) {
  const img = editor?.view?.dom?.querySelector('img[data-block-id="img-1"]')
  const host = document.querySelector('.page-deco-host')
  localUndos.push({
    label,
    at: Date.now(),
    json: editor.getJSON(),
    imgFilter: img?.style.filter || '',
    imgShadow: img?.dataset.marksetShadow || '',
    decoHtml: host?.innerHTML || '',
  })
}

function withLocalUndo(editor, label, fn) {
  snapshotLocal(editor, label)
  const ok = fn()
  if (!ok) {
    localUndos.pop()
    return false
  }
  return true
}

export function canUndoLocal() {
  return localUndos.length > 0
}

export function peekLocalUndoLabel() {
  return localUndos[localUndos.length - 1]?.label || ''
}

export function peekLocalUndoAt() {
  return localUndos[localUndos.length - 1]?.at || 0
}

export function undoLastLocalAction(editor) {
  const snap = localUndos.pop()
  if (!snap) return ''
  editor.commands.setContent(snap.json)
  const img = editor?.view?.dom?.querySelector('img[data-block-id="img-1"]')
  if (img) {
    img.style.filter = snap.imgFilter
    if (snap.imgShadow) img.dataset.marksetShadow = snap.imgShadow
    else delete img.dataset.marksetShadow
  }
  const existing = document.querySelector('.page-deco-host')
  if (existing) existing.innerHTML = snap.decoHtml
  else if (snap.decoHtml) {
    const host = decoHost()
    if (host) host.innerHTML = snap.decoHtml
  }
  if (ui.step === 'values' || ui.step === 'review') {
    ui.step = 'propose'
    ui.intent = null
  }
  emit()
  return snap.label
}

export function clearLocalUndos() {
  localUndos = []
}

const NAME_IDEAS = ['海盐杯', '雾青杯', '白瓷杯', '岩灰杯', '青竹杯', '暖岩杯', '雪釉杯']
const LINE_IDEAS = ['出行不易洒', '适合热饮', '杯口厚实，手感好', '附赠杯盖，方便携带']
const ASK_IDEAS = ['语气再正式一点', '写短一些，只留卖点', '突出杯盖和容量', '不要夸张，说得朴素一点']

let ui = {
  step: 'idle',
  note: '',
  noteText: '',
  noteConfident: false,
  intent: null,
  elsewhere: 'inside',
  productName: '',
  color: '',
  scheme: '',
  moreText: '',
  printFit: '',
  nameIdea: 0,
  colorIdea: 0,
  lineIdea: 0,
  askIdea: 0,
  coachOn: !readCoachDone(),
  hintUnderOn: true,
  hintOverOn: true,
  lastPaint: null,
}

function readCoachDone() {
  try {
    return localStorage.getItem(COACH_KEY) === '1'
  } catch {
    return false
  }
}

function writeCoachDone() {
  try {
    localStorage.setItem(COACH_KEY, '1')
  } catch {
    /* ignore */
  }
}

function emit() {
  ping()
}

export function getCard() {
  return { ...ui }
}

export function dismissCoach() {
  if (!ui.coachOn) return
  ui.coachOn = false
  writeCoachDone()
  emit()
}

export function resetCardForNewSelection() {
  ui.step = 'propose'
  ui.note = ''
  ui.noteText = ''
  ui.noteConfident = false
  ui.intent = null
  ui.elsewhere = 'inside'
  ui.productName = ''
  ui.color = ''
  ui.scheme = ''
  ui.moreText = ''
  ui.printFit = ''
  ui.hintUnderOn = true
  ui.hintOverOn = true
}

export function keepCardForAppend() {
  if (ui.step === 'idle' || ui.step === 'review') {
    ui.step = 'propose'
    ui.intent = null
  }
}

export function startReview() {
  ui.step = 'review'
  ui.intent = null
}

export function idleCard() {
  ui.step = 'idle'
  ui.intent = null
  ui.note = ''
  ui.noteText = ''
  ui.noteConfident = false
  ui.lastPaint = null
  clearInk()
  clearPaintMarks()
}

export function setPaintGesture(pts, { silent = false } = {}) {
  ui.lastPaint = pts?.length ? pts.map((p) => ({ x: p.x, y: p.y })) : null
  if (!silent) emit()
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n))
}

function cupScreenBox(editor) {
  const img = editor?.view?.dom?.querySelector('img[data-block-id="img-1"]')
  const demo = DEMO_CUP[getDemoPage()]
  if (!img || !demo?.cup) return null
  return {
    img,
    cup: relScreen(img, demo.cup),
    pack: demo.pack ? relScreen(img, demo.pack) : null,
    imgRect: img.getBoundingClientRect(),
  }
}

function paintIsCupShadow(pts, cup, imgRect, pack) {
  if (!pts?.length || !cup || !imgRect) return false
  const box = aabb(pts)
  const area = box.w * box.h
  if (area < 280 || area > 240000) return false
  if (box.w < 12 || box.h < 6) return false
  const pcx = box.x + box.w / 2
  const pcy = box.y + box.h / 2
  const inBox = (r) => r && pcx >= r.x && pcx <= r.x + r.w && pcy >= r.y && pcy <= r.y + r.h
  if (inBox(cup) || inBox(pack)) return false
  const overlap = intersectBoxes(box, cup)
  const oArea = overlap ? overlap.w * overlap.h : 0
  if (oArea > area * 0.48) return false
  const near =
    pcx > cup.x - 90 &&
    pcx < cup.x + cup.w + 160 &&
    pcy > cup.y - 50 &&
    pcy < cup.y + cup.h + 180
  if (!near) return false
  const inImg =
    pcx >= imgRect.left - 24 && pcx <= imgRect.right + 36 && pcy >= imgRect.top - 24 && pcy <= imgRect.bottom + 48
  return inImg
}

export function paintLooksLikeCupShadow(pts, editor) {
  const packed = cupScreenBox(editor)
  if (!packed) return false
  return paintIsCupShadow(pts, packed.cup, packed.imgRect, packed.pack)
}

function inferShadowCss(paint, cup) {
  if (!paint?.length || !cup) return 'drop-shadow(10px 12px 14px rgba(40, 28, 18, 0.34))'
  const box = aabb(paint)
  const cx = cup.x + cup.w / 2
  const cy = cup.y + cup.h * 0.58
  const pcx = box.x + box.w / 2
  const pcy = box.y + box.h / 2
  const ox = Math.round(clamp((pcx - cx) * 0.2, -42, 42))
  const oy = Math.round(clamp((pcy - cy) * 0.2, -26, 40))
  const size = Math.max(box.w, box.h)
  const blur = Math.round(clamp(size * 0.48, 8, 46))
  const len = pathLength(paint)
  const peri = 2 * (box.w + box.h)
  const scribbly = len > peri * 1.25
  const opacity = scribbly ? 0.4 : 0.26
  return `drop-shadow(${ox}px ${oy}px ${blur}px rgba(40, 28, 18, ${opacity}))`
}

function shadowOptionLabel(paint, cup) {
  if (!paint?.length || !cup) return '给这张图加阴影'
  const box = aabb(paint)
  const dx = box.x + box.w / 2 - (cup.x + cup.w / 2)
  const dy = box.y + box.h / 2 - (cup.y + cup.h * 0.58)
  const horiz = Math.abs(dx) >= Math.abs(dy) * 0.72
  const dir = horiz ? (dx >= 0 ? '右' : '左') : dy >= 0 ? '下' : '上'
  const extra = horiz && dy > 12 ? '下' : horiz && dy < -12 ? '上' : !horiz && dx > 16 ? '右' : !horiz && dx < -16 ? '左' : ''
  return `按笔迹加${dir}${extra}阴影`
}

export function markCrossOut() {
  ui.note = 'delete'
  ui.noteText = '×'
  ui.step = 'propose'
  ui.intent = null
  emit()
}

function parseNote(text) {
  const t = String(text || '').trim()
  if (!t) return ''
  if (t === '×' || t === 'x' || t === 'X' || /删|叉|去|消/.test(t)) return 'delete'
  if (/减|短|少|精简/.test(t)) return 'cut'
  if (/添|加|插|扩/.test(t)) return 'add'
  if (/色|彩/.test(t)) return 'color'
  if (/改|换|变|润/.test(t)) return 'change'
  return 'custom'
}

export function applyWrittenNote(text, { confident = false } = {}) {
  const t = String(text || '').trim()
  ui.noteText = t
  ui.note = parseNote(t) || (t ? 'custom' : '')
  ui.noteConfident = Boolean(confident && t)
  ui.intent = null
  ui.step = 'propose'
  emit()
}

export function eraseWrittenNote() {
  clearInk()
  ui.note = ''
  ui.noteText = ''
  ui.noteConfident = false
  ui.intent = null
  ui.step = 'propose'
  emit()
}

function selectionKinds(spans = getSnapshot().spans) {
  const texts = spans.filter((s) => s.kind === 'text' && s.willEdit !== false)
  const images = spans.filter((s) => s.kind === 'image' && s.willEdit !== false)
  const slots = spans.filter((s) => s.kind === 'slot')
  return { texts, images, slots }
}

export function looksLikeTableBleed(span) {
  if (!span || span.kind !== 'image' || !span.bbox || !span.naturalSize) return false
  const cup = DEMO_CUP[getDemoPage()]?.cup
  if (!cup) return false
  const nw = span.naturalSize.w
  const nh = span.naturalSize.h
  const cupBox = {
    x: nw * cup.xRel,
    y: nh * cup.yRel,
    w: nw * cup.wRel,
    h: nh * cup.hRel,
  }
  const b = span.bbox
  const extraRight = b.x + b.w - (cupBox.x + cupBox.w)
  const extraBottom = b.y + b.h - (cupBox.y + cupBox.h)
  const areaRatio = (b.w * b.h) / Math.max(1, cupBox.w * cupBox.h)
  return extraRight > cupBox.w * 0.22 || extraBottom > cupBox.h * 0.18 || areaRatio > 1.65
}

function underSelectHint(spans) {
  const { texts, images } = selectionKinds(spans)
  if (texts.length && !images.length) return '还要改杯子的话，按住 Shift 再圈杯子。'
  if (images.length && !texts.length) return '还要改名字的话，按住 Shift 再点标题里的品名。'
  return ''
}

function hasNameHint(texts) {
  return texts.some((s) => {
    const t = s.text || ''
    return s.block_id === 'h-1' || /杯|壶|瓶|原木/.test(t) || (t.length > 0 && t.length <= 8)
  })
}

function hasColorHint(texts) {
  return texts.some((s) => COLOR_TERMS.some((c) => (s.text || '').includes(c)))
}

function looksLikeIndent(spans) {
  const marks = spans.filter((s) => s.indentMark)
  if (marks.length >= 2) return true
  if (spans.some((s) => s.kind === 'image' || s.kind === 'text')) return false
  const small = spans.filter((s) => {
    const r = s.screenRect
    return r && r.w <= 110 && r.h <= 110 && (s.indentMark || s.paintMark || s.kind === 'slot')
  })
  return small.length >= 2
}

function looksLikeShadow(spans, editor) {
  const packed = cupScreenBox(editor)
  if (!packed) return false
  if (ui.lastPaint?.length >= 6 && paintIsCupShadow(ui.lastPaint, packed.cup, packed.imgRect, packed.pack)) return true
  const slots = spans.filter((s) => s.kind === 'slot')
  const others = spans.filter((s) => s.kind !== 'slot')
  if (slots.length !== 1 || others.length) return false
  const sr = slots[0].screenRect
  if (!sr) return false
  const ir = packed.imgRect
  const gap = 36
  const near =
    sr.x < ir.right + gap && sr.x + sr.w > ir.left - gap && sr.y < ir.bottom + gap && sr.y + sr.h > ir.top - gap
  const cx = sr.x + sr.w / 2
  const cy = sr.y + sr.h / 2
  const inside = cx >= ir.left && cx <= ir.right && cy >= ir.top && cy <= ir.bottom
  return near && !inside
}

function addDecorChoices(add, { texts, images, slots, empty }) {
  if (texts.length) {
    add('underline', '加上下划线')
    add('wavy', '加上波浪线')
    add('box', '加上一个框')
    add('highlight', '加上高亮')
    add('strike', '加上删除线')
    add('bold', '加粗这段')
  }
  if (images.length) {
    add('shadow', '给这张图加阴影')
    add('frame', '给图加上边框')
    add('deco', '加标注或图案')
    add('border', '加边框、logo、线条')
  }
  if (slots.length || empty) {
    add('insert-text', '插入一段文字')
    add('insert-image', '插入图片')
    add('frame', '加上一个框')
    add('line', '加上一条线')
    add('wavy', '加上波浪线')
    add('deco', '加标注或图案')
  }
}

function proposeOptions(spans, editor) {
  const { texts, images, slots } = selectionKinds(spans)
  const empty = Boolean(slots.length && !texts.length && !images.length)
  const note = ui.note
  const bits = []
  const add = (id, label) => {
    if (!bits.some((b) => b[0] === id)) bits.push([id, label])
  }

  if (note === 'delete') {
    if (texts.length && images.length) {
      add('delete', '字和图一起删')
      add('delete-text', '删掉这些字')
      add('delete-image', '删掉这块图')
    } else if (images.length) add('delete-image', '删掉这块图')
    else add('delete-text', '删掉这些字')
    if (texts.length) add('strike', '划掉这些字')
    add('delete-deco', '去掉圈里的装饰/标注')
    add('clear-anno', '去掉下划线/框/高亮')
    return bits
  }

  if (note === 'cut') {
    if (texts.length) {
      add('polish', '精简这段文字')
      add('shorter', '写短一点')
      add('clear-anno', '去掉下划线/框/高亮')
    }
    if (images.some(looksLikeTableBleed)) add('trim', '减掉多圈的')
    if (images.length) add('soften', '减弱阴影/装饰')
    if (!bits.length) add('shorter', '写短一点')
    return bits
  }

  if (note === 'add') {
    addDecorChoices(add, { texts, images, slots, empty: empty || !texts.length && !images.length })
    if (texts.length) add('longer', '扩写圈中文字')
    if (texts.length && images.length) add('fuse', '把圈中的字融入图')
    if (looksLikeShadow(spans, editor)) {
      const packed = cupScreenBox(editor)
      add('shadow', shadowOptionLabel(ui.lastPaint, packed?.cup))
    }
    if (!bits.length) add('insert-text', '插入一段文字')
    return bits
  }

  if (note === 'color') {
    if (texts.length + images.length >= 2) add('scheme', '用配色套到这几处')
    add('color', texts.length + images.length > 1 ? '改成同一颜色' : '改这一处颜色')
    if (texts.length) add('highlight', '加上高亮')
    if (images.length && texts.length) add('anchor', '照着这里改别处')
    return bits
  }

  if (note === 'change') {
    const name = hasNameHint(texts)
    const color = hasColorHint(texts) || images.length
    const pattern = images.length
    if (name && color && pattern) {
      add('name', '只改名字')
      add('color', '只改颜色')
      add('pattern', '只改图案')
    } else {
      if (name) add('name', '改名字')
      if (color) add('color', '改颜色')
      if (name && color) add('name-color', '改名字和颜色')
    }
    add('custom', '换成我写的 / 换成我描述的样子')
    if (texts.length) {
      add('polish', '润色')
      add('spoken', '改成更口语')
      add('formal', '改成更正式')
      add('bold', '加粗这段')
      add('underline', '加上下划线')
    }
    addDecorChoices(add, { texts, images, slots, empty })
    if (images.length) add('anchor', '照着这里改别处')
    if (name && ui.productName.trim().length > 4) {
      add('print-short', '杯面用简称')
      add('print-shrink', '缩小写进像素')
    }
    return bits
  }

  if (note === 'custom') {
    add('custom', '按我写的改')
    addDecorChoices(add, { texts, images, slots, empty })
    if (texts.length) {
      add('polish', '润色这段')
      add('longer', '扩写圈中文字')
      add('shorter', '写短一点')
    }
    if (images.length) add('color', '改颜色')
    add('delete-text', texts.length && images.length ? '删掉圈里的' : images.length ? '删掉这块图' : '删掉这些字')
    return bits
  }

  if (looksLikeIndent(spans)) add('indent', '这段空两格')
  if (looksLikeShadow(spans, editor)) {
    const packed = cupScreenBox(editor)
    add('shadow', shadowOptionLabel(ui.lastPaint, packed?.cup))
  }
  const indentMarks = spans.filter((s) => s.indentMark)
  if (indentMarks.length === 1) return bits
  addDecorChoices(add, { texts, images, slots, empty })
  if (slots.length && !texts.length && !images.length && !indentMarks.length) {
    add('insert-text', '插入文字')
    add('insert-image', '插入图片')
  }
  if (texts.length) {
    add('name', '改名字')
    add('color', '改颜色')
    add('polish', '润色这段')
  }
  if (images.length && !texts.length) add('color', '改颜色')
  if (texts.length && images.length) add('delete', '删掉圈里的')
  else if (images.length) add('delete-image', '删掉这块图')
  else if (texts.length) add('delete-text', '删掉这些字')
  if (images.length) add('anchor', '照着这里改别处')
  return bits
}

function needsName(intent) {
  return intent === 'name' || intent === 'name-color' || intent === 'insert-text' || intent === 'print-short'
}

function needsColor(intent) {
  return intent === 'color' || intent === 'name-color'
}

function needsFollow(intent) {
  return FOLLOW_INTENTS.has(intent)
}

function commitLabel(editor) {
  const { images } = selectionKinds()
  const bits = []
  if (images.length && (ui.intent === 'color' || ui.intent === 'name-color' || String(ui.intent).startsWith('delete'))) {
    bits.push('会动图')
  }
  if (ui.elsewhere === 'follow' && editor) {
    const extra = collectOutsideEdits(editor.view, [ui.productName, ui.color].filter(Boolean).join('，'), 'follow')
    if (extra.length) bits.push('会改几处')
  }
  if (ui.intent === 'anchor') bits.push('会改几处')
  return bits.length ? `改这些（${bits.join(' / ')}）` : '改这些'
}

function applyCommandText() {
  if (ui.intent === 'polish') replaceCommandText('润色这段，保持原意和品名')
  else if (ui.intent === 'longer') replaceCommandText('把这段写得更长一些，保持原意')
  else if (ui.intent === 'shorter') replaceCommandText('把这段写得更短一些，保持原意')
  else if (ui.intent === 'spoken') replaceCommandText('改成更口语，保持原意')
  else if (ui.intent === 'formal') replaceCommandText('改成更正式，保持原意')
  else if (ui.intent === 'custom') replaceCommandText(ui.moreText.trim() || ui.noteText.trim())
  else if (ui.intent === 'anchor') replaceCommandText('')
  else if (ui.intent === 'pattern') replaceCommandText('只改图案花纹，不要改颜色和品名')
  else if (ui.intent === 'fuse') replaceCommandText('把圈中的字融入图，按透视和光影写进像素')
  else if (ui.intent === 'deco') replaceCommandText('在圈定位置加标注或图案')
  else if (ui.intent === 'border') replaceCommandText('加上边框、logo 或线条')
  else if (ui.intent === 'soften') replaceCommandText('减弱阴影和装饰，不要改杯子本身')
  else if (ui.intent === 'scheme') {
    const sch = COLOR_SCHEMES.find((s) => s.id === ui.scheme)
    replaceCommandText(sch ? `改成${sch.label}配色：${sch.colors.join('、')}` : '改配色')
  } else if (ui.intent === 'print-short') replaceCommandText(`${ui.productName.trim() || '简称'}，杯面用简称`)
  else if (ui.intent === 'print-shrink') replaceCommandText(`${ui.productName.trim()}，缩小写进像素`)
  else {
    const parts = []
    if (needsName(ui.intent) && ui.productName.trim()) parts.push(ui.productName.trim())
    if (needsColor(ui.intent) && ui.color) parts.push(ui.color)
    if (ui.printFit === 'short') parts.push('杯面用简称')
    if (ui.printFit === 'shrink') parts.push('缩小写进像素')
    replaceCommandText(parts.join('，'))
  }
}

function nextIdea(list, key) {
  const i = ui[key] % list.length
  ui[key] += 1
  return list[i]
}

function goBack() {
  if (ui.step === 'values') {
    ui.step = 'propose'
    ui.intent = null
  }
  emit()
}

function heading(step, intent) {
  if (step === 'propose') return '在旁边写出要做什么'
  if (step === 'review') return '已改这些地方'
  if (intent === 'name' || intent === 'print-short') return '改成什么名字'
  if (intent === 'color') return '改成什么颜色'
  if (intent === 'name-color') return '新品名和颜色'
  if (intent === 'scheme') return '选一套配色'
  if (intent === 'insert-text') return '要插入的文字'
  if (intent === 'custom') return '写成什么样'
  if (intent === 'anchor') return '照着这里改别处'
  if (String(intent).startsWith('delete')) return '确认删除'
  return '再补一点'
}

function btn(label, { primary, on, title } = {}, onClick) {
  const el = document.createElement('button')
  el.type = 'button'
  if (primary) el.className = 'primary'
  if (on) el.classList.add('is-on')
  el.textContent = label
  if (title) el.title = title
  el.addEventListener('click', (e) => {
    e.stopPropagation()
    onClick()
  })
  return el
}

function appendUndoRow(bar, editor, deps) {
  if (!canUndoLocal() && !canUndoInsert()) return
  const row = document.createElement('div')
  row.className = 'card-row'
  if (canUndoLocal()) {
    const label = peekLocalUndoLabel()
    row.append(
      btn(`撤回刚才（${label}）`, {}, () => {
        const undone = undoLastLocalAction(editor)
        if (undone) deps.toast(`已撤回${undone}`)
      }),
    )
  }
  if (canUndoInsert()) {
    row.append(
      btn('撤回全部', {}, () => {
        if (undoLastInsert(editor)) {
          idleCard()
          deps.toast('已撤回整次修改')
        }
      }),
    )
  }
  bar.append(row)
}

function relScreen(img, rel) {
  const r = img.getBoundingClientRect()
  return {
    x: r.left + r.width * rel.xRel,
    y: r.top + r.height * rel.yRel,
    w: r.width * rel.wRel,
    h: r.height * rel.hRel,
  }
}

export function addCoachMarks(layer, editor) {
  if (!ui.coachOn) return
  const wrap = document.createElement('div')
  wrap.className = 'coach'
  const h1 = editor?.view?.dom?.querySelector('h1')
  const img = editor?.view?.dom?.querySelector('img[data-block-id="img-1"]')
  const cup = DEMO_CUP[getDemoPage()]?.cup
  const boxes = []
  if (h1) {
    const r = h1.getBoundingClientRect()
    boxes.push({ x: r.left - 6, y: r.top - 4, w: r.width + 12, h: r.height + 8 })
  }
  if (img && cup) boxes.push(relScreen(img, cup))
  for (const box of boxes) {
    const ring = document.createElement('div')
    ring.className = 'coach-ring'
    ring.style.left = `${box.x}px`
    ring.style.top = `${box.y}px`
    ring.style.width = `${box.w}px`
    ring.style.height = `${box.h}px`
    wrap.append(ring)
  }
  const caption = document.createElement('p')
  caption.className = 'coach-caption'
  caption.textContent = '用画笔涂过要改的字或图，再在旁边写出一两个字，比如删、改、色。系统按你写的给出选项。'
  const ok = btn('知道了', { primary: true }, dismissCoach)
  caption.append(ok)
  wrap.append(caption)
  wrap.addEventListener('click', (e) => {
    e.stopPropagation()
    dismissCoach()
  })
  layer.append(wrap)
}

function fillHints(bar, _editor, spans) {
  const { images } = selectionKinds(spans)
  const indentWaiting = spans.filter((s) => s.indentMark).length === 1
  if (indentWaiting) {
    const row = document.createElement('p')
    row.className = 'card-hint'
    row.textContent = '再在段前画一个小方格，就会空两格。'
    bar.append(row)
  }
  const under = underSelectHint(spans)
  if (ui.hintUnderOn && under) {
    const row = document.createElement('p')
    row.className = 'card-hint'
    row.textContent = under
    const x = btn('×', { title: '关掉这条' }, () => {
      ui.hintUnderOn = false
      emit()
    })
    x.className = 'card-hint-x'
    row.append(x)
    bar.append(row)
  }
  if (ui.hintOverOn && images.some(looksLikeTableBleed)) {
    const row = document.createElement('p')
    row.className = 'card-hint is-warn'
    row.textContent = '圈进桌边了。也可以按住 Alt 再圈要去掉的部分。'
    row.prepend(
      btn('减掉多圈的', { primary: false }, () => {
        setSubtractMode(true)
        ping()
      }),
    )
    const x = btn('×', { title: '关掉这条' }, () => {
      ui.hintOverOn = false
      emit()
    })
    x.className = 'card-hint-x'
    row.append(x)
    bar.append(row)
  }
}

function pickOption(id, deps, editor) {
  if (id === 'trim') {
    setSubtractMode(true)
    deps.toast('再圈要去掉的部分（桌边、空隙）')
    return
  }
  if (id === 'background') {
    const mode = toggleBackground()
    if (!mode) deps.toast('先圈杯子或图上的一块，再改背景')
    else if (mode === 'background') deps.toast('已改为背景：整图减去刚才圈的物体')
    else deps.toast('已改回物体')
    return
  }
  if (id === 'shadow') {
    if (!withLocalUndo(editor, '阴影', () => applyShadow(editor))) {
      deps.toast('先在杯子旁涂一块再加阴影')
      return
    }
    deps.toast('已按你画的形状加上投影。可点「撤回刚才」')
    startReview()
    emit()
    return
  }
  if (LOCAL_ANNO.has(id) || id === 'clear-anno') {
    if (withLocalUndo(editor, localLabel(id), () => applyLocalAnno(id, editor))) {
      deps.toast(id === 'clear-anno' ? '已去掉这些批注。可撤回' : '已加上。可点「撤回刚才」')
      ui.intent = id
      ui.step = 'values'
      emit()
      return
    }
    deps.toast('先涂到要加的字，或先在空白处画一笔')
    return
  }
  if (id === 'indent') {
    if (withLocalUndo(editor, '空两格', () => applyIndent(editor))) {
      deps.toast('已空两格。可撤回，或点「同样的也改」套到全页')
      ui.intent = 'indent'
      ui.step = 'values'
      emit()
      return
    }
    deps.toast('靠近段首再画两个小格')
    return
  }
  ui.intent = id
  ui.step = 'values'
  emit()
}

function applyShadow(editor) {
  const pts = ui.lastPaint
  if (pts?.length >= 6 && applyShapedShadow(pts, editor)) return true
  const packed = cupScreenBox(editor)
  if (!packed) return false
  const { img, cup } = packed
  const css = inferShadowCss(pts, cup)
  if (img.dataset.marksetShadow === '1' && img.style.filter === css) {
    img.style.filter = ''
    delete img.dataset.marksetShadow
    return true
  }
  img.style.filter = css
  img.dataset.marksetShadow = '1'
  return true
}

function applyShapedShadow(pts, editor) {
  const host = decoHost()
  if (!host) return false
  const packed = cupScreenBox(editor)
  const box = aabb(pts)
  let hull = convexHull(pts)
  if (hull.length < 3) hull = strokeToPolygon(pts, 12)
  if (hull.length < 3) return false
  let ox = 6
  let oy = 12
  if (packed?.cup) {
    const pcx = box.x + box.w / 2
    const pcy = box.y + box.h / 2
    const cx = packed.cup.x + packed.cup.w / 2
    const cy = packed.cup.y + packed.cup.h * 0.72
    ox = Math.round(clamp((pcx - cx) * 0.12, -22, 22))
    oy = Math.round(clamp((pcy - cy) * 0.12, 4, 28))
  }
  const shifted = hull.map((p) => ({ x: p.x + ox, y: p.y + oy }))
  const sb = aabb(shifted)
  const placed = pageRelativeRect({ x: sb.x, y: sb.y, w: Math.max(12, sb.w), h: Math.max(12, sb.h) })
  if (!placed) return false
  host.querySelectorAll('.page-deco.is-shadow').forEach((el) => el.remove())
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'page-deco is-shadow')
  svg.setAttribute('viewBox', `${sb.x} ${sb.y} ${Math.max(12, sb.w)} ${Math.max(12, sb.h)}`)
  svg.setAttribute('preserveAspectRatio', 'none')
  svg.style.left = `${placed.x}px`
  svg.style.top = `${placed.y}px`
  svg.style.width = `${placed.w}px`
  svg.style.height = `${placed.h}px`
  const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon')
  poly.setAttribute('points', shifted.map((p) => `${p.x},${p.y}`).join(' '))
  poly.setAttribute('fill', 'rgba(36, 24, 14, 0.88)')
  svg.append(poly)
  host.append(svg)
  return true
}

function decoHost() {
  const page = document.querySelector('.page')
  if (!page) return null
  let host = page.querySelector('.page-deco-host')
  if (!host) {
    host = document.createElement('div')
    host.className = 'page-deco-host'
    page.append(host)
  }
  return host
}

function paintRect() {
  const spans = getSnapshot().spans
  const slot = spans.find((s) => s.screenRect)
  if (slot?.screenRect) return slot.screenRect
  if (ui.lastPaint?.length) return aabb(ui.lastPaint)
  return null
}

function applyPageDeco(kind, editor) {
  let rect = paintRect()
  if (!rect && kind === 'frame') {
    const img = editor?.view?.dom?.querySelector('img[data-block-id="img-1"]')
    if (img) {
      const r = img.getBoundingClientRect()
      rect = { x: r.left, y: r.top, w: r.width, h: r.height }
    }
  }
  if (!rect) return false
  const host = decoHost()
  if (!host) return false
  const placed = pageRelativeRect(rect)
  if (!placed) return false
  const decoKind = kind === 'line' ? 'line' : kind === 'wavy' ? 'wavy' : 'frame'
  const el = document.createElement('div')
  el.className = `page-deco is-${decoKind}`
  el.style.left = `${placed.x}px`
  el.style.width = `${Math.max(24, placed.w)}px`
  if (decoKind === 'line') {
    el.style.top = `${placed.y + placed.h}px`
  } else if (decoKind === 'wavy') {
    el.style.top = `${placed.y + Math.max(0, placed.h - 6)}px`
    el.style.height = '12px'
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    const w = Math.max(24, placed.w)
    svg.setAttribute('viewBox', `0 0 ${w} 12`)
    svg.setAttribute('preserveAspectRatio', 'none')
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    let d = 'M0 6'
    for (let x = 8; x <= w + 4; x += 8) d += ` Q${x - 4} ${x % 16 ? 2 : 10} ${x} 6`
    path.setAttribute('d', d)
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', '#3c6fd4')
    path.setAttribute('stroke-width', '2')
    path.setAttribute('stroke-linecap', 'round')
    svg.append(path)
    el.append(svg)
  } else {
    el.style.top = `${placed.y}px`
    el.style.height = `${Math.max(18, placed.h)}px`
  }
  host.append(el)
  return true
}

function applyTextAnno(editor, kind) {
  const texts = getSnapshot().spans.filter((s) => s.kind === 'text' && s.from != null && s.to != null)
  const markType = editor?.schema?.marks?.textAnno
  if (markType && texts.length) {
    let { tr } = editor.state
    for (const s of texts) {
      if (s.from < s.to) tr = tr.addMark(s.from, s.to, markType.create({ kind }))
    }
    if (tr.docChanged) {
      editor.view.dispatch(tr)
      return true
    }
  }
  return applyPageDeco(kind === 'box' ? 'frame' : kind, editor)
}

function clearTextAnno(editor) {
  const texts = getSnapshot().spans.filter((s) => s.kind === 'text' && s.from != null && s.to != null)
  const markType = editor?.schema?.marks?.textAnno
  let changed = false
  if (markType && texts.length) {
    let { tr } = editor.state
    for (const s of texts) tr = tr.removeMark(s.from, s.to, markType)
    if (tr.docChanged) {
      editor.view.dispatch(tr)
      changed = true
    }
  }
  const host = document.querySelector('.page-deco-host')
  if (host && host.childNodes.length) {
    host.replaceChildren()
    changed = true
  }
  return changed
}

function applyTextAnnoAll(editor, kind) {
  if (kind === 'frame' || kind === 'line') {
    applyPageDeco(kind, editor)
    return
  }
  const markType = editor?.schema?.marks?.textAnno
  if (!markType) return
  const annoKind = kind === 'box' ? 'box' : kind
  let { tr } = editor.state
  editor.state.doc.descendants((node, pos) => {
    if (!node.isTextblock || !node.textContent) return true
    if (node.attrs?.blockId === 'p-price' || node.attrs?.blockId === 'p-ship') return true
    const from = pos + 1
    const to = pos + node.nodeSize - 1
    if (kind === 'clear-anno') tr = tr.removeMark(from, to, markType)
    else if (annoKind !== 'frame' && annoKind !== 'line') tr = tr.addMark(from, to, markType.create({ kind: annoKind }))
    return true
  })
  if (tr.docChanged) editor.view.dispatch(tr)
}

function applyLocalAnno(id, editor) {
  if (id === 'clear-anno') return clearTextAnno(editor)
  if (id === 'frame' || id === 'line') return applyPageDeco(id, editor)
  if (id === 'wavy') {
    const { texts } = selectionKinds()
    if (texts.length) return applyTextAnno(editor, 'wavy')
    return applyPageDeco('wavy', editor)
  }
  if (id === 'box') {
    const { texts } = selectionKinds()
    if (texts.length) return applyTextAnno(editor, 'box')
    return applyPageDeco('frame', editor)
  }
  return applyTextAnno(editor, id)
}

function indentStartPos(editor, spans) {
  const mark = spans.find((s) => s.indentMark && s.block_id)
  if (mark?.block_id) {
    let found = null
    editor.state.doc.descendants((node, pos) => {
      if (found != null) return false
      if (node.attrs?.blockId === mark.block_id) {
        found = pos + 1
        return false
      }
      return true
    })
    if (found != null) return found
  }
  if (mark?.paraPos) return mark.paraPos
  const texts = spans.filter((s) => s.kind === 'text')
  if (texts.length) {
    const first = [...texts].sort((a, b) => a.from - b.from)[0]
    return first.from
  }
  const slot = spans.find((s) => s.kind === 'slot' && s.screenRect)
  if (!slot) return null
  const hit = editor.view.posAtCoords({
    left: slot.screenRect.x + slot.screenRect.w + 16,
    top: slot.screenRect.y + Math.min(18, slot.screenRect.h / 2),
  })
  if (!hit) return null
  const $pos = editor.state.doc.resolve(hit.pos)
  for (let d = $pos.depth; d > 0; d -= 1) {
    if ($pos.node(d).isTextblock) return $pos.start(d)
  }
  return hit.pos
}

function applyIndent(editor) {
  const spans = getSnapshot().spans
  const start = indentStartPos(editor, spans)
  if (start == null) return false
  const t = editor.state.doc.textBetween(start, Math.min(start + 2, editor.state.doc.content.size))
  if (!t.startsWith('　')) editor.chain().focus().insertContentAt(start, '　　').run()
  return true
}

function applyIndentAll(editor) {
  const starts = []
  editor.state.doc.descendants((node, pos) => {
    if (!node.isTextblock || !node.textContent) return true
    if (node.attrs?.blockId === 'p-price' || node.attrs?.blockId === 'p-ship') return true
    if (node.textContent.startsWith('　')) return true
    starts.push(pos + 1)
    return true
  })
  for (const p of starts.sort((a, b) => b - a)) {
    editor.chain().insertContentAt(p, '　　').run()
  }
}

export function openPageRecolor(editor) {
  const occupied = []
  const found = []
  for (const term of COLOR_TERMS) {
    const hits = findSameText(editor.view, term, occupied)
    found.push(...hits)
    occupied.push(...hits)
  }
  const img = editor.view.dom.querySelector('img[data-block-id="img-1"]')
  const cup = DEMO_CUP[getDemoPage()]?.cup
  if (img && cup) {
    const span = imageSpanFromNaturalBox(img, {
      xRel: cup.xRel,
      yRel: cup.yRel,
      wRel: cup.wRel,
      hRel: cup.hRel,
    })
    if (span) found.push(span)
  }
  if (!found.length) return false
  replaceSpans(found)
  ui.note = 'color'
  ui.noteText = '色'
  ui.step = 'propose'
  ui.intent = null
  emit()
  return true
}

function runIntent(editor, deps, scope) {
  ui.elsewhere = scope
  if (ui.intent === 'indent') {
    if (scope === 'follow') withLocalUndo(editor, '空两格（全页）', () => {
      applyIndentAll(editor)
      return true
    })
    startReview()
    emit()
    deps.toast(scope === 'follow' ? '已套到全页段落。可撤回' : '只改了这一段。可撤回')
    return
  }
  if (LOCAL_ANNO.has(ui.intent) || ui.intent === 'clear-anno') {
    if (scope === 'follow') {
      withLocalUndo(editor, `${localLabel(ui.intent)}（全页）`, () => {
        applyTextAnnoAll(editor, ui.intent)
        return true
      })
    }
    startReview()
    emit()
    deps.toast(scope === 'follow' ? '已套到全页。可撤回' : '只改了这里。可撤回')
    return
  }
  if (ui.intent === 'delete-image') keepKindsWillEdit('image')
  if (ui.intent === 'delete-text') keepKindsWillEdit('text')
  setScope(scope === 'follow' ? 'follow' : ui.intent === 'anchor' ? 'anchor' : 'inside')
  applyCommandText()
  if (String(ui.intent).startsWith('delete')) deps.runCommand('delete', editor)
  else if (
    ui.intent === 'polish' ||
    ui.intent === 'longer' ||
    ui.intent === 'shorter' ||
    ui.intent === 'spoken' ||
    ui.intent === 'formal' ||
    ui.intent === 'custom'
  ) {
    deps.runCommand('rewrite', editor)
  } else deps.runCommand('unify', editor)
}

function fillPropose(bar, spans, editor, deps) {
  const title = document.createElement('div')
  title.className = 'card-title'
  title.textContent = heading('propose')
  bar.append(title)
  const hint = document.createElement('p')
  hint.className = 'card-note'
  if (ui.noteText) {
    hint.textContent = ui.noteConfident
      ? `看成「${ui.noteText}」，按这个猜下面几项。点一项继续。写错可擦掉。`
      : ui.note
        ? `写成「${ui.noteText}」不太确定，先按这个猜。不对就擦掉再写。`
        : '字没认清，先给通用项。可擦掉再写，或在旁边再写一两个字。'
  } else if (spans.filter((s) => s.indentMark).length === 1) {
    hint.textContent = '再在段前画一个小方格，就会空两格。不用按 Shift。'
  } else if (looksLikeIndent(spans)) {
    hint.textContent = '两个格子表示这段空两格。点下面确认。'
  } else if (spans.some((s) => s.paintMark) && !spans.some((s) => s.kind === 'text' || s.kind === 'image')) {
    hint.textContent = '没涂到字或杯子。可加阴影、空两格，或加框、线、插入文字。'
  } else {
    hint.textContent = '用鼠标或笔在旁边写一两个字（删、改、色、加…）。写错点擦掉。没写则按你涂到的内容猜。'
  }
  bar.append(hint)
  if (hasInk() || ui.noteText) {
    const tools = document.createElement('div')
    tools.className = 'card-row'
    if (hasInk()) {
      tools.append(
        btn('擦掉上一笔', {}, () => {
          undoLastInkStroke()
          deps.toast(hasInk() ? '已擦掉上一笔，可继续写' : '字已擦掉，可再写')
        }),
      )
    }
    tools.append(
      btn('擦掉字重写', {}, () => {
        eraseWrittenNote()
        deps.toast('字已擦掉，可再写')
      }),
    )
    bar.append(tools)
  }
  const lead = document.createElement('div')
  lead.className = 'card-title'
  lead.textContent = ui.note ? '可能想做什么' : '没写字时，按你画的猜'
  bar.append(lead)
  const row = document.createElement('div')
  row.className = 'card-row'
  const options = proposeOptions(spans, editor)
  if (!options.length) {
    const empty = document.createElement('p')
    empty.className = 'card-note'
    empty.textContent = spans.some((s) => s.indentMark)
      ? '再在段前画一个小方格，就会空两格'
      : spans.some((s) => s.paintMark)
        ? '没涂到字或杯子。可加阴影、空两格，或加框 / 线 / 插入'
        : '再圈一点，或在旁边写出要做什么'
    bar.append(empty)
    return
  }
  for (const [id, label] of options) {
    const primary = (id === 'indent' || id === 'shadow') && options[0][0] === id
    row.append(btn(label, { primary, on: ui.intent === id }, () => pickOption(id, deps, editor)))
  }
  bar.append(row)
}

function followActions(bar, editor, deps, canRun) {
  if (needsFollow(ui.intent)) {
    bar.append(
      btn('只这里', { primary: true }, () => {
        if (canRun && !canRun()) return
        runIntent(editor, deps, 'inside')
      }),
      btn('同样的也改', {}, () => {
        if (canRun && !canRun()) return
        runIntent(editor, deps, 'follow')
      }),
    )
  } else {
    bar.append(
      btn(commitLabel(editor), { primary: true }, () => {
        if (canRun && !canRun()) return
        runIntent(editor, deps, ui.intent === 'anchor' ? 'anchor' : 'inside')
      }),
    )
  }
  bar.append(btn('上一步', {}, goBack))
}

function fillValues(bar, editor, deps) {
  const title = document.createElement('div')
  title.className = 'card-title'
  title.textContent = heading('values', ui.intent)
  bar.append(title)

  if (String(ui.intent).startsWith('delete')) {
    const note = document.createElement('p')
    note.className = 'card-note'
    note.textContent = '会删掉圈里对应的字或图上那一块。'
    bar.append(note)
    bar.append(
      btn('确认删除', { primary: true }, () => runIntent(editor, deps, 'inside')),
      btn('上一步', {}, goBack),
    )
    return
  }

  if (ui.intent === 'anchor') {
    const note = document.createElement('p')
    note.className = 'card-note'
    note.textContent = '圈里当作已经对的例子，不再重画。只改别处对不上的品名、色词或印字。'
    bar.append(note)
    followActions(bar, editor, deps)
    return
  }

  if (ui.intent === 'indent') {
    const note = document.createElement('p')
    note.className = 'card-note'
    note.textContent = '这一段已经空了两格。'
    bar.append(note)
    followActions(bar, editor, deps)
    return
  }

  if (LOCAL_ANNO.has(ui.intent) || ui.intent === 'clear-anno') {
    const note = document.createElement('p')
    note.className = 'card-note'
    note.textContent = ui.intent === 'clear-anno' ? '已经去掉圈里的批注。' : '已经加在圈到的位置。'
    bar.append(note)
    followActions(bar, editor, deps)
    return
  }

  if (['polish', 'longer', 'shorter', 'spoken', 'formal', 'pattern', 'fuse', 'deco', 'border', 'soften'].includes(ui.intent)) {
    const note = document.createElement('p')
    note.className = 'card-note'
    note.textContent = ui.intent === 'longer' ? '只改圈里这句，把它写长一点。' : '按你选的这项改圈里的内容。'
    bar.append(note)
    followActions(bar, editor, deps)
    return
  }

  if (ui.intent === 'insert-text') {
    const input = document.createElement('input')
    input.type = 'text'
    input.value = ui.productName
    input.placeholder = '写要插到圈定位置的字'
    input.addEventListener('pointerdown', (e) => e.stopPropagation())
    input.addEventListener('input', () => {
      ui.productName = input.value
      replaceCommandText(input.value)
    })
    bar.append(input)
    bar.append(
      btn('帮我想一句', {}, () => {
        ui.productName = nextIdea(LINE_IDEAS, 'lineIdea')
        replaceCommandText(ui.productName)
        emit()
        deps.toast(`已填入：${ui.productName}，再点可换一个`)
      }),
    )
    bar.append(
      btn('插入文字', { primary: true }, () => {
        replaceCommandText(ui.productName)
        deps.insertText(editor)
      }),
      btn('上一步', {}, goBack),
    )
    return
  }

  if (ui.intent === 'insert-image') {
    bar.append(
      btn('选一张图插入', { primary: true }, () => deps.insertImage(editor)),
      btn('上一步', {}, goBack),
    )
    return
  }

  if (ui.intent === 'custom') {
    const input = document.createElement('input')
    input.type = 'text'
    input.value = ui.moreText
    input.placeholder = '输入其他要求'
    input.addEventListener('pointerdown', (e) => e.stopPropagation())
    input.addEventListener('input', () => {
      ui.moreText = input.value
    })
    bar.append(input)
    bar.append(
      btn('帮我想一句', {}, () => {
        ui.moreText = nextIdea(ASK_IDEAS, 'askIdea')
        emit()
        deps.toast(`已填入：${ui.moreText}，再点可换一个`)
      }),
    )
    followActions(bar, editor, deps, () => {
      if (!ui.moreText.trim() && !ui.noteText.trim()) {
        deps.toast('先写下想改成什么样')
        return false
      }
      return true
    })
    return
  }

  if (ui.intent === 'scheme') {
    const row = document.createElement('div')
    row.className = 'scheme-list'
    for (const sch of COLOR_SCHEMES) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = `scheme-card${ui.scheme === sch.id ? ' is-on' : ''}`
      const name = document.createElement('strong')
      name.textContent = sch.label
      const dots = document.createElement('span')
      dots.className = 'scheme-dots'
      for (const id of sch.colors) {
        const d = document.createElement('i')
        const c = COLORS.find((x) => x.id === id)
        d.style.background = c?.fill || '#888'
        d.title = id
        dots.append(d)
      }
      b.append(name, dots)
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        ui.scheme = sch.id
        ui.color = sch.colors[0]
        emit()
      })
      row.append(b)
    }
    bar.append(row)
    followActions(bar, editor, deps, () => {
      if (!ui.scheme) {
        deps.toast('先点一套配色')
        return false
      }
      return true
    })
    return
  }

  if (needsName(ui.intent)) {
    const input = document.createElement('input')
    input.type = 'text'
    input.value = ui.productName
    input.placeholder = '例如：海盐杯'
    input.addEventListener('pointerdown', (e) => e.stopPropagation())
    input.addEventListener('input', () => {
      ui.productName = input.value
    })
    bar.append(input)
    bar.append(
      btn('帮我想一个名字', {}, () => {
        ui.productName = nextIdea(NAME_IDEAS, 'nameIdea')
        emit()
        deps.toast(`已填入：${ui.productName}，再点可换一个`)
      }),
    )
    if (ui.productName.trim().length > 4) {
      const fit = document.createElement('div')
      fit.className = 'card-row'
      fit.append(
        btn('杯面用简称', { on: ui.printFit === 'short' }, () => {
          ui.printFit = ui.printFit === 'short' ? '' : 'short'
          emit()
        }),
        btn('缩小写进像素', { on: ui.printFit === 'shrink' }, () => {
          ui.printFit = ui.printFit === 'shrink' ? '' : 'shrink'
          emit()
        }),
      )
      bar.append(fit)
    }
  }

  if (needsColor(ui.intent)) {
    const pal = document.createElement('div')
    pal.className = 'color-palette'
    for (const swatch of COLORS) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = `swatch${ui.color === swatch.id ? ' is-on' : ''}`
      b.style.setProperty('--swatch', swatch.fill)
      b.title = swatch.id
      b.textContent = swatch.id
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        ui.color = swatch.id
        emit()
      })
      pal.append(b)
    }
    bar.append(pal)
    const custom = document.createElement('label')
    custom.className = `color-custom${ui.color.startsWith('#') ? ' is-on' : ''}`
    const picker = document.createElement('input')
    picker.type = 'color'
    picker.value = ui.color.startsWith('#') ? ui.color : '#5884b0'
    picker.title = '自选颜色'
    picker.addEventListener('pointerdown', (e) => e.stopPropagation())
    picker.addEventListener('input', () => {
      ui.color = picker.value
      emit()
    })
    const customName = document.createElement('span')
    customName.textContent = '自选颜色'
    custom.append(picker, customName)
    bar.append(custom)
    bar.append(
      btn('帮我选一个颜色', {}, () => {
        ui.color = nextIdea(COLORS, 'colorIdea').id
        emit()
        deps.toast(`已选：${ui.color}，再点可换一个`)
      }),
    )
  }

  followActions(bar, editor, deps, () => {
    if (needsName(ui.intent) && !ui.productName.trim() && !ui.color) {
      deps.toast('先写下新名字，或选一个颜色')
      return false
    }
    if (needsColor(ui.intent) && !ui.color && ui.intent === 'color') {
      deps.toast('先在色板里选一个颜色')
      return false
    }
    return true
  })
}

function fillReview(bar, editor, deps) {
  const title = document.createElement('div')
  title.className = 'card-title'
  title.textContent = heading('review')
  bar.append(title)
  const snap = getSnapshot()
  const list = document.createElement('ul')
  list.className = 'card-changes'
  for (const item of snap.changes || []) {
    const li = document.createElement('li')
    if (snap.changeActive === item.id) li.classList.add('is-on')
    const restored = item.keep === false
    const line = document.createElement('button')
    line.type = 'button'
    line.className = 'change-line'
    line.textContent =
      item.kind === 'text'
        ? `${item.before || '（空）'} → ${restored ? item.before || '（空）' : item.after || '（删）'}`
        : restored
          ? '图 · 已还原'
          : '图 · 已改'
    line.addEventListener('click', (e) => {
      e.stopPropagation()
      deps.setChangeActive(item.id)
    })
    const toggle = btn(restored ? '改回' : '还原这一处', {}, () => {
      const run = restored ? redoChange(editor, item.id) : restoreChange(editor, item.id)
      run.then(() => deps.toast(restored ? '已改回这一处' : '已还原这一处'))
    })
    li.append(line, toggle)
    list.append(li)
  }
  if (!snap.changes.length) {
    const empty = document.createElement('p')
    empty.className = 'card-note'
    empty.textContent = '没有留下改动点。'
    bar.append(empty)
  } else bar.append(list)
  appendUndoRow(bar, editor, deps)
}

export function fillNoviceCard(bar, editor, deps) {
  const snap = getSnapshot()
  const spans = snap.spans
  const showReview = ui.step === 'review' || (!spans.length && snap.changes.length)
  if (showReview && ui.step !== 'review') ui.step = 'review'

  if (!spans.length && !showReview) {
    if (canUndoLocal()) {
      const title = document.createElement('div')
      title.className = 'card-title'
      title.textContent = '刚才的操作可以撤回'
      bar.append(title)
      appendUndoRow(bar, editor, deps)
    } else if (ui.coachOn) {
      const title = document.createElement('div')
      title.className = 'card-title'
      title.textContent = '先涂一涂，再在旁边写出要做什么'
      bar.append(title)
    }
    return
  }

  if (showReview) {
    fillReview(bar, editor, deps)
    return
  }

  fillHints(bar, editor, spans)
  if (ui.step === 'values' && ui.intent) fillValues(bar, editor, deps)
  else fillPropose(bar, spans, editor, deps)
  appendUndoRow(bar, editor, deps)
}
