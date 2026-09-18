import { generateImage, rewriteText } from './api.js'
import { DEMO_CUP, getDemoPage, pageRelativeRect } from './editor.js'
import { COLOR_TERMS } from './forbidden.js'
import { COLORS, COLOR_SCHEMES } from './colors.js'
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
  applySimilarWebShadows,
  countSimilarShadowHosts,
  describePaintScene,
  executeCircledOp,
  inferWebLayoutPairs,
  insertWebImage,
  insertWebStamp,
  insertWebText,
  applyGeneratedWebImage,
  circledImageSeed,
  insertAroundCopy,
  isWebDocActive,
  lassoPolys,
  listWebEdits,
  popLastWebEdit,
  undoWebEditsSince,
  redoWebEdit,
  refreshWebTargetsFromDrawing,
  restoreWebEdit,
  rewriteCircledText,
  peekShadowLabel,
} from './web-doc.js'
import { clearPaintMarks, getPaintMarks, setSubtractMode } from './overlay.js'
import { redoChange, restoreChange } from './changes.js'
import { clearInk, readInkText } from './ink.js'
import { captureInsertScene, classifyDrawnGesture, drawnStampDataUrl, drawnStampScreenBox, looksLikeDrawnPattern } from './capture.js'
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
  'insert-text': '自己写文字插入',
  'generate-text': 'AI生成一句文案插入',
  'insert-image': '从本地选一张图插入',
  'generate-image': 'AI生成一张图放到圈里',
  deco: '加装饰',
  indent: '空两格',
  'move-layout': '挪位置',
  'move-nudge': '挪一点',
  'nudge-left': '往左挪',
  'nudge-right': '往右挪',
  'nudge-up': '往上挪',
  'nudge-down': '往下挪',
  shadow: '阴影',
  'clear-deco': '去掉装饰',
  'delete-deco': '去掉装饰',
  soften: '减弱装饰',
  'color-bg': '改底色',
  'color-text': '改字色',
  'color-image': '改图颜色',
  stamp: '加上画出的图案',
  polish: '润色这段',
  longer: '扩写',
  shorter: '写短一点',
  spoken: '改成更口语',
  formal: '改成更正式',
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
    webDoc: isWebDocActive(),
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
  if (snap.webDoc) undoWebEditsSince(snap.at)
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
  typedText: '',
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
  fromModel: false,
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
  ui.fromModel = false
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
  cancelGuesses()
  ui.step = 'idle'
  ui.intent = null
  ui.hideCard = true
  ui.note = ''
  ui.noteText = ''
  ui.noteConfident = false
  ui.typedText = ''
  ui.lastPaint = null
  clearInk()
  clearPaintMarks()
  replaceSpans([])
  emit()
}

export function idleCard({ accept = false } = {}) {
  cancelGuesses()
  ui.step = 'idle'
  ui.intent = null
  ui.note = ''
  ui.noteText = ''
  ui.noteConfident = false
  ui.typedText = ''
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

function shadowGuessLabel(fallback = '加上阴影') {
  try {
    if (isWebDocActive()) return peekShadowLabel()
  } catch {
    /* ignore */
  }
  return fallback
}

export function markCrossOut() {
  ui.note = 'delete'
  ui.noteText = '×'
  ui.step = 'propose'
  ui.intent = null
  emit()
}

function colorFromWriting(text) {
  const t = String(text || '').replace(/\s+/g, '')
  if (!t) return ''
  const named = COLORS.find((c) => t.includes(c.id))
  if (named) return named.id
  const alias = [
    ['红色', '红色'],
    ['红色', '红'],
    ['雾蓝', '蓝色'],
    ['雾蓝', '蓝'],
    ['墨绿', '绿色'],
    ['墨绿', '绿'],
    ['黑色', '黑'],
    ['白色', '白'],
    ['姜黄', '黄'],
    ['粉色', '粉'],
    ['落日', '橙'],
    ['暮紫', '紫'],
    ['岩灰', '灰'],
  ]
  for (const [id, key] of alias) {
    if (t.includes(key)) return id
  }
  return ''
}

function parseNote(text) {
  const t = String(text || '')
    .replace(/\s+/g, '')
    .trim()
  if (!t) return ''
  if (t === '×' || t === 'x' || t === 'X') return 'delete'
  if (/去掉(阴影|倒影|投影|框|边框|装饰|标注|高亮|下划线|批注)|取消(阴影|倒影|框|装饰)|不要(阴影|倒影|框)/.test(t)) return 'clear-deco'
  if (/减弱.*(阴影|装饰|投影)|淡化阴影/.test(t)) return 'soften'
  if (/倒影|镜像|反射/.test(t) && !/去|删|消/.test(t)) return 'reflect'
  if (/阴影|投影|影子/.test(t) && !/去|删|消/.test(t)) return 'shadow'
  if (/风格|配色|整套色|统一色/.test(t)) return 'scheme'
  if (/图案|贴上这个|加上这个画|画上去|加上画出/.test(t)) return 'stamp'
  if (/缩小|变小|小一点|缩小一点|更小/.test(t)) return 'scale-down'
  if (/放大|变大|大一点|放大一点|更大/.test(t)) return 'scale-up'
  if (/底色|背景色|改背景|背景改/.test(t)) return 'color-bg'
  if (/字色|文字颜色|字体颜色|只改字/.test(t)) return 'color-text'
  if (/只改(图|logo|图标).*色|图.*改成/.test(t) && /色/.test(t)) return 'color-image'
  if (/往左|向左|左移|向左挪/.test(t)) return 'nudge-left'
  if (/往右|向右|右移|向右挪/.test(t)) return 'nudge-right'
  if (/往上|向上|上移|往上挪/.test(t)) return 'nudge-up'
  if (/往下|向下|下移|往下挪/.test(t)) return 'nudge-down'
  if (/挪位置|移到|移动到|挪到|换位置|调整布局/.test(t) && !/logo|图标|图片|插画|文字/.test(t)) return 'move-layout'
  if (/加粗/.test(t)) return 'bold'
  if (/高亮/.test(t)) return 'highlight'
  if (/下划线/.test(t)) return 'underline'
  if (/加框|套个框|加边框|加个框/.test(t)) return 'frame'
  if (/生成.*(图|图片|插画|配图|logo|图标)|文生图|AI画|画一张|换一张图|换成一张|换掉.*(图|图片|logo|配图)|重新生成/.test(t)) return 'generate-image'
  if (/(加|插|放|贴|来).{0,8}(小)?(logo|图标|图片|插画|配图|徽章|头像)|小logo|加logo/.test(t) && !/色|改字/.test(t)) return 'generate-image'
  if (/logo|图标|徽章/.test(t) && /加|插|放|贴|来一个|空白/.test(t) && !/色|改字|文字/.test(t)) return 'generate-image'
  if (/从本地|选一张图|上传图片|插入图片|加图|插图|贴图/.test(t)) return 'insert-image'
  if (/润色|改措辞|改写|更通顺|通顺一点|优化语言/.test(t)) return 'polish'
  if (/扩写|写长|写得更长|更长一些/.test(t)) return 'longer'
  if (/写短|写得更短|精简一下|缩短/.test(t) && !/缩小/.test(t)) return 'shorter'
  if (/口语/.test(t)) return 'spoken'
  if (/正式/.test(t)) return 'formal'
  if (/AI.*(写|生成).*(字|文案|句子)|生成一句|生成文案|帮我写一句|让模型写/.test(t) && !/图|logo|图标/.test(t)) return 'generate-text'
  if (/加字|加点字|加上字|插入文字|写一句|来一句|欢迎语|标语|口号|文案/.test(t)) return 'insert-text'
  if (/加字|加点|加上|加个|插入|写一句|放一张|空白.*加|这里加|加东西/.test(t) && !/logo|图|图标/.test(t)) return 'insert'
  if (/改颜色|改色|换色|变色|颜色|配色|上色|着色|染色/.test(t)) return 'color'
  if (/^[红蓝绿黄黑白灰橙紫粉]$/.test(t) || /改成.{0,2}[红蓝绿黄黑白灰橙紫粉]|[红蓝绿黄]色/.test(t)) return 'color'
  if (/色|彩/.test(t) && !/删|去|减/.test(t)) return 'color'
  if (/只删(字|文字)|删掉这些字/.test(t)) return 'delete-text'
  if (/只删(图|图片)|删掉这块图/.test(t)) return 'delete-image'
  if (/删|叉|去|消|隐藏|去掉|删掉|不要了|抹掉|擦掉这个/.test(t)) return 'delete'
  if (/减|短|少|精简/.test(t)) return 'cut'
  if (/添|加|插|扩/.test(t)) return 'add'
  return 'custom'
}

function looksLikeImageAsk(text) {
  const t = String(text || '')
  if (!t) return false
  if (/色|改字|文字颜色/.test(t) && !/logo|图/.test(t)) return false
  return /logo|图标|图片|插画|配图|插图|徽章|头像|海报/.test(t) || /(加|插|放|贴|来).{0,8}图/.test(t)
}

function extractLiteralInsert(text) {
  const t = String(text || '').trim()
  if (!t) return ''
  const quoted = t.match(/[「『“"](.+?)[」』”"]/)
  if (quoted?.[1]?.trim()) return quoted[1].trim()
  const named = t.match(/^(?:改成|写成|换成|插入文字|插入)[:：\s]*(.+)$/)
  if (named?.[1] && !looksLikeImageAsk(named[1]) && !/欢迎语|标语|口号|文案|一句/.test(named[1])) {
    return named[1].trim()
  }
  if (!/加|插|写一句|生成|来一句|帮我|请|空白/.test(t) && t.length >= 2 && t.length <= 80) return t
  return ''
}

function looksLikeTextInstruction(text) {
  const t = String(text || '').trim()
  if (!t || looksLikeImageAsk(t) || extractLiteralInsert(t)) return false
  const note = parseNote(t)
  if (note && note !== 'insert' && note !== 'insert-text' && note !== 'generate-text' && note !== 'add' && note !== 'custom') return false
  return /加一句|写一句|插入.*字|来一句|生成.*文|欢迎语|标语|口号|文案|帮我写|随便写|加点字|加字|空白.*字/.test(t)
}

function blankWantsInsert(ask, note, scene) {
  if (!isWebDocActive()) return false
  if (!(scene?.blank || sceneIsBlank()) || scene?.drawn) return false
  if (inferWebLayoutPairs().length || looksLikeLayout(getSnapshot().spans)) return false
  const n = String(note || parseNote(ask) || '')
  if (
    n === 'delete' ||
    n.startsWith('delete') ||
    n === 'color' ||
    n.startsWith('color') ||
    n === 'scheme' ||
    n.startsWith('scale') ||
    n === 'move-layout' ||
    n.startsWith('nudge') ||
    n === 'shadow' ||
    n === 'reflect' ||
    n === 'stamp' ||
    n === 'frame' ||
    n === 'circle' ||
    n === 'clear-deco' ||
    n === 'soften'
  ) {
    return false
  }
  const t = String(ask || '')
  if (t && /删|色|缩小|放大|阴影|风格|挪|移到/.test(t) && !/加|插|logo|图|字|文案/.test(t)) return false
  return true
}

function blankInsertGuesses(ask) {
  const t = String(ask || '').trim()
  const note = parseNote(t)
  const generateImage = { id: 'generate-image', label: 'AI生成一张图放到圈里', note: 'generate-image', command: t }
  const insertImage = { id: 'insert-image', label: '从本地选一张图插入', note: 'insert-image', command: '' }
  const generateText = { id: 'generate-text', label: 'AI生成一句文案插入', note: 'generate-text', command: t }
  const insertText = { id: 'insert-text', label: '自己写文字插入', note: 'insert-text', command: '' }
  if (looksLikeImageAsk(t) || note === 'generate-image' || note === 'insert-image') {
    return [generateImage, insertImage, generateText, insertText]
  }
  if (looksLikeTextInstruction(t) || note === 'insert-text' || note === 'generate-text' || note === 'insert') {
    return [generateText, insertText, generateImage, insertImage]
  }
  return [generateText, generateImage, insertText, insertImage]
}

async function gatherInsertContext() {
  let scene = { aroundImageDataUrl: '', circledImageDataUrl: '', pageImageDataUrl: '', pageText: '' }
  try {
    scene = await captureInsertScene()
  } catch {
    scene = { aroundImageDataUrl: '', circledImageDataUrl: '', pageImageDataUrl: '', pageText: '' }
  }
  let around = ''
  try {
    around = insertAroundCopy()
  } catch {
    around = ''
  }
  const images = [scene.aroundImageDataUrl, scene.circledImageDataUrl, scene.pageImageDataUrl].filter(Boolean)
  const pageContext = [around, scene.pageText].filter(Boolean).join('\n').slice(0, 1800)
  return { images, pageContext, around }
}

async function writeInsertCopy(instruction) {
  const ctx = await gatherInsertContext()
  const data = await rewriteText(
    '这不是改写已有段落。请根据用户要求，并结合圈出空白及其周围的真实网页，新写一句要插入该空白处的短文案。只输出文案本身，不要解释，不要重复用户的指令。语言、语气、主题、长度都要贴合周围页面。若用户已用引号给出原文案，则原样使用那句。',
    instruction || '写一句简短合适、能放进当前网页空白处的文案',
    {
      pageContext: ctx.pageContext,
      imageDataUrls: ctx.images,
    },
  )
  return String(data?.text || '')
    .replace(/^["「『]|["」』]$/g, '')
    .trim()
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
  if (layoutSourceWaiting(spans) || looksLikeLayout(spans) || hasLayoutWork(spans)) return false
  if (pts?.length >= 8) {
    const box = aabb(pts)
    const peri = 2 * (box.w + box.h)
    const len = pathLength(pts)
    const closed = dist(pts[0], pts[pts.length - 1]) < Math.max(box.w, box.h) * 0.35
    if (closed && box.w > 36 && box.h > 28 && len < peri * 2.5) return false
    const insidePaint = getPaintMarks().some((mark) => {
      if (!mark.points?.length) return false
      const pb = aabb(mark.points)
      return box.w < 280 && box.h < 280 && box.x >= pb.x - 24 && box.y >= pb.y - 24 && box.x + box.w <= pb.x + pb.w + 24 && box.y + box.h <= pb.y + pb.h + 24
    })
    if (insidePaint) return true
  }
  if (!spans.some((s) => s.kind === 'text' || s.kind === 'image' || s.kind === 'slot')) return false
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
  ui.typedText = ''
  ui.intent = null
  ui.step = 'propose'
  emit()
}

function sceneIsBlank() {
  try {
    if (isWebDocActive()) return Boolean(describePaintScene().blank)
  } catch {
    /* ignore */
  }
  const spans = getSnapshot().spans
  const { texts, images, slots } = selectionKinds(spans)
  return Boolean((slots.length || looksLikeCircledRegion(spans)) && !texts.length && !images.length)
}

function verbFamily(note) {
  const n = String(note || '')
  if (n === 'add' || n === 'insert' || n === 'insert-text' || n === 'generate-text' || n === 'insert-image' || n === 'generate-image' || n === 'deco' || n === 'frame' || n === 'circle' || n === 'shadow' || n === 'reflect') {
    return 'add'
  }
  if (n.startsWith('delete') || n === 'clear-deco' || n === 'clear-anno') return 'delete'
  if (n === 'scheme' || n.startsWith('color')) return 'color'
  if (n.startsWith('scale')) return 'scale'
  if (n.startsWith('nudge') || n === 'move-layout') return 'move'
  return ''
}

function mapNoteToIntent(note, label) {
  const n = String(note || parseNote(label) || '').trim()
  if (n === 'delete' || n === 'delete-text' || n === 'delete-image') return n
  if (n === 'clear-deco' || n === 'delete-deco' || n === 'soften') return n === 'delete-deco' ? 'clear-deco' : n
  if (n === 'insert' || n === 'insert-text') return 'insert-text'
  if (n === 'generate-text') return 'generate-text'
  if (n === 'insert-image') return 'insert-image'
  if (n === 'generate-image') return 'generate-image'
  if (n === 'add') return sceneIsBlank() ? 'insert-text' : 'frame'
  if (n === 'color' || n === 'color-bg' || n === 'color-text' || n === 'color-image') return n
  if (n === 'scheme') return 'scheme'
  if (n === 'stamp') return 'stamp'
  if (n === 'shadow' || n === 'reflect') return n
  if (n === 'scale-down' || n === 'scale-up') return n
  if (n.startsWith('nudge-') || n === 'move-nudge' || n === 'move-layout') return n
  if (n === 'frame' || n === 'bold' || n === 'highlight' || n === 'underline') return n
  if (n === 'indent' || n === 'move') return n === 'move' ? 'move-layout' : 'indent'
  if (n === 'cut') return 'shorter'
  if (n === 'change' || n === 'polish' || n === 'longer' || n === 'shorter' || n === 'spoken' || n === 'formal') {
    return n === 'change' ? 'polish' : n
  }
  return 'custom'
}

const GUESS_IDS = new Set([
  'delete',
  'delete-image',
  'delete-text',
  'delete-deco',
  'clear-deco',
  'clear-anno',
  'soften',
  'color',
  'color-bg',
  'color-text',
  'color-image',
  'scheme',
  'stamp',
  'insert-text',
  'generate-text',
  'insert-image',
  'generate-image',
  'insert',
  'deco',
  'name',
  'name-color',
  'polish',
  'longer',
  'shorter',
  'spoken',
  'formal',
  'custom',
  'frame',
  'circle',
  'shadow',
  'reflect',
  'scale-down',
  'scale-up',
  'indent',
  'move-layout',
  'move-nudge',
  'nudge-left',
  'nudge-right',
  'nudge-up',
  'nudge-down',
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
  配色: 'scheme',
  风格: 'scheme',
  图案: 'stamp',
  stamp: 'stamp',
  阴影: 'shadow',
  倒影: 'reflect',
  shrink: 'scale-down',
  'scale-down': 'scale-down',
  缩小: 'scale-down',
  grow: 'scale-up',
  放大: 'scale-up',
  润色: 'polish',
  rewrite: 'polish',
  改字: 'polish',
  'delete-deco': 'clear-deco',
  去掉装饰: 'clear-deco',
  'clear-deco': 'clear-deco',
  往左: 'nudge-left',
  往右: 'nudge-right',
  往上: 'nudge-up',
  往下: 'nudge-down',
  插入: 'insert-text',
  加字: 'insert-text',
  加图: 'insert-image',
  生成图: 'generate-image',
  换图: 'generate-image',
  生成文字: 'generate-text',
  写文案: 'generate-text',
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
  const parsedLabel = parseNote(label)
  const note = String(
    parsedLabel && parsedLabel !== 'custom' && parsedLabel !== 'change'
      ? parsedLabel
      : item.note || parsedLabel || '',
  ).trim()
  const command = String(item.command || '').trim()
  const fromText = mapNoteToIntent(note, label)
  let id = canonicalizeGuessId(item.id || item.intent, label, note)
  if ((id === 'custom' || id === 'polish' || id === 'shorter') && fromText !== 'custom') id = fromText
  if (
    fromText === 'scale-down' ||
    fromText === 'scale-up' ||
    fromText === 'delete' ||
    fromText === 'delete-text' ||
    fromText === 'delete-image' ||
    fromText === 'shadow' ||
    fromText === 'reflect' ||
    fromText === 'clear-deco' ||
    fromText === 'soften' ||
    fromText === 'insert' ||
    fromText === 'insert-text' ||
    fromText === 'generate-text' ||
    fromText === 'insert-image' ||
    fromText === 'generate-image' ||
    fromText === 'add' ||
    fromText === 'color-bg' ||
    fromText === 'color-text' ||
    fromText === 'scheme' ||
    fromText === 'stamp' ||
    fromText === 'polish' ||
    fromText === 'longer' ||
    fromText === 'shorter' ||
    fromText === 'spoken' ||
    fromText === 'formal' ||
    String(fromText).startsWith('nudge-')
  ) {
    id = fromText
  }
  if (id === 'add') id = sceneIsBlank() ? 'insert-text' : 'frame'
  if (id === 'insert') id = 'insert-text'
  if (!label && !id) return null
  return { id, label: label || localLabel(id) || '按这个改', note, command }
}

function ptsToPoly(pts) {
  if (!pts?.length) return null
  return pts.length >= 3 ? strokeToPolygon(pts) : pts
}

function collectDrawingPolys() {
  const fromLasso = lassoPolys()
  if (fromLasso.length) return fromLasso
  const polys = []
  const add = (pts) => {
    const poly = ptsToPoly(pts)
    if (poly?.length) polys.push(poly)
  }
  add(ui.lastPaint)
  for (const mark of getPaintMarks()) add(mark.points)
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

function uniqueGuesses(list) {
  const out = []
  const seen = new Set()
  for (const g of list || []) {
    if (!g?.id && !g?.label) continue
    const key = `${g.id}::${g.label}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(g)
  }
  return out
}

function sceneLabel(scene) {
  if (scene?.kind === 'image') return '圈中这块图'
  if (scene?.kind === 'text') return '圈中这些字'
  if (scene?.kind === 'mixed') return '圈中这块'
  return '圈中这块'
}

function relabelGuesses(list, scene, verb) {
  const target = sceneLabel(scene)
  const mapped = (list || []).map((g) => {
    let label = String(g.label || '')
    if (!scene?.blank) {
      label = label
        .replace(/圈中空白区域内容/g, target)
        .replace(/空白区域内容/g, target)
        .replace(/空白区域/g, target)
        .replace(/圈里的空白处/g, target)
        .replace(/空白处/g, target)
    }
    return { ...g, label }
  })
  const fam = verbFamily(verb) || verbFamily(mapped[0]?.id) || verbFamily(mapped[0]?.note)
  const prefer = []
  if (looksLikeStampGuess(verb, ui.noteText, mapped)) {
    const gesture = classifyDrawnGesture()
    prefer.push({ id: 'stamp', label: gesture.label || '加上画出的图案', note: 'stamp', command: '' })
  }
  if (inferWebLayoutPairs().length || verb === 'move-layout' || fam === 'move') {
    prefer.push({ id: 'move-layout', label: '把圈中模块移到另一圈的位置', note: 'move-layout', command: '' })
  }
  if (fam === 'scale' || verb === 'scale-down' || verb === 'scale-up') {
    const id = verb === 'scale-up' ? 'scale-up' : 'scale-down'
    prefer.push({
      id,
      label: id === 'scale-down' ? `缩小${target}` : `放大${target}`,
      note: id,
      command: '',
    })
  }
  if (fam === 'color' || String(verb).startsWith('color') || verb === 'scheme') {
    const mods = collectSchemeModules(guessRuntime.editor, { pageWide: false }).filter((m) => m.kind !== 'paper')
    if (verb === 'scheme' || mods.length >= 2) {
      prefer.push({ id: 'scheme', label: '给圈中几处套一套颜色风格', note: 'scheme', command: '' })
    }
    prefer.push({ id: verb.startsWith('color-') ? verb : 'color', label: `改${target}的颜色`, note: verb.startsWith('color-') ? verb : 'color', command: '' })
  }
  if (verb === 'generate-image') {
    prefer.push({
      id: 'generate-image',
      label: scene?.blank ? '生成一张图放到圈里' : '按要求生成一张图换上',
      note: 'generate-image',
      command: '',
    })
  }
  if (verb === 'polish' || verb === 'longer' || verb === 'shorter' || verb === 'spoken' || verb === 'formal') {
    const labels = {
      polish: '润色这段',
      longer: '扩写圈中文字',
      shorter: '写短一点',
      spoken: '改成更口语',
      formal: '改成更正式',
    }
    prefer.push({ id: verb, label: labels[verb], note: verb, command: '' })
  }
  if (!prefer.length) return uniqueGuesses(mapped).slice(0, 4)
  const rest = mapped.filter((g) => !prefer.some((p) => p.id === g.id))
  return uniqueGuesses([...prefer, ...rest]).slice(0, 4)
}

function looksLikeStampGuess(verb, written, list = []) {
  const t = String(written || '')
  if (/图案|贴上这个|加上这个画|画上去|加上画出|光芒|放射/.test(t) || verb === 'stamp') return true
  if (list.some((g) => String(g.id) === 'stamp' || /画出的图案|加上这个图案|光芒/.test(g.label || ''))) return true
  if (!isWebDocActive()) return false
  const gesture = classifyDrawnGesture()
  if (gesture.kind === 'stamp') return true
  if (!looksLikeDrawnPattern()) return false
  const note = parseNote(t)
  if (t && note && note !== 'custom' && note !== 'insert' && note !== 'add' && note !== 'stamp') return false
  return true
}

function reconcileGuesses(vl, local, verb, scene, { more = false } = {}) {
  const gesture = classifyDrawnGesture()
  const vlNorm = uniqueGuesses(vl || [])
  const ask = `${ui.typedText || ''} ${ui.noteText || ''}`
  if (!more && blankWantsInsert(ask, verb || ui.note, scene)) {
    const inserts = blankInsertGuesses(ask)
    const rest = (vlNorm.length ? vlNorm : local || []).filter((g) => !inserts.some((p) => p.id === g.id))
    return uniqueGuesses([...inserts, ...rest]).slice(0, 4)
  }
  if (gesture.kind === 'stamp') {
    const stamp = { id: 'stamp', label: gesture.label || '加上画出的图案', note: 'stamp', command: '' }
    const rest = vlNorm.filter(
      (g) =>
        g.id !== 'stamp' &&
        g.id !== 'insert-text' &&
        g.id !== 'insert-image' &&
        !/插入文字|涂鸦装饰|多余笔画|清除此处/.test(g.label || ''),
    )
    const later = vlNorm.filter((g) => g.id === 'insert-text' || g.id === 'insert-image')
    return uniqueGuesses([stamp, ...rest, ...later]).slice(0, 4)
  }
  if (gesture.kind === 'move-layout') {
    const move = { id: 'move-layout', label: gesture.label, note: 'move-layout', command: '' }
    return relabelGuesses(uniqueGuesses([move, ...vlNorm, ...(local || [])]), scene, 'move-layout')
  }
  if (gesture.kind === 'underline') {
    const line = { id: 'underline', label: gesture.label, note: 'underline', command: '' }
    return uniqueGuesses([line, ...vlNorm]).slice(0, 4)
  }
  if (vlNorm.length) {
    return relabelGuesses(vlNorm, scene, verb)
  }
  if (scene?.blank && verbFamily(verb) === 'add' && !scene?.drawn) {
    return uniqueGuesses(local).slice(0, 4)
  }
  if (verb && local.length) return relabelGuesses(uniqueGuesses(local), scene, verb)
  return relabelGuesses(local, scene, verb)
}

function localGuesses(spans, editor) {
  if (layoutSourceWaiting(spans) && !looksLikeLayout(spans) && !hasLayoutWork(spans)) {
    return [{ id: '', label: '再用同一颜色圈要放到的位置', note: '', command: '', wait: true }]
  }
  const opts = proposeOptions(spans, editor)
  const out = opts.slice(0, 4).map(([id, label]) => ({ id, label, note: ui.note, command: '' }))
  if (looksLikeLayout(spans) || hasLayoutWork(spans)) return out
  const addLike = verbFamily(ui.note) === 'add'
  if (addLike) return out
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
  const typedNow = String(ui.typedText || '').trim()
  if (!more) {
    if (typedNow) applyWrittenNote(typedNow, { confident: true, silent: true })
    else {
      ui.note = ''
      ui.noteText = ''
      ui.noteConfident = false
    }
  }
  const noteNow = parseNote(typedNow)
  const depsNow = guessRuntime.deps
  if (!more && depsNow && isWebDocActive()) {
    if ((noteNow === 'move-layout' || /移动|挪到|移到|换位置/.test(typedNow)) && inferWebLayoutPairs().length) {
      pickOption('move-layout', depsNow, editor)
      return
    }
  }
  const token = ++guessToken
  ui.step = 'propose'
  ui.intent = null
  ui.guessing = true
  if (!more) {
    ui.guesses = []
    ui.judged = false
    ui.seenGuessLabels = []
    ui.fromModel = false
  }
  emit()
  runIntentGuesses(editor, token, { more })
}

export function scheduleIntentGuesses(editor) {
  requestIntentGuesses(editor, { more: false })
}

async function runIntentGuesses(editor, token, { more = false } = {}) {
  const seen = new Set((ui.seenGuessLabels || []).map((s) => String(s).trim()))
  if (token !== guessToken) return
  let local = []
  try {
    const scene = isWebDocActive() ? describePaintScene() : { blank: sceneIsBlank(), text: '' }
    const gesture = classifyDrawnGesture()
    const typed = String(ui.typedText || '').trim()
    const hit = await guessAnnotationIntent(editor, null, {
      silent: true,
      more,
      exclude: [...seen],
      handwriting: typed,
      sceneText: [scene.text, gesture.hint].filter(Boolean).join('\n'),
    })
    if (token !== guessToken) return
    const localInk = hit?.fromModel ? { text: '', confident: false } : readInkText()
    let written = String(typed || hit?.text || (localInk.confident ? localInk.text : '') || '').trim()
    if (
      !typed &&
      gesture.kind &&
      (!written ||
        written.length <= 2 ||
        /涂鸦|笔画/.test(written) ||
        ['custom', 'add', 'insert', 'change'].includes(parseNote(written)))
    ) {
      written = ''
    }
    const parsed = parseNote(written)
    const verb = (parsed && parsed !== 'custom' ? parsed : '') || gesture.kind || hit?.note || ui.note
    if (written) applyWrittenNote(written, { confident: Boolean(hit?.fromModel || localInk.confident), note: verb, silent: true })
    local = localGuesses(getSnapshot().spans, editor).filter((g) => !seen.has(g.label))
    let next = (hit?.guesses || []).map(normalizeGuessItem).filter(Boolean)
    next = next.filter((g) => g.label && !seen.has(g.label))
    next = reconcileGuesses(next, local, verb, scene, { more })
    if (!next.length) next = local.slice(0, 4)
    ui.guesses = next.slice(0, 4)
    ui.judged = true
    ui.seenGuessLabels = [...seen, ...ui.guesses.map((g) => g.label)]
    if (hit?.command) replaceCommandText(hit.command)
    if (hit?.fromModel) ui.note = verb || hit.note || ui.note
    else if (verb) ui.note = verb
    if (written) ui.noteText = written
    ui.noteConfident = Boolean(hit?.fromModel || written)
    ui.fromModel = Boolean(hit?.fromModel)
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
      if (!more && ui.guesses.length && ui.fromModel) {
        const typed = String(ui.typedText || '').trim()
        const heard = typed
          ? `已按输入的「${typed}」判断`
          : ui.noteText
            ? `已认出「${ui.noteText}」`
            : '已按圈和笔迹判断'
        guessRuntime.deps?.toast?.(`${heard}，并给出操作。点一项执行`)
      } else {
        guessRuntime.deps?.toast?.(msg)
      }
    }
  }
}

function guessNeedsValue(id, command) {
  if (String(id).startsWith('delete')) return false
  if (LOCAL_ANNO.has(id) || id === 'clear-anno' || id === 'clear-deco' || id === 'delete-deco' || id === 'soften' || id === 'indent' || id === 'move-layout' || String(id).startsWith('nudge-') || id === 'move-nudge' || id === 'shadow' || id === 'reflect' || id === 'scale-down' || id === 'scale-up' || id === 'trim' || id === 'background' || id === 'color-bg' || id === 'color-text' || id === 'color-image') {
    return false
  }
  if (id === 'scheme' || id === 'insert-text' || id === 'insert-image') return true
  if (id === 'generate-text' && !command && !ui.typedText.trim() && !ui.moreText.trim()) return true
  if (id === 'generate-image' && !command && !ui.typedText.trim() && !ui.moreText.trim() && !ui.noteText.trim()) return true
  if (id === 'stamp') return false
  if (needsColor(id) && !ui.color && !command) return true
  if (needsName(id) && !ui.productName.trim() && !command) return true
  if (id === 'custom' && !command && !ui.moreText.trim() && !ui.noteText.trim()) return true
  return false
}

function imagePromptText() {
  const typed = String(ui.typedText || '').trim()
  if (typed) return typed
  const more = String(ui.moreText || '').trim()
  if (more) return more
  const note = String(ui.noteText || '').trim()
  if (note && !/生成一张图|选一张图|按要求生成|插入图片/.test(note)) return note
  return String(getSnapshot().commandText || '').trim()
}

function runGenerateImage(editor, deps) {
  if (!isWebDocActive()) {
    deps.toast('生成换图目前用于导入的网页')
    return
  }
  const prompt = imagePromptText()
  if (!prompt) {
    ui.intent = 'generate-image'
    ui.step = 'values'
    emit()
    deps.toast('写一下要生成什么样的图')
    return
  }
  deps.toast('正在结合圈中位置和周围页面生成图片…')
  const seed = circledImageSeed()
  Promise.resolve()
    .then(() => gatherInsertContext())
    .then((ctx) => {
      const fullPrompt = [
        `用户要求：${prompt}`,
        seed.scene || ctx.around || '',
        seed.imageDataUrl
          ? '请在原图构图和用途的基础上按用户要求改，生成适合该网页位置、并能和周围页面放在一起的新图。'
          : '请直接生成适合该网页空白位置、并能和周围页面放在一起的新图。',
      ]
        .filter(Boolean)
        .join('\n')
        .slice(0, 900)
      return generateImage({
        prompt: fullPrompt,
        imageDataUrl: seed.imageDataUrl,
        replaceExisting: Boolean(seed.imageDataUrl),
        contextImageDataUrls: ctx.images,
        pageContext: ctx.pageContext,
        width: seed.width,
        height: seed.height,
      })
    })
    .then((data) => {
      const src = data?.imageUrl
      if (!src) throw new Error('万相没有返回图片')
      let result = { ok: false, reason: '没能换上' }
      const ok = withLocalUndo(editor, '换成生成的图', () => {
        result = applyGeneratedWebImage(src)
        return result.ok
      })
      if (!ok) {
        deps.toast(result.reason || '没能换上生成的图')
        emit()
        return
      }
      clearInk()
      startReview()
      emit()
      deps.toast(result.message)
    })
    .catch((err) => {
      const gated = err?.code === 'client-gate' || err?.code === 'no_client_gate' || err?.code === 'calls_disabled'
      deps.toast(gated ? '服务器禁止调用：把 .env 里 MARKSET_ALLOW_MODEL_CALLS 改为 1 并重启' : err?.message || '没能生成图片')
      emit()
    })
}

function finishInsertedText(editor, deps, result) {
  if (!result?.ok) {
    deps.toast(result?.reason || '没能插入文字')
    ui.intent = 'insert-text'
    ui.step = 'values'
    emit()
    return
  }
  clearInk()
  startReview()
  emit()
  deps.toast(result.message)
}

function commitInsertText(editor, deps, raw) {
  const ask = String(raw || ui.productName || '').trim()
  const literal = extractLiteralInsert(ask) || ask
  if (!literal || /自己写文字插入|AI生成一句文案插入/.test(literal)) {
    ui.intent = 'insert-text'
    ui.step = 'values'
    emit()
    deps.toast('写下要插入的文字，或点「帮我写一句」')
    return
  }
  deps.toast('正在插入文字…')
  finishInsertedText(editor, deps, insertWebText(literal))
}

function commitGenerateText(editor, deps, raw) {
  const ask = String(raw || ui.typedText || ui.moreText || ui.productName || '').trim()
  const instruction = /自己写|AI生成|从本地|放到圈里|选一张图/.test(ask) ? '' : ask
  if (!instruction) {
    ui.intent = 'generate-text'
    ui.step = 'values'
    emit()
    deps.toast('写一下希望生成什么样的文案')
    return
  }
  deps.toast('正在结合周围页面生成要插入的文字…')
  writeInsertCopy(instruction)
    .then((text) => {
      if (!text) throw new Error('没有生成文案')
      finishInsertedText(editor, deps, insertWebText(text))
    })
    .catch((err) => {
      const gated = err?.code === 'client-gate' || err?.code === 'no_client_gate' || err?.code === 'calls_disabled'
      deps.toast(gated ? '服务器禁止调用：把 .env 里 MARKSET_ALLOW_MODEL_CALLS 改为 1 并重启' : err?.message || '没能生成文字')
      ui.intent = 'generate-text'
      ui.step = 'values'
      ui.productName = ask
      emit()
    })
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
  const targetsNow = ensureTargetsForGuess()
  const written = String(ui.typedText || ui.noteText || guess.command || '').trim()
  let id = canonicalizeGuessId(guess.id, guess.label, guess.note)
  const label = String(guess.label || '').trim()
  const command = String(guess.command || '').trim()
  ui.note = guess.note || parseNote(written) || parseNote(label) || ui.note
  ui.noteText = written || label || command || ui.noteText
  ui.noteConfident = true
  const parsed = parseCommand([written, command, label].filter(Boolean).join(' '))
  if (parsed.color) ui.color = parsed.color
  else if (colorFromWriting(written) || colorFromWriting(label) || colorFromWriting(command)) {
    ui.color = colorFromWriting(written) || colorFromWriting(label) || colorFromWriting(command)
  }
  if (parsed.product && needsName(id)) ui.productName = parsed.product
  if (id === 'custom') ui.moreText = command || label
  if (command) replaceCommandText(command)
  else if (label) replaceCommandText(label)

  if (isWebDocActive()) {
    if (id === 'stamp') {
      const src = drawnStampDataUrl()
      const box = drawnStampScreenBox()
      deps.toast(`正在执行：${label || '加上画出的图案'}`)
      let result = { ok: false, reason: '没有可放下的图案' }
      const ok = withLocalUndo(editor, '加上画出的图案', () => {
        result = insertWebStamp(src, box)
        return result.ok
      })
      if (!ok) {
        deps.toast(result.reason || '没能放下画出的图案')
        emit()
        return
      }
      clearInk()
      startReview()
      emit()
      deps.toast(result.message)
      return
    }
    if (id === 'generate-image') {
      runGenerateImage(editor, deps)
      return
    }
    if (id === 'generate-text') {
      commitGenerateText(editor, deps, written || command)
      return
    }
    if (id === 'insert-text') {
      const literal = extractLiteralInsert(written)
      ui.intent = 'insert-text'
      ui.step = 'values'
      ui.productName = literal || ''
      emit()
      deps.toast('写下要插入的文字，或点「帮我写一句」')
      return
    }
    if (id === 'insert-image') {
      deps.insertImage?.(editor)
      return
    }
    const rewriteIds = new Set(['polish', 'longer', 'shorter', 'spoken', 'formal', 'custom', 'name', 'rewrite'])
    if (rewriteIds.has(id)) {
      ui.intent = id
      applyCommandText()
      const instruction = String(getSnapshot().commandText || written || label || '').trim()
      deps.toast('正在改写圈中文字…')
      rewriteCircledText(instruction, {
        onBefore: (lab) => rememberLocal(editor, lab),
        kind: id,
      })
        .then((result) => {
          if (!result.ok) {
            deps.toast(result.reason || '没有改到圈中的文字')
            emit()
            return
          }
          clearInk()
          startReview()
          emit()
          deps.toast(result.message)
        })
        .catch((err) => {
          const gated = err?.code === 'client-gate' || err?.code === 'no_client_gate' || err?.code === 'calls_disabled'
          deps.toast(gated ? '服务器禁止调用：把 .env 里 MARKSET_ALLOW_MODEL_CALLS 改为 1 并重启' : err?.message || '改写失败')
          emit()
        })
      return
    }
    id = remapWebGuessId(id, written, label)
    if (id === 'scheme' || id === 'deco' || id === 'unify' || id === 'pattern') {
      applyDefaultScheme(editor, deps, { pageWide: /整页|整套|全部/.test(`${written}${label}`) })
      return
    }
    const webOp = String(id).startsWith('delete') || String(id).startsWith('nudge-')
      ? (id === 'delete-deco' ? 'clear-deco' : id)
      : LOCAL_ANNO.has(id) || id === 'clear-anno' || id === 'clear-deco' || id === 'soften' || id === 'shadow' || id === 'reflect' || id === 'scale-down' || id === 'scale-up' || id === 'color' || id === 'color-bg' || id === 'color-text' || id === 'color-image' || id === 'move-nudge'
        ? id
        : ''
    if (webOp) {
      const namedColor = parsed.color || ui.color || colorFromWriting(written) || colorFromWriting(label) || colorFromWriting(command)
      if (String(webOp).startsWith('color') && !namedColor) {
        openColorPalette(deps, webOp)
        return
      }
      const paintColor = namedColor
      if (String(webOp).startsWith('color')) ui.color = paintColor
      deps.toast(`正在执行：${label || localLabel(id)}`)
      const result = executeCircledOp(webOp, {
        color: paintColor,
        label: label || localLabel(id),
        onBefore: (lab) => rememberLocal(editor, lab),
        paint: ui.lastPaint,
      })
      if (!result.ok) {
        deps.toast(result.reason || '没有改到圈中的内容')
        emit()
        return
      }
      clearInk()
      if (webOp === 'shadow' && countSimilarShadowHosts()) {
        ui.intent = 'shadow'
        ui.step = 'values'
        ui.hideCard = false
        emit()
        deps.toast(`${result.message} 可点「同类模块也加上」`)
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
  if (isWebDocActive() && (id === 'deco' || /风格|配色/.test(`${written}${label}`))) {
    applyDefaultScheme(editor, deps, { pageWide: /整页|整套|全部/.test(`${written}${label}`) })
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
    add('generate-image', '按要求生成一张图换上')
    add('shadow', shadowGuessLabel('给这张图加阴影'))
    add('frame', '给图加上边框')
    add('deco', '加标注或图案')
  }
  if (slots.length || empty) {
    add('frame', '加上一个框')
    add('circle', '加上一个圈')
    add('insert-text', '插入一段文字')
    add('generate-image', '生成一张图放到圈里')
    add('insert-image', '从本地选一张图插入')
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
  let { texts, images, slots } = selectionKinds(spans)
  const scene = isWebDocActive() ? describePaintScene() : { blank: false, kind: '' }
  const empty = Boolean((slots.length && !texts.length && !images.length) || scene.blank)
  if (scene.blank) {
    texts = []
    images = []
  }
  const note = ui.note
  const bits = []
  const add = (id, label) => {
    if (!bits.some((b) => b[0] === id)) bits.push([id, label])
  }

  const layoutReady = looksLikeLayout(spans) || inferWebLayoutPairs().length
  if (layoutReady) add('move-layout', '把圈中模块移到另一圈的位置')
  if (layoutSourceWaiting(spans) && !layoutReady && (!note || note === 'move-layout')) return bits
  if (layoutReady && (note === 'move-layout' || String(note).startsWith('nudge-') || note === 'move-nudge')) {
    add(note.startsWith('nudge-') ? note : 'nudge-right', localLabel(note.startsWith('nudge-') ? note : 'nudge-right'))
    add('nudge-left', '往左挪一点')
    add('nudge-right', '往右挪一点')
    add('nudge-up', '往上挪一点')
    add('nudge-down', '往下挪一点')
    return bits
  }

  const gesture = classifyDrawnGesture()
  if (gesture.kind === 'stamp') {
    add('stamp', gesture.label || '加上画出的图案')
    add('frame', '给这块加上边框')
    add('color', '改圈中内容的颜色')
    add('insert-text', '还是在空白处插入文字')
    return bits
  }
  if (gesture.kind === 'move-layout') {
    add('move-layout', gesture.label)
    add('nudge-right', '往右挪一点')
    add('nudge-left', '往左挪一点')
    return bits
  }
  if (gesture.kind === 'underline') {
    add('underline', gesture.label)
    add('highlight', '改成高亮')
    add('bold', '改成加粗')
    return bits
  }

  const ask = `${ui.typedText || ''} ${ui.noteText || ''}`
  if (blankWantsInsert(ask, note, scene) && !layoutReady) {
    for (const g of blankInsertGuesses(ask)) add(g.id, g.label)
    return bits
  }

  const wantAdd =
    note === 'insert' ||
    note === 'insert-text' ||
    note === 'generate-text' ||
    note === 'insert-image' ||
    note === 'generate-image' ||
    note === 'add'
  if (wantAdd && note !== 'delete' && !String(note).startsWith('delete')) {
    for (const g of blankInsertGuesses(ask)) add(g.id, g.label)
    add('frame', '在这块空白加上一个框')
    add('deco', '在空白处加装饰或图案')
    if (note === 'add' && texts.length) add('longer', '扩写圈中文字')
    if (note === 'add' && images.length) add('shadow', shadowGuessLabel('给这张图加阴影'))
    if (empty || note === 'insert' || note === 'insert-text' || note === 'generate-text' || note === 'insert-image' || note === 'generate-image' || note === 'add') return bits
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

  if (note === 'clear-deco' || note === 'delete-deco' || note === 'soften') {
    add('clear-deco', '去掉圈里的阴影/框/标注')
    add('soften', '减弱阴影/装饰')
    add('clear-anno', '只去掉下划线/框/高亮')
    add('delete', '还是删掉这块内容')
    return bits
  }

  if (note === 'scale-down' || note === 'scale-up') {
    add(note, note === 'scale-down' ? '缩小圈中这块' : '放大圈中这块')
    if (images.length) add(note === 'scale-down' ? 'scale-down' : 'scale-up', note === 'scale-down' ? '只缩小图' : '只放大图')
    if (texts.length) add(note, note === 'scale-down' ? '缩小这些字' : '放大这些字')
    return bits
  }

  if (String(note).startsWith('nudge-') || note === 'move-layout' || note === 'move-nudge') {
    if (note === 'move-layout' || looksLikeLayout(spans)) add('move-layout', '移到画出的位置')
    add(note.startsWith('nudge-') ? note : 'nudge-right', localLabel(note.startsWith('nudge-') ? note : 'nudge-right'))
    add('nudge-left', '往左挪一点')
    add('nudge-right', '往右挪一点')
    add('nudge-up', '往上挪一点')
    add('nudge-down', '往下挪一点')
    return bits
  }

  if (note === 'generate-image' || note === 'generate-text') {
    if (note === 'generate-text' || empty || slots.length) {
      for (const g of blankInsertGuesses(`${ui.typedText || ''} ${ui.noteText || ''}`)) add(g.id, g.label)
      return bits
    }
    add('generate-image', images.length ? '按要求生成一张图换上' : 'AI生成一张图放到圈里')
    if (images.length) add('insert-image', '从本地选一张图插入')
    add('generate-text', 'AI生成一句文案插入')
    add('insert-text', '自己写文字插入')
    return bits
  }

  if (note === 'insert-image' || note === 'insert-text') {
    for (const g of blankInsertGuesses(`${ui.typedText || ''} ${ui.noteText || ''}`)) add(g.id, g.label)
    return bits
  }

  if (note === 'color-bg' || note === 'color-text' || note === 'color-image') {
    add(note, localLabel(note))
    add('color', '字和图一起改色')
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
      add('shadow', shadowGuessLabel())
      if (texts.length) add('longer', '扩写圈中文字')
      if (slots.length || empty) {
        for (const g of blankInsertGuesses(`${ui.typedText || ''} ${ui.noteText || ''}`)) add(g.id, g.label)
      }
      if (images.length) add('shadow', shadowGuessLabel('给这张图加阴影'))
      if (texts.length && images.length) add('fuse', '把圈中的字融入图')
      return bits
    }
    addDecorChoices(add, { texts, images, slots, empty: empty || !texts.length && !images.length })
    if (texts.length && images.length) add('fuse', '把圈中的字融入图')
    if (looksLikeShadow(spans, editor)) {
      const packed = cupScreenBox(editor)
      add('shadow', shadowGuessLabel(shadowOptionLabel(ui.lastPaint, packed?.cup)))
    }
    if (!bits.length) add('insert-text', '插入一段文字')
    return bits
  }

  if (note === 'shadow' || note === 'reflect') {
    if (note === 'reflect') add('reflect', '加上倒影')
    else add('shadow', shadowGuessLabel())
    add(note === 'reflect' ? 'shadow' : 'reflect', note === 'reflect' ? shadowGuessLabel() : '加上倒影')
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

  if (note === 'polish' || note === 'longer' || note === 'shorter' || note === 'spoken' || note === 'formal') {
    const labels = {
      polish: '润色这段',
      longer: '扩写圈中文字',
      shorter: '写短一点',
      spoken: '改成更口语',
      formal: '改成更正式',
    }
    add(note, labels[note])
    if (note !== 'polish') add('polish', '润色这段')
    if (note !== 'shorter') add('shorter', '写短一点')
    add('custom', '按我写的改')
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
    if (texts.length) {
      add('polish', '润色这段')
      add('longer', '扩写圈中文字')
      add('shorter', '写短一点')
      add('spoken', '改成更口语')
      add('custom', '按我写的改')
      return bits
    }
    const decor = classifyDecorStroke(ui.lastPaint, spans)
    if (decor === 'reflect') add('reflect', '加上倒影')
    if (decor === 'shadow' || looksLikeShadow(spans, editor)) {
      const packed = cupScreenBox(editor)
      add('shadow', shadowGuessLabel(shadowOptionLabel(ui.lastPaint, packed?.cup)))
    }
    if (!decor) {
      add('frame', '加上一个框')
      add('circle', '加上一个圈')
    }
    add('shadow', shadowGuessLabel())
    add('reflect', '加上倒影')
    return bits
  }
  if (looksLikeShadow(spans, editor)) {
    const packed = cupScreenBox(editor)
    add('shadow', shadowGuessLabel(shadowOptionLabel(ui.lastPaint, packed?.cup)))
  }
  const indentMarks = spans.filter((s) => s.indentMark)
  if (indentMarks.length === 1) return bits
  addDecorChoices(add, { texts, images, slots, empty })
  if (slots.length && !texts.length && !images.length && !indentMarks.length) {
    for (const g of blankInsertGuesses(`${ui.typedText || ''} ${ui.noteText || ''}`)) add(g.id, g.label)
  }
  if (texts.length) {
    add('name', '改名字')
    add('color', '改颜色')
    add('color-text', '只改这些字的颜色')
    add('polish', '润色这段')
    add('scale-down', '缩小这些字')
  }
  if (images.length && !texts.length) add('color', '改颜色')
  if (images.length) {
    add('generate-image', '按要求生成一张图换上')
    add('color-image', '只改图的颜色')
    add('scale-down', '缩小圈中这块')
    add('scale-up', '放大圈中这块')
    add('nudge-right', '往右挪一点')
  }
  if (texts.length && images.length) add('delete', '删掉圈里的')
  else if (images.length) add('delete-image', '删掉这块图')
  else if (texts.length) add('delete-text', '删掉这些字')
  add('clear-deco', '去掉圈里的装饰/标注')
  if (images.length) add('anchor', '照着这里改别处')
  return bits
}

function needsName(intent) {
  return intent === 'name' || intent === 'name-color' || intent === 'insert-text' || intent === 'print-short'
}

function needsColor(intent) {
  return intent === 'color' || intent === 'name-color' || intent === 'color-bg' || intent === 'color-text' || intent === 'color-image'
}

function openColorPalette(deps, intent = 'color') {
  ui.intent = intent
  ui.color = ''
  ui.step = 'values'
  emit()
  deps?.toast?.('点色板或打开调色盘选颜色，选完会马上改圈中的内容')
}

function openSchemeBars(editor, deps, { pageWide = false, silent = false } = {}) {
  ui.intent = 'scheme'
  ui.pageRecolor = pageWide
  ui.scheme = ''
  ui.schemeAssign = null
  ui.schemeSlot = null
  ui.schemeModules = collectSchemeModules(editor, { pageWide })
  ui.step = 'values'
  ui.hideCard = false
  emit()
  if (!silent) {
    deps?.toast?.(
      ui.schemeModules.length
        ? '点一套颜色风格条。圈中每一块会分到不同颜色，也可再点模块旁的色标微调'
        : '先圈要改颜色的几块内容',
    )
  }
}

function remapWebGuessId(id, written, label) {
  const blob = `${written || ''}${label || ''}`
  if (id === 'color' || String(id).startsWith('color-')) return id
  if (/边框|加框|套个框/.test(label || '') || id === 'frame' || id === 'box' || id === 'border') return 'frame'
  if (id === 'scheme' || id === 'deco' || id === 'unify' || id === 'pattern' || /风格|配色/.test(blob)) return 'scheme'
  return id
}

function applyDefaultScheme(editor, deps, { pageWide = false } = {}) {
  openSchemeBars(editor, deps, { pageWide, silent: true })
  const sch = COLOR_SCHEMES[0]
  ui.scheme = sch.id
  const modules = ui.schemeModules || []
  if (modules.length) {
    ui.schemeAssign = assignSchemeToModules(sch, modules)
    const imgMod = modules.find((m) => m.kind === 'image')
    ui.color = imgMod ? ui.schemeAssign[imgMod.id] : sch.colors[0]
  } else {
    ui.schemeAssign = { _: sch.colors[0] }
    ui.color = sch.colors[0]
  }
  ui.hideCard = false
  ui.step = 'values'
  emit()
  commitScheme(editor, { label: `套上「${sch.label}」` }).then((ok) => {
    deps?.toast?.(
      ok
        ? `已套上「${sch.label}」。可再点其他风格条，或点模块旁的色标微调`
        : '圈中的内容没改到，请贴着搜索框或标题再画一圈',
    )
    emit()
  })
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
  else if (ui.intent === 'custom') replaceCommandText(ui.moreText.trim() || ui.typedText.trim() || ui.noteText.trim())
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
  if (step === 'propose') return '圈完后输入或手写要求'
  if (step === 'review') return '已改这些地方'
  if (intent === 'name' || intent === 'print-short') return '改成什么名字'
  if (intent === 'color' || intent === 'color-bg' || intent === 'color-text' || intent === 'color-image') return '改成什么颜色'
  if (intent === 'name-color') return '新品名和颜色'
  if (intent === 'scheme') return ui.schemeAssign ? '已按模块上色，点旁边的标签可单独改' : '选一套配色'
  if (intent === 'insert-text') return '要插入的文字'
  if (intent === 'insert-image') return '插入或生成图片'
  if (intent === 'generate-image') return '生成什么样的图'
  if (intent === 'shadow') return '阴影已加上'
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
      if (isWebDocActive()) return applyWebShadow()
      const pts = ui.lastPaint
      if (pts?.length >= 6 && applyShapedShadow(pts, editor)) return true
      return applyShadow(editor)
    })) {
      deps.toast(isWebDocActive() ? '先圈要加阴影的模块' : '先在杯子旁涂一块再加阴影')
      return
    }
    clearPaintMarks()
    if (isWebDocActive() && countSimilarShadowHosts()) {
      ui.intent = 'shadow'
      ui.step = 'values'
      ui.hideCard = false
      emit()
      deps.toast('已加阴影。可点「同类模块也加上」套到同样的块')
      return
    }
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
    deps.toast('正在移动…')
    let count = 0
    if (isWebDocActive()) {
      count = applyWebLayoutMoves()
      if (!count) {
        deps.toast('先圈要挪的模块，再圈它要去的空白位置。后一圈不会当成新选区')
        return
      }
    } else {
      const ok = withLocalUndo(editor, '挪位置', () => {
        count = applyLayoutMoves(editor)
        return count
      })
      if (!ok) {
        deps.toast('先圈要挪的模块，再圈它要去的空白位置。后一圈不会当成新选区')
        return
      }
    }
    clearPaintMarks()
    deps.toast(`已移到画出的位置，周围布局已让开，共 ${count} 处。可撤回`)
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
  let modules = ui.schemeModules || []
  if (follow) {
    modules = collectSchemeModules(editor, { pageWide: true })
    const sch = schemeById(ui.scheme)
    if (sch) ui.schemeAssign = assignSchemeToModules(sch, modules)
    ui.schemeModules = modules
  }
  const sch = schemeById(ui.scheme) || COLOR_SCHEMES[0]
  if (isWebDocActive() && !slot) {
    snapshotLocal(editor, label || `套上「${sch.label}」`)
    const result = executeCircledOp('scheme', {
      color: sch.colors?.[0] || '粉色',
      label: label || `套上「${sch.label}」`,
      scheme: sch,
    })
    if (!result.ok) {
      localUndos.pop()
      return false
    }
    emit()
    return true
  }
  if (!ui.schemeAssign) return false
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
    const op = ui.intent === 'color-bg' || ui.intent === 'color-text' || ui.intent === 'color-image' ? ui.intent : 'color'
    const result = executeCircledOp(op, {
      color: name,
      label: op === 'color-bg' ? `底色改成${name}` : op === 'color-text' ? `字改成${name}` : `改成${name}`,
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
  const typed = String(ui.typedText || '').trim()
  if (ui.guessing) hint.textContent = typed ? '正在根据圈画和输入的要求判断…' : '正在根据你画的和写下的判断意图…'
  else if (layoutSourceWaiting(spans) && !looksLikeLayout(spans) && !inferWebLayoutPairs().length) hint.textContent = '再圈它要放到的空白位置。后一圈会当成落点，不会当成新选区'
  else if (looksLikeLayout(spans) || inferWebLayoutPairs().length) hint.textContent = '已认出模块和落点。点「移到画出的位置」'
  else if (ui.judged && isWebDocActive() && describePaintScene().blank && !inferWebLayoutPairs().length) {
    hint.textContent = typed
      ? `空白处已按「${typed}」判断。可选 AI 生成，或自己写 / 从本地插入。`
      : '圈的是空白。可选 AI 生成文字或图片，也可以自己写或从本地插入。'
  }
  else if (ui.judged) hint.textContent = typed ? `已按「${typed}」判断。点一项执行，或改输入后重新判断。` : '点一项就执行。不满意可再要几条。'
  else hint.textContent = '圈完后可在下面输入要求，也可以在圈旁手写。点「开始判断」。'
  bar.append(hint)

  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'card-req'
  input.dataset.typedReq = '1'
  input.value = ui.typedText
  input.maxLength = 80
  input.placeholder = '输入要求，例如：缩小、改成红色'
  input.disabled = ui.guessing
  input.setAttribute('aria-label', '输入修改要求')
  input.addEventListener('pointerdown', (e) => e.stopPropagation())
  input.addEventListener('pointerup', (e) => e.stopPropagation())
  input.addEventListener('click', (e) => e.stopPropagation())
  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      if (!ui.guessing) requestIntentGuesses(editor, { more: false })
    }
  })
  input.addEventListener('input', () => {
    ui.typedText = input.value
  })
  bar.append(input)

  const tools = document.createElement('div')
  tools.className = 'card-row'
  const layoutReadyNow = looksLikeLayout(spans) || inferWebLayoutPairs().length
  if (layoutReadyNow) {
    tools.append(
      btn('移到画出的位置', { primary: true, pointer: true }, () => {
        ui.guessing = false
        pickOption('move-layout', deps, editor)
      }),
    )
  }
  if (!ui.guessing && !ui.judged) {
    tools.append(
      btn('开始判断', { primary: !layoutReadyNow, pointer: true }, () => {
        requestIntentGuesses(editor, { more: false })
      }),
    )
  }
  if (!ui.guessing && ui.judged) {
    tools.append(
      btn('重新判断', { pointer: true }, () => {
        requestIntentGuesses(editor, { more: false })
      }),
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
      btn('帮我写一句', {}, () => {
        deps.toast('正在结合周围页面写一句…')
        writeInsertCopy(ui.typedText || ui.productName || '写一句简短合适的网页文案')
          .then((text) => {
            if (!text) throw new Error('没有生成文案')
            ui.productName = text
            replaceCommandText(text)
            emit()
            deps.toast(`已写好：${text}`)
          })
          .catch((err) => {
            const gated = err?.code === 'client-gate' || err?.code === 'no_client_gate' || err?.code === 'calls_disabled'
            deps.toast(gated ? '服务器禁止调用：把 .env 里 MARKSET_ALLOW_MODEL_CALLS 改为 1 并重启' : err?.message || '没能生成文字')
          })
      }),
    )
    bar.append(
      btn('插入文字', { primary: true }, () => {
        const text = String(ui.productName || '').trim()
        if (!text) {
          deps.toast('先写下要插入的文字')
          return
        }
        finishInsertedText(editor, deps, insertWebText(text))
      }),
      btn('上一步', {}, goBack),
    )
    return
  }

  if (ui.intent === 'generate-text') {
    const input = document.createElement('input')
    input.type = 'text'
    input.value = ui.productName || ui.typedText
    input.placeholder = '例如：一句欢迎语、简短标语'
    input.addEventListener('pointerdown', (e) => e.stopPropagation())
    input.addEventListener('input', () => {
      ui.productName = input.value
      ui.moreText = input.value
      replaceCommandText(input.value)
    })
    bar.append(input)
    bar.append(
      btn('生成并插入', { primary: true }, () => {
        commitGenerateText(editor, deps, ui.productName || ui.typedText || ui.moreText)
      }),
      btn('改为自己写', {}, () => {
        ui.intent = 'insert-text'
        emit()
      }),
      btn('上一步', {}, goBack),
    )
    return
  }

  if (ui.intent === 'insert-image') {
    bar.append(
      btn('选一张图插入', { primary: true }, () => deps.insertImage(editor)),
      btn('改为生成一张图', {}, () => {
        ui.intent = 'generate-image'
        emit()
      }),
      btn('上一步', {}, goBack),
    )
    return
  }

  if (ui.intent === 'shadow') {
    const n = countSimilarShadowHosts()
    const note = document.createElement('p')
    note.className = 'card-note'
    note.textContent = n
      ? `已给这一处加上阴影。检测到 ${n} 个同类模块（同样大小/结构的卡片或图片）。`
      : '已给这一处加上阴影。没有找到可套用的同类模块。'
    bar.append(note)
    if (n) {
      bar.append(
        btn('同类模块也加上', { primary: true }, () => {
          const result = applySimilarWebShadows()
          deps.toast(result.ok ? result.message : result.reason || '没有套到同类模块')
          startReview()
          emit()
        }),
      )
    }
    bar.append(
      btn('只改这一处', {}, () => {
        startReview()
        emit()
      }),
      btn('上一步', {}, goBack),
    )
    return
  }

  if (ui.intent === 'generate-image') {
    const note = document.createElement('p')
    note.className = 'card-note'
    note.textContent = '圈的是空白就插入新图；圈中已有图片则换上。'
    bar.append(note)
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'card-req'
    input.value = ui.moreText || ui.typedText
    input.placeholder = '例如：星空下的图书馆、更可爱的logo'
    input.addEventListener('pointerdown', (e) => e.stopPropagation())
    input.addEventListener('keydown', (e) => e.stopPropagation())
    input.addEventListener('input', () => {
      ui.moreText = input.value
      ui.typedText = input.value
    })
    bar.append(input)
    bar.append(
      btn('生成并换上', { primary: true }, () => {
        ui.moreText = input.value
        ui.typedText = input.value
        runGenerateImage(editor, deps)
      }),
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
        if (ui.schemeModules.length) {
          ui.schemeAssign = assignSchemeToModules(sch, ui.schemeModules)
          const imgMod = ui.schemeModules.find((m) => m.kind === 'image')
          ui.color = imgMod ? ui.schemeAssign[imgMod.id] : sch.colors[0]
        } else if (!isWebDocActive()) {
          deps.toast('先圈要改的字或图')
          return
        }
        ui.schemeSlot = null
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
  if (spans.length && (ui.step === 'idle' || ui.step === 'review' || ui.hideCard)) {
    ui.hideCard = false
    ui.step = 'propose'
  }
  if (ui.hideCard || ui.step === 'review') return

  if (!spans.length) {
    if (ui.step === 'propose' || ui.guessing) {
      fillPropose(bar, spans, editor, deps)
      return
    }
    if (ui.coachOn && ui.step !== 'idle') {
      const title = document.createElement('div')
      title.className = 'card-title'
      title.textContent = '先画完，再点开始判断'
      bar.append(title)
    }
    return
  }

  if (ui.step === 'values' && ui.intent) {
    fillHints(bar, editor, spans)
    fillValues(bar, editor, deps)
  } else fillPropose(bar, spans, editor, deps)
}
