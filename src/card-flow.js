import { DEMO_CUP, getDemoPage, pageRelativeRect } from './editor.js'
import { COLOR_TERMS } from './forbidden.js'
import { parseCommand } from './plan-local.js'
import { guessAnnotationIntent } from './vision-tasks.js'
import { aabb, convexHull, dist, intersectBoxes, looksLikeDrawnLine, pathLength, strokeToPolygon } from './geometry.js'
import { imageSpanFromNaturalBox } from './hit-test.js'
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
import { applyLayoutMoves, hasLayoutWork, layoutSourceWaiting, looksLikeLayout } from './layout.js'
import {
  applyWebAnno,
  applyWebAnnoAll,
  applyWebIndent,
  applyWebLayoutMoves,
  applyWebReflect,
  applyWebScale,
  applyWebShadow,
  executeCircledOp,
  isWebDocActive,
  listWebEdits,
  popLastWebEdit,
  redoWebEdit,
  refreshWebTargetsFromDrawing,
  restoreWebEdit,
  restoreWebHtml,
  snapshotWebHtml,
} from './web-doc.js'
import { clearPaintMarks, getPaintMarks, keepPaintMark, setSubtractMode } from './overlay.js'
import { redoChange, restoreChange } from './changes.js'
import { clearInk, getInkStrokes, readInkText } from './ink.js'
import {
  applyPageScheme,
  assignSchemeToModules,
  collectSchemeModules,
  getPagePaper,
  listColorBlocks,
  resetPagePaper,
  schemeById,
  setPagePaper,
} from './scheme.js'

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

const LINE_STYLE_DEFS = [
  { id: 'line', label: '直线' },
  { id: 'wavy', label: '波浪线' },
  { id: 'line-double', label: '两条直线' },
  { id: 'line-thick', label: '粗直线' },
  { id: 'line-thin', label: '细直线' },
  { id: 'line-strike', label: '删除线' },
]

const LINE_KIND_IDS = LINE_STYLE_DEFS.flatMap((s) => [s.id, `${s.id}-h`, `${s.id}-v`])

const LOCAL_ANNO = new Set([
  'underline',
  'wavy',
  'strike',
  'box',
  'highlight',
  'bold',
  'frame',
  'circle',
  ...LINE_KIND_IDS,
])

const PAGE_LINE = new Set(LINE_KIND_IDS)

const LOCAL_LABELS = {
  indent: '空两格',
  'move-layout': '挪位置',
  'move-nudge': '对齐间距',
  shadow: '阴影',
  'scale-down': '缩小',
  'scale-up': '放大',
  underline: '下划线',
  wavy: '波浪线',
  strike: '删除线',
  box: '方框',
  highlight: '高亮',
  bold: '加粗',
  frame: '方框',
  line: '直线',
  'line-thin': '细直线',
  'line-thick': '粗直线',
  'line-double': '两条直线',
  'line-h': '水平直线',
  'line-v': '垂直直线',
  'wavy-h': '水平波浪线',
  'wavy-v': '垂直波浪线',
  'line-double-h': '水平两条直线',
  'line-double-v': '垂直两条直线',
  'line-thick-h': '水平粗直线',
  'line-thick-v': '垂直粗直线',
  'line-thin-h': '水平细直线',
  'line-thin-v': '垂直细直线',
  'line-strike': '删除线',
  'line-strike-h': '水平删除线',
  'line-strike-v': '垂直删除线',
  circle: '圈',
  'clear-anno': '去掉批注',
  scheme: '配色',
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
    pagePaper: getPagePaper(),
    webHtml: isWebDocActive() ? snapshotWebHtml() : null,
  })
}

export function rememberLocal(editor, label) {
  snapshotLocal(editor, label)
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
  if ('pagePaper' in snap) setPagePaper(snap.pagePaper)
  if (snap.webHtml != null) {
    restoreWebHtml(snap.webHtml)
    popLastWebEdit()
  }
  clearSchemeUi()
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

export { resetPagePaper }

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
  schemeAssign: null,
  schemeSlot: null,
  schemeModules: [],
  pageRecolor: false,
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
  hideCard: false,
  guesses: [],
  guessing: false,
  judged: false,
  seenGuessLabels: [],
}

let guessToken = 0
let guessRuntime = { editor: null, deps: null }

export function clickGuessAt(index, editor, fromEl) {
  const ed = editor || guessRuntime.editor
  const deps = guessRuntime.deps
  if (!ed || !deps) return
  const list = ui.guesses.length ? ui.guesses : localGuesses(getSnapshot().spans, ed)
  let guess = Number.isFinite(index) ? list[index] : null
  if (fromEl?.dataset?.guessId) {
    const id = fromEl.dataset.guessId
    const label = fromEl.dataset.guessLabel || ''
    guess = list.find((g) => g.id === id && (!label || g.label === label)) || guess || {
      id,
      label: label || id,
      note: parseNote(label) || id,
      command: '',
    }
  }
  if (guess) applyGuess(guess, ed, deps)
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

function clearSchemeUi() {
  ui.scheme = ''
  ui.schemeAssign = null
  ui.schemeSlot = null
  ui.schemeModules = []
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

function cancelGuesses() {
  guessToken += 1
  ui.guessing = false
  ui.guesses = []
  ui.judged = false
  ui.seenGuessLabels = []
}

export function resetCardForNewSelection() {
  cancelGuesses()
  ui.step = 'propose'
  ui.note = ''
  ui.noteText = ''
  ui.noteConfident = false
  ui.intent = null
  ui.elsewhere = 'inside'
  ui.productName = ''
  ui.color = ''
  ui.scheme = ''
  ui.schemeAssign = null
  ui.schemeSlot = null
  ui.schemeModules = []
  ui.pageRecolor = false
  ui.moreText = ''
  ui.printFit = ''
  ui.hintUnderOn = true
  ui.hintOverOn = true
  ui.hideCard = false
}

export function keepCardForAppend() {
  ui.hideCard = false
  if (ui.step === 'idle' || ui.step === 'review') {
    ui.step = 'propose'
    ui.intent = null
  }
}

export function startReview() {
  ui.step = 'review'
  ui.intent = null
  ui.schemeSlot = null
}

export function idleCard({ accept = false } = {}) {
  cancelGuesses()
  ui.step = 'idle'
  ui.intent = null
  ui.note = ''
  ui.noteText = ''
  ui.noteConfident = false
  ui.lastPaint = null
  if (accept) ui.hideCard = true
  clearSchemeUi()
  clearInk()
  clearPaintMarks()
  emit()
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
  const t = String(text || '')
    .replace(/\s+/g, '')
    .trim()
  if (!t) return ''
  if (t === '×' || t === 'x' || t === 'X') return 'delete'
  if (/倒影|镜像|反射/.test(t)) return 'reflect'
  if (/阴影|投影|影子/.test(t)) return 'shadow'
  if (/缩小|变小|小一点|缩小一点|更小/.test(t)) return 'scale-down'
  if (/放大|变大|大一点|放大一点|更大/.test(t)) return 'scale-up'
  if (/改颜色|改色|换色|变色|颜色|配色|上色|着色|染色/.test(t)) return 'color'
  if (/色|彩/.test(t) && !/删|去|减/.test(t)) return 'color'
  if (/删|叉|去|消|隐藏|去掉|删掉|不要了|抹掉|擦掉这个/.test(t)) return 'delete'
  if (/减|短|少|精简/.test(t)) return 'cut'
  if (/添|加|插|扩/.test(t)) return 'add'
  if (/改|换|变|润/.test(t)) return 'change'
  return 'custom'
}

export function applyWrittenNote(text, { confident = false, note, silent = false } = {}) {
  const t = String(text || '').trim()
  ui.noteText = t
  ui.note = note || parseNote(t) || (t ? 'custom' : '')
  ui.noteConfident = Boolean(confident && (t || note))
  ui.intent = null
  ui.step = 'propose'
  if (!silent) emit()
}

export function shouldTreatStrokeAsInk(pts) {
  if (ui.step !== 'propose') return false
  const spans = getSnapshot().spans
  if (!spans.some((s) => s.kind === 'text' || s.kind === 'image' || s.kind === 'slot')) return false
  if (layoutSourceWaiting(spans) || looksLikeLayout(spans) || hasLayoutWork(spans)) return false
  if (pts?.length >= 8) {
    const box = aabb(pts)
    const peri = 2 * (box.w + box.h)
    const len = pathLength(pts)
    const closed = dist(pts[0], pts[pts.length - 1]) < Math.max(box.w, box.h) * 0.35
    if (closed && box.w > 36 && box.h > 28 && len < peri * 2.5) return false
    const nearOld = spans.some((s) => {
      const r = s.screenRect
      if (!r) return false
      return Boolean(intersectBoxes(box, { x: r.x - 40, y: r.y - 40, w: r.w + 80, h: r.h + 80 }))
    })
    if (!nearOld && box.w > 40 && box.h > 40) return false
  }
  return true
}

export function classifyDecorStroke(pts, spans = getSnapshot().spans) {
  if (!pts?.length || pts.length < 8) return null
  const box = aabb(pts)
  const area = box.w * box.h
  if (area < 360) return null
  const targets = spans.filter((s) => (s.kind === 'image' || s.kind === 'text') && s.screenRect)
  if (!targets.length) return null
  const len = pathLength(pts)
  const peri = 2 * (box.w + box.h)
  const scribbly = len > peri * 1.18
  const closed = dist(pts[0], pts[pts.length - 1]) < Math.max(box.w, box.h) * 0.28
  let best = null
  for (const s of targets) {
    const r = s.screenRect
    const overlap = intersectBoxes(box, r)
    const oArea = overlap ? overlap.w * overlap.h : 0
    const near =
      box.x < r.x + r.w + 100 &&
      box.x + box.w > r.x - 100 &&
      box.y < r.y + r.h + 110 &&
      box.y + box.h > r.y - 80
    if (!near) continue
    const cover = oArea / Math.max(1, area)
    const cx = box.x + box.w / 2
    const cy = box.y + box.h / 2
    const below = cy > r.y + r.h * 0.7
    const beside = cx < r.x + 16 || cx > r.x + r.w - 16
    if (!best || cover < best.cover) best = { cover, below, beside, scribbly, closed, kind: s.kind }
  }
  if (!best) return null
  if (best.cover > 0.42 && best.closed) return null
  if (best.below && (best.scribbly || box.w >= box.h * 0.9)) return 'reflect'
  if (best.scribbly || best.beside) return 'shadow'
  return null
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

function mapNoteToIntent(note, label) {
  const n = String(note || parseNote(label) || '').trim()
  if (n === 'delete') return 'delete'
  if (n === 'color') return 'color'
  if (n === 'shadow') return 'shadow'
  if (n === 'reflect') return 'reflect'
  if (n === 'scale-down' || n === 'scale-up') return n
  if (n === 'indent' || n === 'move') return n === 'move' ? 'move-layout' : 'indent'
  if (n === 'cut') return 'shorter'
  if (n === 'add') return 'frame'
  if (n === 'change') return 'polish'
  return 'custom'
}

const GUESS_IDS = new Set([
  'delete',
  'delete-image',
  'delete-text',
  'color',
  'name',
  'name-color',
  'polish',
  'custom',
  'frame',
  'circle',
  'shadow',
  'reflect',
  'scale-down',
  'scale-up',
  'indent',
  'move-layout',
  'strike',
  'longer',
  'shorter',
  'highlight',
  'underline',
  'wavy',
  'bold',
  'box',
  'spoken',
  'formal',
  'scheme',
  'trim',
  'background',
])

const ID_ALIASES = {
  remove: 'delete',
  erase: 'delete',
  删除: 'delete',
  删掉: 'delete',
  删: 'delete',
  recolor: 'color',
  'change-color': 'color',
  改色: 'color',
  改颜色: 'color',
  颜色: 'color',
  阴影: 'shadow',
  倒影: 'reflect',
  shrink: 'scale-down',
  'scale-down': 'scale-down',
  缩小: 'scale-down',
  grow: 'scale-up',
  放大: 'scale-up',
  rewrite: 'polish',
  改字: 'polish',
}

function canonicalizeGuessId(id, label, note) {
  const raw = String(id || '').trim()
  const alias = ID_ALIASES[raw] || ID_ALIASES[raw.toLowerCase()]
  if (alias) return alias
  if (GUESS_IDS.has(raw) || LOCAL_ANNO.has(raw)) return raw
  return mapNoteToIntent(note, label)
}

function normalizeGuessItem(item) {
  if (!item) return null
  if (typeof item === 'string') {
    const label = item.trim()
    if (!label) return null
    const note = parseNote(label)
    return { id: mapNoteToIntent(note, label), label, note, command: '' }
  }
  const label = String(item.label || item.guess || item.text || '').trim()
  const note = String(item.note || parseNote(label) || '').trim()
  const command = String(item.command || '').trim()
  const fromText = mapNoteToIntent(note, label)
  let id = canonicalizeGuessId(item.id || item.intent, label, note)
  if ((id === 'custom' || id === 'polish' || id === 'shorter') && fromText !== 'custom') id = fromText
  if (fromText === 'scale-down' || fromText === 'scale-up' || fromText === 'delete' || fromText === 'shadow' || fromText === 'reflect') {
    id = fromText
  }
  if (!label && !id) return null
  return { id, label: label || localLabel(id) || '按这个改', note, command }
}

function ptsToPoly(pts) {
  if (!pts?.length) return null
  return pts.length >= 3 ? strokeToPolygon(pts) : pts
}

function collectDrawingPolys() {
  const polys = []
  const add = (pts) => {
    const poly = ptsToPoly(pts)
    if (poly?.length) polys.push(poly)
  }
  add(ui.lastPaint)
  for (const mark of getPaintMarks()) add(mark.points)
  for (const stroke of getInkStrokes()) add(stroke)
  for (const span of getSnapshot().spans) {
    if (span.poly?.length) polys.push(span.poly)
  }
  return polys
}

function ensureTargetsForGuess() {
  if (!isWebDocActive()) {
    return getSnapshot().spans.filter((s) => s.kind === 'text' || s.kind === 'image')
  }
  const extra = refreshWebTargetsFromDrawing(collectDrawingPolys())
  const slots = getSnapshot().spans.filter((s) => s.kind === 'slot' || s.indentMark)
  const seen = new Set()
  const merged = []
  for (const span of [...extra, ...getSnapshot().spans]) {
    if (!span?.webId || span.kind === 'slot') continue
    if (seen.has(span.webId)) continue
    seen.add(span.webId)
    merged.push(span)
  }
  replaceSpans([...merged, ...slots])
  return merged
}

function localGuesses(spans, editor) {
  if (layoutSourceWaiting(spans) && !looksLikeLayout(spans) && !hasLayoutWork(spans)) {
    return [{ id: '', label: '再用同一颜色圈要放到的位置', note: '', command: '', wait: true }]
  }
  const opts = proposeOptions(spans, editor)
  const out = opts.slice(0, 4).map(([id, label]) => ({ id, label, note: ui.note, command: '' }))
  if (looksLikeLayout(spans) || hasLayoutWork(spans)) return out
  const extra = [
    { id: 'delete', label: '删掉圈中这块', note: 'delete', command: '' },
    { id: 'color', label: '改圈中内容的颜色', note: 'color', command: '' },
    { id: 'custom', label: '按批注改成我要的样子', note: 'custom', command: '' },
  ]
  for (const g of extra) {
    if (out.length >= 4) break
    if (!out.some((x) => x.id === g.id)) out.push(g)
  }
  return out
}

export function requestIntentGuesses(editor, { more = false } = {}) {
  const token = ++guessToken
  ui.step = 'propose'
  ui.intent = null
  ui.guessing = true
  if (!more) {
    ui.guesses = []
    ui.judged = false
    ui.seenGuessLabels = []
  }
  emit()
  runIntentGuesses(editor, token, { more })
}

export function scheduleIntentGuesses(editor) {
  requestIntentGuesses(editor, { more: false })
}

async function runIntentGuesses(editor, token, { more = false } = {}) {
  const seen = new Set((ui.seenGuessLabels || []).map((s) => String(s).trim()))
  const local = localGuesses(getSnapshot().spans, editor).filter((g) => !seen.has(g.label))
  if (token !== guessToken) return
  try {
    const localInk = readInkText()
    if (localInk.text) applyWrittenNote(localInk.text, { confident: localInk.confident, silent: true })
    const handwriting = [ui.noteText, localInk.text].filter(Boolean).join('')
    const hit = await guessAnnotationIntent(editor, null, {
      silent: true,
      more,
      exclude: [...seen],
      handwriting,
    })
    if (token !== guessToken) return
    let next = (hit?.guesses || []).map(normalizeGuessItem).filter(Boolean)
    next = next.filter((g) => g.label && !seen.has(g.label))
    if (!next.length) next = local.slice(0, 4)
    ui.guesses = next.slice(0, 4)
    ui.judged = true
    ui.seenGuessLabels = [...seen, ...ui.guesses.map((g) => g.label)]
    if (hit?.command) replaceCommandText(hit.command)
    if (hit?.note) ui.note = hit.note
    if (hit?.text) ui.noteText = hit.text
    ui.noteConfident = Boolean(hit?.text || next.length)
  } catch {
    if (token !== guessToken) return
    ui.guesses = local.slice(0, 4)
    ui.judged = true
    ui.seenGuessLabels = [...seen, ...ui.guesses.map((g) => g.label)]
  } finally {
    if (token === guessToken) {
      ui.guessing = false
      emit()
      const msg = more
        ? ui.guesses.length
          ? '又给出几条。点一项执行，或再要几条'
          : '没有更多新的推测了'
        : ui.guesses.length
          ? '判断好了。点一项执行；不满意可再要几条'
          : '没看懂这次笔迹，可再画一点后重新判断'
      guessRuntime.deps?.toast?.(msg)
    }
  }
}

function guessNeedsValue(id, command) {
  if (String(id).startsWith('delete')) return false
  if (LOCAL_ANNO.has(id) || id === 'clear-anno' || id === 'indent' || id === 'move-layout' || id === 'shadow' || id === 'reflect' || id === 'scale-down' || id === 'scale-up' || id === 'trim' || id === 'background') {
    return false
  }
  if (id === 'scheme' || id === 'insert-text' || id === 'insert-image') return true
  if (needsColor(id) && !ui.color && !command) return true
  if (needsName(id) && !ui.productName.trim() && !command) return true
  if (id === 'custom' && !command && !ui.moreText.trim() && !ui.noteText.trim()) return true
  return false
}

let lastGuessAt = 0

function applyGuess(guess, editor, deps) {
  if (guess?.wait || !guess?.id) {
    deps?.toast?.('这一条还不能执行，换一条或再给几条')
    return
  }
  if (performance.now() - lastGuessAt < 350) return
  lastGuessAt = performance.now()
  guessToken += 1
  window.clearTimeout(scheduleIntentGuesses.timer)
  ui.guessing = false
  for (const stroke of getInkStrokes()) {
    if (stroke?.length >= 2) keepPaintMark(stroke, { append: true, color: '#1d1916' })
  }
  const targetsNow = ensureTargetsForGuess()
  clearInk()
  const id = canonicalizeGuessId(guess.id, guess.label, guess.note)
  const label = String(guess.label || '').trim()
  const command = String(guess.command || '').trim()
  ui.note = guess.note || parseNote(label) || ui.note
  ui.noteText = label || command || ui.noteText
  ui.noteConfident = true
  const parsed = parseCommand([command, label, ui.noteText].filter(Boolean).join(' '))
  if (parsed.color) ui.color = parsed.color
  if (parsed.product && needsName(id)) ui.productName = parsed.product
  if (id === 'custom') ui.moreText = command || label
  if (command) replaceCommandText(command)
  else if (label) replaceCommandText(label)

  if (isWebDocActive()) {
    const webOp = String(id).startsWith('delete')
      ? id
      : LOCAL_ANNO.has(id) || id === 'clear-anno' || id === 'shadow' || id === 'reflect' || id === 'scale-down' || id === 'scale-up' || id === 'color'
        ? id
        : ''
    if (webOp) {
      if (webOp === 'color' && !parsed.color && !ui.color) {
        ui.intent = 'color'
        ui.step = 'values'
        emit()
        deps.toast('点色板里的颜色，页面会马上改')
        return
      }
      deps.toast(`正在执行：${label || localLabel(id)}`)
      const result = executeCircledOp(webOp, {
        color: parsed.color || ui.color,
        label: label || localLabel(id),
        onBefore: (lab) => rememberLocal(editor, lab),
      })
      if (!result.ok) {
        deps.toast(result.reason || '没有改到圈中的内容')
        emit()
        return
      }
      startReview()
      emit()
      deps.toast(result.message)
      return
    }
  }

  if (
    LOCAL_ANNO.has(id) ||
    id === 'clear-anno' ||
    id === 'indent' ||
    id === 'move-layout' ||
    id === 'shadow' ||
    id === 'reflect' ||
    id === 'scale-down' ||
    id === 'scale-up' ||
    id === 'trim' ||
    id === 'background'
  ) {
    deps.toast(`正在执行：${label || localLabel(id)}`)
    pickOption(id, deps, editor)
    return
  }

  ui.intent = id
  const valueHint = parsed.color || parsed.product || ui.color || (id === 'custom' ? command : '')
  if (guessNeedsValue(id, valueHint)) {
    ui.step = 'values'
    emit()
    deps.toast(needsColor(id) ? '点色板里的颜色，页面会马上改' : '还差一个值，填完就会改页面')
    return
  }
  if (isWebDocActive() && !targetsNow.length && String(id).startsWith('delete')) {
    deps.toast('圈的位置没对上网页元素。请贴着图标或文字再画一圈')
    emit()
    return
  }
  applyCommandText()
  deps.toast(`正在执行：${label || localLabel(id) || '这项操作'}`)
  runIntent(editor, deps, 'inside')
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

function looksLikePageLine(spans = getSnapshot().spans) {
  if (ui.lastPaint?.length && looksLikeDrawnLine(ui.lastPaint)) return true
  return (spans || []).some((s) => s.lineMark)
}

function looksLikeCircledRegion(spans = getSnapshot().spans) {
  if (looksLikePageLine(spans) || looksLikeIndent(spans) || looksLikeLayout(spans)) return false
  if (ui.lastPaint?.length >= 10) {
    const pts = ui.lastPaint
    const box = aabb(pts)
    const closed = dist(pts[0], pts[pts.length - 1]) < Math.max(box.w, box.h) * 0.3
    return closed && box.w > 22 && box.h > 22
  }
  return (spans || []).some((s) => s.paintMark && s.kind === 'slot')
}

function addLineStyleChoices(add) {
  for (const s of LINE_STYLE_DEFS) add(s.id, s.label)
  for (const s of LINE_STYLE_DEFS) add(`${s.id}-h`, `水平${s.label}`)
  for (const s of LINE_STYLE_DEFS) add(`${s.id}-v`, `垂直${s.label}`)
}

function parseLineKind(kind) {
  if (kind.endsWith('-h')) return { style: kind.slice(0, -2), axis: 'h' }
  if (kind.endsWith('-v')) return { style: kind.slice(0, -2), axis: 'v' }
  return { style: kind, axis: null }
}

function isPageLineChoice(id) {
  const { style, axis } = parseLineKind(id)
  if (!LINE_STYLE_DEFS.some((s) => s.id === style)) return false
  if (axis) return true
  if (style === 'wavy') return looksLikePageLine()
  return true
}

function looksLikeIndent(spans) {
  if (looksLikePageLine(spans)) return false
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
    add('circle', '加上一个圈')
    add('highlight', '加上高亮')
    add('strike', '加上删除线')
    add('longer', '扩写圈中文字')
  }
  if (images.length) {
    add('shadow', '给这张图加阴影')
    add('frame', '给图加上边框')
    add('deco', '加标注或图案')
  }
  if (slots.length || empty) {
    add('frame', '加上一个框')
    add('circle', '加上一个圈')
    add('insert-text', '插入一段文字')
    add('insert-image', '插入图片')
  }
}

function addChangeChoices(add, { texts, images }) {
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
    if (pattern && !color) add('pattern', '改图案')
  }
  if (texts.length) {
    add('polish', '润色这段')
    add('spoken', '改成更口语')
    add('formal', '改成更正式')
    add('bold', '改成加粗')
    add('shorter', '写短一点')
  }
  add('custom', '换成我写的 / 换成我描述的样子')
  if (images.length) add('anchor', '照着这里改别处')
  if (name && ui.productName.trim().length > 4) {
    add('print-short', '杯面用简称')
    add('print-shrink', '缩小写进像素')
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

  if (hasLayoutWork(spans) || looksLikeLayout(spans) || layoutSourceWaiting(spans)) {
    if (looksLikeLayout(spans)) add('move-layout', '移到画出的位置')
    return bits
  }

  if (note === 'delete') {
    if (texts.length && images.length) {
      add('delete', '字和图一起删')
      add('delete-text', '删掉这些字')
      add('delete-image', '删掉这块图')
    } else if (images.length) add('delete-image', '删掉圈中这块')
    else if (texts.length) add('delete-text', '删掉这些字')
    else add('delete', '删掉圈中这块')
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
    if (looksLikePageLine(spans)) {
      addLineStyleChoices(add)
      return bits
    }
    if (looksLikeCircledRegion(spans)) {
      add('frame', '加上一个框')
      add('circle', '加上一个圈')
      add('shadow', '加上阴影')
      if (texts.length) add('longer', '扩写圈中文字')
      if (slots.length || empty) {
        add('insert-text', '插入一段文字')
        add('insert-image', '插入图片')
      }
      if (images.length) add('shadow', '给这张图加阴影')
      if (texts.length && images.length) add('fuse', '把圈中的字融入图')
      return bits
    }
    addDecorChoices(add, { texts, images, slots, empty: empty || !texts.length && !images.length })
    if (texts.length && images.length) add('fuse', '把圈中的字融入图')
    if (looksLikeShadow(spans, editor)) {
      const packed = cupScreenBox(editor)
      add('shadow', shadowOptionLabel(ui.lastPaint, packed?.cup))
    }
    if (!bits.length) add('insert-text', '插入一段文字')
    return bits
  }

  if (note === 'shadow' || note === 'reflect') {
    if (note === 'reflect') add('reflect', '加上倒影')
    else add('shadow', '加上阴影')
    add(note === 'reflect' ? 'shadow' : 'reflect', note === 'reflect' ? '加上阴影' : '加上倒影')
    add('custom', '按我写的改')
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
    addChangeChoices(add, { texts, images })
    if (!bits.length) add('custom', '换成我写的 / 换成我描述的样子')
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
  if (looksLikePageLine(spans)) {
    addLineStyleChoices(add)
    return bits
  }
  if (looksLikeCircledRegion(spans)) {
    const decor = classifyDecorStroke(ui.lastPaint, spans)
    if (decor === 'reflect') add('reflect', '加上倒影')
    if (decor === 'shadow' || looksLikeShadow(spans, editor)) {
      const packed = cupScreenBox(editor)
      add('shadow', shadowOptionLabel(ui.lastPaint, packed?.cup))
    }
    if (!decor) {
      add('frame', '加上一个框')
      add('circle', '加上一个圈')
    }
    add('shadow', '加上阴影')
    add('reflect', '加上倒影')
    return bits
  }
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
    const sch = schemeById(ui.scheme)
    const a = ui.schemeAssign
    const mods = ui.schemeModules || []
    if (a && mods.length) {
      const bits = mods.map((m) => `${m.label.split(' · ')[0]}${a[m.id] ? a[m.id] : ''}`)
      replaceCommandText(`配色 ${sch?.label || ''}：${bits.join('、')}`)
    } else replaceCommandText(sch ? `改成${sch.label}配色：${sch.colors.join('、')}` : '改配色')
  } else if (ui.intent === 'print-short') replaceCommandText(`${ui.productName.trim() || '简称'}，杯面用简称`)
  else if (ui.intent === 'print-shrink') replaceCommandText(`${ui.productName.trim()}，缩小写进像素`)
  else {
    const parts = []
    if (needsName(ui.intent) && ui.productName.trim()) parts.push(ui.productName.trim())
    if (needsColor(ui.intent) && ui.color) parts.push(ui.color)
    if (ui.printFit === 'short') parts.push('杯面用简称')
    if (ui.printFit === 'shrink') parts.push('缩小写进像素')
    if (parts.length) replaceCommandText(parts.join('，'))
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
  if (step === 'propose') return '画完后开始判断'
  if (step === 'review') return '已改这些地方'
  if (intent === 'name' || intent === 'print-short') return '改成什么名字'
  if (intent === 'color') return '改成什么颜色'
  if (intent === 'name-color') return '新品名和颜色'
  if (intent === 'scheme') return ui.schemeAssign ? '已按模块上色，点旁边的标签可单独改' : '选一套配色'
  if (intent === 'insert-text') return '要插入的文字'
  if (intent === 'custom') return '写成什么样'
  if (intent === 'anchor') return '照着这里改别处'
  if (String(intent).startsWith('delete')) return '确认删除'
  return '再补一点'
}

function btn(label, { primary, on, title, pointer } = {}, onClick) {
  const el = document.createElement('button')
  el.type = 'button'
  if (primary) el.className = 'primary'
  if (on) el.classList.add('is-on')
  el.textContent = label
  if (title) el.title = title
  const go = (e) => {
    e.stopPropagation()
    if (pointer) e.preventDefault()
    onClick()
  }
  el.addEventListener(pointer ? 'pointerdown' : 'click', go)
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
  caption.textContent = '先画、再写。画完点「开始判断」，系统给出几条可能操作。不满意再要几条，选中后才改网页。'
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
  const shapeOnly =
    looksLikePageLine(spans) ||
    looksLikeCircledRegion(spans) ||
    looksLikeLayout(spans) ||
    Boolean(layoutSourceWaiting(spans))
  const modules = spans.filter((s) => (s.kind === 'text' || s.kind === 'image') && !s.frozen)
  if (!shapeOnly && modules.length > 1) {
    const row = document.createElement('p')
    row.className = 'card-hint'
    row.textContent = '每块左上角有勾，默认全选。取消勾则不改那一块。'
    bar.append(row)
  }
  const indentWaiting = spans.filter((s) => s.indentMark).length === 1
  if (indentWaiting) {
    const row = document.createElement('p')
    row.className = 'card-hint'
    row.textContent = '再在段前画一个小方格，就会空两格。'
    bar.append(row)
  }
  const under = shapeOnly ? '' : underSelectHint(spans)
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
  if (id === 'scale-down' || id === 'scale-up') {
    const down = id === 'scale-down'
    const label = down ? '缩小' : '放大'
    if (!withLocalUndo(editor, label, () => {
      if (!isWebDocActive()) return false
      return applyWebScale(down ? 0.82 : 1.22, label)
    })) {
      deps.toast('先圈要缩放的 Logo 或图片')
      return
    }
    clearPaintMarks()
    deps.toast(down ? '已缩小 Logo。可点「还原这一处」' : '已放大 Logo。可点「还原这一处」')
    startReview()
    emit()
    return
  }
  if (id === 'shadow') {
    if (!withLocalUndo(editor, '阴影', () => {
      if (isWebDocActive()) {
        const pts = ui.lastPaint
        if (pts?.length >= 6 && applyShapedShadow(pts, editor)) return true
        return applyWebShadow()
      }
      return applyShadow(editor)
    })) {
      deps.toast('先在杯子旁涂一块再加阴影')
      return
    }
    clearPaintMarks()
    deps.toast('已按你画的形状加上投影。可点「撤回刚才」')
    startReview()
    emit()
    return
  }
  if (id === 'reflect') {
    if (!withLocalUndo(editor, '倒影', () => {
      if (isWebDocActive()) return applyWebReflect()
      const img = editor?.view?.dom?.querySelector('img[data-block-id]')
      if (!img) return false
      img.style.webkitBoxReflect = 'below 6px linear-gradient(transparent 35%, rgba(0,0,0,.4))'
      return true
    })) {
      deps.toast('先圈要加倒影的图')
      return
    }
    clearPaintMarks()
    deps.toast('已加上倒影。可点「撤回刚才」')
    startReview()
    emit()
    return
  }
  if (LOCAL_ANNO.has(id) || id === 'clear-anno') {
    if (withLocalUndo(editor, localLabel(id), () => applyLocalAnno(id, editor))) {
      clearPaintMarks()
      deps.toast(id === 'clear-anno' ? '已去掉这些批注。可撤回' : '已加上。可点「撤回刚才」')
      if (isPageLineChoice(id) || id === 'circle' || id === 'frame') {
        startReview()
        emit()
        return
      }
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
      clearPaintMarks()
      deps.toast('已空两格。可撤回，或点「同样的也改」套到全页')
      ui.intent = 'indent'
      ui.step = 'values'
      emit()
      return
    }
    deps.toast('靠近段首再画两个小格')
    return
  }
  if (id === 'move-layout') {
    let count = 0
    const ok = withLocalUndo(editor, '挪位置', () => {
      count = isWebDocActive() ? applyWebLayoutMoves() : applyLayoutMoves(editor)
      return count
    })
    if (!ok) {
      deps.toast('先用一支颜色圈模块，再用同一颜色圈它要去的位置')
      return
    }
    clearPaintMarks()
    deps.toast(`已移到画出的位置，共 ${count} 处。可撤回`)
    startReview()
    emit()
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

function decoPoint(p) {
  const host = decoHost()
  if (!host || !p) return null
  const box = host.getBoundingClientRect()
  return { x: p.x - box.left, y: p.y - box.top }
}

function clampDecoPoint(p) {
  const page = document.querySelector('.page')
  const host = decoHost()
  if (!page || !host || !p) return p
  const pb = page.getBoundingClientRect()
  const hb = host.getBoundingClientRect()
  const style = getComputedStyle(page)
  const padL = parseFloat(style.paddingLeft) || 8
  const padR = parseFloat(style.paddingRight) || 8
  const padT = parseFloat(style.paddingTop) || 8
  const padB = parseFloat(style.paddingBottom) || 8
  const minX = pb.left + padL - hb.left
  const minY = pb.top + padT - hb.top
  const maxX = pb.right - padR - hb.left
  const maxY = pb.bottom - padB - hb.top
  return {
    x: Math.min(Math.max(minX, p.x), maxX),
    y: Math.min(Math.max(minY, p.y), maxY),
  }
}

function wavyPath(x1, y1, x2, y2, amp = 5, wave = 16) {
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy) || 1
  const px = -dy / len
  const py = dx / len
  const steps = Math.max(10, Math.round(len / 8))
  let d = `M${x1} ${y1}`
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps
    const s = Math.sin((len / wave) * t * Math.PI)
    d += ` L${x1 + dx * t + px * s * amp} ${y1 + dy * t + py * s * amp}`
  }
  return d
}

function snapLineToAxis(a, b, axis) {
  const len = Math.max(48, Math.hypot(b.x - a.x, b.y - a.y))
  if (axis === 'h') {
    const y = Math.round((a.y + b.y) / 2)
    let x2 = b.x
    if (Math.abs(x2 - a.x) < 12) x2 = a.x + (b.x >= a.x ? len : -len)
    return [{ x: a.x, y }, { x: x2, y }]
  }
  if (axis === 'v') {
    const x = Math.round((a.x + b.x) / 2)
    let y2 = b.y
    if (Math.abs(y2 - a.y) < 12) y2 = a.y + (b.y >= a.y ? len : -len)
    return [{ x, y: a.y }, { x, y: y2 }]
  }
  return [a, b]
}

function applyDrawnLine(kind) {
  const host = decoHost()
  if (!host) return false
  const { style, axis } = parseLineKind(kind)
  const pts = ui.lastPaint
  let a
  let b
  if (pts?.length >= 2) {
    a = decoPoint(pts[0])
    b = decoPoint(pts[pts.length - 1])
  } else {
    const rect = paintRect()
    if (!rect) return false
    a = decoPoint({ x: rect.x, y: rect.y + rect.h / 2 })
    b = decoPoint({ x: rect.x + rect.w, y: rect.y + rect.h / 2 })
  }
  if (!a || !b) return false
  a = clampDecoPoint(a)
  b = clampDecoPoint(b)
  if (axis) {
    const snapped = snapLineToAxis(a, b, axis)
    a = clampDecoPoint(snapped[0])
    b = clampDecoPoint(snapped[1])
  }
  if (Math.hypot(b.x - a.x, b.y - a.y) < 12) return false
  const pad = 18
  const minX = Math.min(a.x, b.x) - pad
  const minY = Math.min(a.y, b.y) - pad
  const w = Math.abs(b.x - a.x) + pad * 2
  const h = Math.abs(b.y - a.y) + pad * 2
  const x1 = a.x - minX
  const y1 = a.y - minY
  const x2 = b.x - minX
  const y2 = b.y - minY
  const el = document.createElement('div')
  el.className = `page-deco is-stroke is-${kind}`
  el.style.left = `${minX}px`
  el.style.top = `${minY}px`
  el.style.width = `${Math.max(8, w)}px`
  el.style.height = `${Math.max(8, h)}px`
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', `0 0 ${Math.max(8, w)} ${Math.max(8, h)}`)
  svg.setAttribute('preserveAspectRatio', 'none')
  const addPath = (d, width) => {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', '#3c6fd4')
    path.setAttribute('stroke-width', String(width))
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-linejoin', 'round')
    svg.append(path)
  }
  if (style === 'wavy') addPath(wavyPath(x1, y1, x2, y2), 2.4)
  else if (style === 'line-double') {
    const dx = x2 - x1
    const dy = y2 - y1
    const len = Math.hypot(dx, dy) || 1
    const ox = (-dy / len) * 3.4
    const oy = (dx / len) * 3.4
    addPath(`M${x1 + ox} ${y1 + oy} L${x2 + ox} ${y2 + oy}`, 2.1)
    addPath(`M${x1 - ox} ${y1 - oy} L${x2 - ox} ${y2 - oy}`, 2.1)
  } else {
    const width = style === 'line-thin' ? 1.35 : style === 'line-thick' ? 7 : style === 'line-strike' ? 2.2 : 2.6
    addPath(`M${x1} ${y1} L${x2} ${y2}`, width)
  }
  el.append(svg)
  host.append(el)
  return true
}

function applyPageCircle() {
  const host = decoHost()
  if (!host) return false
  const rect = ui.lastPaint?.length ? aabb(ui.lastPaint) : paintRect()
  if (!rect || rect.w < 12 || rect.h < 12) return false
  const tl = decoPoint({ x: rect.x, y: rect.y })
  const br = decoPoint({ x: rect.x + rect.w, y: rect.y + rect.h })
  if (!tl || !br) return false
  const a = clampDecoPoint(tl)
  const b = clampDecoPoint(br)
  const pad = 8
  const minX = Math.min(a.x, b.x) - pad
  const minY = Math.min(a.y, b.y) - pad
  const w = Math.abs(b.x - a.x) + pad * 2
  const h = Math.abs(b.y - a.y) + pad * 2
  const el = document.createElement('div')
  el.className = 'page-deco is-stroke is-circle'
  el.style.left = `${minX}px`
  el.style.top = `${minY}px`
  el.style.width = `${Math.max(16, w)}px`
  el.style.height = `${Math.max(16, h)}px`
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', `0 0 ${Math.max(16, w)} ${Math.max(16, h)}`)
  svg.setAttribute('preserveAspectRatio', 'none')
  const ellipse = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse')
  ellipse.setAttribute('cx', String(w / 2))
  ellipse.setAttribute('cy', String(h / 2))
  ellipse.setAttribute('rx', String(Math.max(8, w / 2 - pad)))
  ellipse.setAttribute('ry', String(Math.max(8, h / 2 - pad)))
  ellipse.setAttribute('fill', 'none')
  ellipse.setAttribute('stroke', '#3c6fd4')
  ellipse.setAttribute('stroke-width', '2.4')
  svg.append(ellipse)
  el.append(svg)
  host.append(el)
  return true
}

function applyPageDeco(kind, editor) {
  if (PAGE_LINE.has(kind)) return applyDrawnLine(kind)
  if (kind === 'circle') return applyPageCircle()
  let rect = ui.lastPaint?.length ? aabb(ui.lastPaint) : paintRect()
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
  const tl = decoPoint({ x: rect.x, y: rect.y })
  const br = decoPoint({ x: rect.x + rect.w, y: rect.y + rect.h })
  if (!tl || !br) return false
  const a = clampDecoPoint(tl)
  const b = clampDecoPoint(br)
  const el = document.createElement('div')
  el.className = 'page-deco is-frame'
  el.style.left = `${Math.min(a.x, b.x)}px`
  el.style.top = `${Math.min(a.y, b.y)}px`
  el.style.width = `${Math.max(24, Math.abs(b.x - a.x))}px`
  el.style.height = `${Math.max(18, Math.abs(b.y - a.y))}px`
  host.append(el)
  return true
}

function applyTextAnno(editor, kind) {
  if (isWebDocActive() && applyWebAnno(kind)) return true
  const texts = getSnapshot().spans.filter((s) => s.kind === 'text' && s.willEdit !== false && s.from != null && s.to != null)
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
  if (isWebDocActive() && applyWebAnno('clear-anno')) {
    const host = document.querySelector('.page-deco-host')
    if (host && host.childNodes.length) host.replaceChildren()
    return true
  }
  const texts = getSnapshot().spans.filter((s) => s.kind === 'text' && s.willEdit !== false && s.from != null && s.to != null)
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
  if (isWebDocActive()) {
    if (kind === 'frame' || kind === 'line') {
      applyPageDeco(kind, editor)
      return
    }
    applyWebAnnoAll(kind)
    return
  }
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
  if (isWebDocActive()) {
    if (id === 'clear-anno') return clearTextAnno(editor)
    if (id === 'frame') return applyWebAnno('frame') || applyPageDeco('frame', editor)
    if (id === 'circle') return applyWebAnno('circle') || applyPageCircle()
    if (isPageLineChoice(id)) return applyDrawnLine(id)
    if (id === 'box') {
      const { texts } = selectionKinds()
      if (texts.length) return applyTextAnno(editor, 'box')
      return applyPageDeco('frame', editor)
    }
    return applyTextAnno(editor, id)
  }
  if (id === 'clear-anno') return clearTextAnno(editor)
  if (id === 'frame') return applyPageDeco('frame', editor)
  if (id === 'circle') return applyPageCircle()
  if (isPageLineChoice(id)) return applyDrawnLine(id)
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
  if (isWebDocActive()) return applyWebIndent()
  const spans = getSnapshot().spans
  const start = indentStartPos(editor, spans)
  if (start == null) return false
  const t = editor.state.doc.textBetween(start, Math.min(start + 2, editor.state.doc.content.size))
  if (!t.startsWith('　')) editor.chain().focus().insertContentAt(start, '　　').run()
  return true
}

function applyIndentAll(editor) {
  if (isWebDocActive()) {
    applyWebIndent({ all: true })
    return
  }
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
  const found = []
  for (const block of listColorBlocks(editor)) {
    found.push({
      kind: 'text',
      block_id: block.blockId,
      from: block.from,
      to: block.to,
      text: block.text,
      start: 0,
      end: block.text.length,
    })
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
  ui.intent = 'scheme'
  ui.step = 'values'
  ui.pageRecolor = true
  ui.scheme = ''
  ui.schemeAssign = null
  ui.schemeSlot = null
  ui.schemeModules = []
  emit()
  return true
}

let schemeGen = 0

async function commitScheme(editor, { follow = false, slot = null, label } = {}) {
  if (!ui.schemeAssign) return false
  let modules = ui.schemeModules || []
  if (follow) {
    modules = collectSchemeModules(editor, { pageWide: true })
    const sch = schemeById(ui.scheme)
    if (sch) ui.schemeAssign = assignSchemeToModules(sch, modules)
    ui.schemeModules = modules
  }
  if (!modules.length) return false
  const slotMod = slot ? modules.find((m) => m.id === slot) : null
  snapshotLocal(editor, label || (slotMod ? `配色·${slotMod.label}` : '配色'))
  const gen = ++schemeGen
  try {
    const ok = await applyPageScheme(editor, {
      assign: ui.schemeAssign,
      modules,
      slot,
    })
    if (gen !== schemeGen) return false
    if (!ok) {
      localUndos.pop()
      return false
    }
    emit()
    return true
  } catch {
    if (gen === schemeGen) localUndos.pop()
    return false
  }
}

export function toggleSchemeSlot(id) {
  ui.schemeSlot = ui.schemeSlot === id ? null : id
  emit()
}

export function closeSchemeSlot() {
  if (!ui.schemeSlot) return
  ui.schemeSlot = null
  emit()
}

function schemeColorFor(module) {
  const sch = schemeById(ui.scheme)
  if (!sch) return null
  const fresh = assignSchemeToModules(sch, ui.schemeModules || [])
  if (module.kind === 'paper') return fresh.paper || fresh[module.id]
  return fresh[module.id] || null
}

export function restoreSchemeModuleColor(editor, moduleId, toast) {
  if (!ui.schemeAssign) return
  const active = (ui.schemeModules || []).find((m) => m.id === moduleId)
  const colorId = active ? schemeColorFor(active) : null
  if (!active || !colorId) {
    closeSchemeSlot()
    return
  }
  setSchemeModuleColor(editor, moduleId, colorId, toast, { restore: true })
}

export function setSchemeModuleColor(editor, moduleId, colorId, toast, { restore = false } = {}) {
  if (!ui.schemeAssign) return
  const modules = ui.schemeModules || []
  const active = modules.find((m) => m.id === moduleId)
  if (!active) return
  const next = { ...ui.schemeAssign }
  if (active.kind === 'paper') {
    next.paper = paperFill(colorId)
    next[active.id] = next.paper
  } else next[active.id] = colorId
  ui.schemeAssign = next
  if (active.kind === 'image') ui.color = colorId
  ui.schemeSlot = null
  commitScheme(editor, { slot: active.id }).then((ok) => {
    toast?.(ok ? (restore ? `已恢复${active.label}` : `已改${active.label}`) : '这一块没改上')
  })
}

function runPickedColor(editor, deps, name) {
  ui.color = name
  applyCommandText()
  if (isWebDocActive()) {
    const result = executeCircledOp('color', {
      color: name,
      label: `改成${name}`,
      onBefore: (lab) => rememberLocal(editor, lab),
    })
    if (!result.ok) {
      deps.toast(result.reason || '没有改到圈中的内容')
      return
    }
    startReview()
    emit()
    deps.toast(result.message)
    return
  }
  runIntent(editor, deps, 'inside')
}

function runIntent(editor, deps, scope) {
  ui.elsewhere = scope
  if (ui.intent === 'scale-down' || ui.intent === 'scale-up') {
    pickOption(ui.intent, deps, editor)
    return
  }
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
  if (ui.intent === 'scheme') {
    const run = async () => {
      if (scope === 'follow' && !ui.pageRecolor) {
        const ok = await commitScheme(editor, { follow: true, label: '配色（全页）' })
        if (!ok) {
          deps.toast('先点一套配色')
          return
        }
        deps.toast('已套到全页标题、正文、杯子和纸面。可撤回')
      } else if (!ui.schemeAssign) {
        deps.toast('先点一套配色')
        return
      } else {
        deps.toast('已按模块上色。点模块旁的颜色标签可单独改')
      }
      startReview()
      emit()
    }
    run()
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
  if (ui.guessing) hint.textContent = '正在根据你画的和写下的判断意图…'
  else if (layoutSourceWaiting(spans) && !looksLikeLayout(spans)) hint.textContent = '再用同一颜色圈它要去的位置'
  else if (ui.judged) hint.textContent = '点一项就执行。不满意可再要几条。'
  else hint.textContent = '圈、涂、写都会一起看。有字会先认出来，再和画的位置合着判断。画完点「开始判断」。'
  bar.append(hint)

  const tools = document.createElement('div')
  tools.className = 'card-row'
  if (!ui.guessing && !ui.judged) {
    tools.append(
      btn('开始判断', { primary: true, pointer: true }, () => {
        requestIntentGuesses(editor, { more: false })
      }),
    )
  }
  if (!ui.guessing && ui.judged) {
    tools.append(
      btn('再给几条', { primary: true, pointer: true }, () => {
        requestIntentGuesses(editor, { more: true })
      }),
    )
  }
  tools.append(
    btn('重新圈选', { pointer: true }, () => {
      cancelGuesses()
      clearInk()
      replaceSpans([])
      idleCard()
      deps.toast('已清掉这次笔迹，再画一次')
    }),
  )
  bar.append(tools)

  if (ui.guessing && !ui.guesses.length) return
  if (!ui.judged && !ui.guesses.length) return

  const guesses = ui.guesses
  if (!guesses.length) return
  const list = document.createElement('div')
  list.className = 'card-guesses'
  guesses.forEach((guess, i) => {
    const el = btn(guess.label, { primary: i === 0 && !guess.wait }, () => clickGuessAt(i, editor))
    el.dataset.guessIndex = String(i)
    el.dataset.guessId = guess.id
    el.dataset.guessLabel = guess.label
    if (guess.wait) el.disabled = true
    list.append(el)
  })
  bar.append(list)
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
    note.textContent = '会从网页去掉圈中的图标、链接或文字。'
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
    const note = document.createElement('p')
    note.className = 'card-note'
    note.textContent = ui.pageRecolor
      ? '点一套风格：圈中的每一段字、杯子、纸面会分到这套里的几种颜色。单独微调请点模块旁的颜色标签。'
      : '点一套风格：你圈到的每一段字会分到这套里的几种颜色。单独微调请点模块旁的颜色标签。'
    bar.append(note)
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
        d.style.background = c?.fill || id
        d.title = id
        dots.append(d)
      }
      b.append(name, dots)
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        ui.scheme = sch.id
        ui.schemeModules = collectSchemeModules(editor, { pageWide: ui.pageRecolor })
        if (!ui.schemeModules.length) {
          deps.toast('先圈要改的字或图')
          return
        }
        ui.schemeAssign = assignSchemeToModules(sch, ui.schemeModules)
        ui.schemeSlot = null
        const imgMod = ui.schemeModules.find((m) => m.kind === 'image')
        ui.color = imgMod ? ui.schemeAssign[imgMod.id] : sch.colors[0]
        commitScheme(editor, { label: sch.label }).then((ok) => {
          deps.toast(ok ? `已套上「${sch.label}」。点模块旁的颜色标签可单独改` : '这套配色没套上')
        })
      })
      row.append(b)
    }
    bar.append(row)

    if (ui.schemeAssign) {
      const hint = document.createElement('p')
      hint.className = 'card-note'
      hint.textContent = '要单独改某一段，点它旁边的颜色标签。'
      bar.append(hint)
    }

    if (ui.pageRecolor) {
      bar.append(
        btn('完成', { primary: true }, () => {
          if (!ui.schemeAssign) {
            deps.toast('先点一套配色')
            return
          }
          startReview()
          emit()
        }),
        btn('上一步', {}, goBack),
      )
    } else {
      followActions(bar, editor, deps, () => {
        if (!ui.scheme) {
          deps.toast('先点一套配色')
          return false
        }
        return true
      })
    }
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
        runPickedColor(editor, deps, swatch.id)
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
      runPickedColor(editor, deps, picker.value)
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
  const edits = listWebEdits()
  for (const item of edits) {
    const li = document.createElement('li')
    const restored = item.keep === false
    const line = document.createElement('button')
    line.type = 'button'
    line.className = 'change-line'
    line.textContent = item.label || '网页改动'
    const toggle = btn(restored ? '改回这一处' : '还原这一处', {}, () => {
      const ok = restored ? redoWebEdit(item.id) : restoreWebEdit(item.id)
      deps.toast(ok ? (restored ? '已改回这一处' : '已还原这一处') : '这一处没能撤回')
    })
    li.append(line, toggle)
    list.append(li)
  }
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
  if (!edits.length && !snap.changes.length) {
    const empty = document.createElement('p')
    empty.className = 'card-note'
    empty.textContent = '没有留下改动点。'
    bar.append(empty)
  } else bar.append(list)
  appendUndoRow(bar, editor, deps)
}

export function fillNoviceCard(bar, editor, deps) {
  guessRuntime.editor = editor
  guessRuntime.deps = deps
  const snap = getSnapshot()
  const spans = snap.spans
  const webCount = listWebEdits().length
  if (ui.hideCard && !spans.length && !(snap.changes || []).length && !webCount) return
  const showReview = ui.step === 'review' || (!spans.length && (snap.changes.length || webCount))
  if (showReview && ui.step !== 'review') ui.step = 'review'

  if (!spans.length && !showReview) {
    if (canUndoLocal() && !ui.hideCard) {
      const title = document.createElement('div')
      title.className = 'card-title'
      title.textContent = '刚才的操作可以撤回'
      bar.append(title)
      appendUndoRow(bar, editor, deps)
    } else if (ui.coachOn) {
      const title = document.createElement('div')
      title.className = 'card-title'
      title.textContent = '先画完，再点开始判断'
      bar.append(title)
    }
    return
  }

  if (showReview) {
    fillReview(bar, editor, deps)
    return
  }

  if (ui.step === 'values' && ui.intent) {
    fillHints(bar, editor, spans)
    fillValues(bar, editor, deps)
  } else fillPropose(bar, spans, editor, deps)
  appendUndoRow(bar, editor, deps)
}
