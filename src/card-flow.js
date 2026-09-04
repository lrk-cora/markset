import { COLORS } from './colors.js'
import { DEMO_CUP, getDemoPage } from './editor.js'
import { collectOutsideEdits } from './scope.js'
import {
  canUndoInsert,
  getSnapshot,
  ping,
  replaceCommandText,
  setScope,
  toggleBackground,
  undoLastInsert,
} from './store.js'
import { setSubtractMode } from './overlay.js'
import { redoChange, restoreChange } from './changes.js'

const COACH_KEY = 'markset-coach-done'

const SKIP_ELSEWHERE = new Set([
  'polish',
  'longer',
  'shorter',
  'delete',
  'anchor',
  'insert-text',
  'insert-image',
])

const NAME_IDEAS = ['海盐杯', '雾青杯', '白瓷杯', '岩灰杯', '青竹杯', '暖岩杯', '雪釉杯']
const LINE_IDEAS = ['出行不易洒', '适合热饮', '杯口厚实，手感好', '附赠杯盖，方便携带']
const ASK_IDEAS = ['语气再正式一点', '写短一些，只留卖点', '突出杯盖和容量', '不要夸张，说得朴素一点']

let ui = {
  step: 'idle',
  intent: null,
  elsewhere: 'inside',
  productName: '',
  color: '',
  moreText: '',
  moreOpen: false,
  nameIdea: 0,
  colorIdea: 0,
  lineIdea: 0,
  askIdea: 0,
  coachOn: !readCoachDone(),
  hintUnderOn: true,
  hintOverOn: true,
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
  ui.step = 'intent'
  ui.intent = null
  ui.elsewhere = 'inside'
  ui.productName = ''
  ui.color = ''
  ui.moreText = ''
  ui.moreOpen = false
  ui.hintUnderOn = true
  ui.hintOverOn = true
}

export function keepCardForAppend() {
  if (ui.step === 'idle' || ui.step === 'review') {
    ui.step = 'intent'
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
}

function pickIntent(id, deps, editor) {
  if (id === 'background') {
    const mode = toggleBackground()
    if (!mode) deps.toast('先圈杯子或图上的一块，再改背景')
    else if (mode === 'background') deps.toast('已改为背景：整图减去刚才圈的物体')
    else deps.toast('已改回物体')
    return
  }
  ui.intent = id
  if (SKIP_ELSEWHERE.has(id)) ui.step = 'values'
  else ui.step = 'elsewhere'
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
  if (texts.length && !images.length) {
    return '还要改杯子的话，按住 Shift 再圈杯子。'
  }
  if (images.length && !texts.length) {
    return '还要改名字的话，按住 Shift 再点标题里的品名。'
  }
  return ''
}

function intentButtons(spans) {
  const { texts, images, slots } = selectionKinds(spans)
  if (slots.length && !texts.length && !images.length) {
    return [
      ['insert-text', '插入文字'],
      ['insert-image', '插入图片'],
    ]
  }
  const bits = []
  if (texts.length) {
    bits.push(['name', '改名字'], ['color', '改颜色'], ['polish', '润色这段'], ['longer', '写长一点'], ['shorter', '写短一点'])
  }
  if (images.length) {
    if (!texts.length) bits.push(['color', '改颜色'])
    bits.push(['background', '改背景'])
  }
  if (texts.length && images.length) bits.push(['delete', '删掉圈里的'])
  else if (images.length) bits.push(['delete', '删掉这块'])
  else bits.push(['delete', '删掉这些字'])
  bits.push(['anchor', '照着这里改别处'])
  const seen = new Set()
  return bits.filter(([id]) => {
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

function needsName(intent) {
  return intent === 'name' || intent === 'name-color' || intent === 'insert-text'
}

function needsColor(intent) {
  return intent === 'color' || intent === 'name-color'
}

function commitLabel(editor) {
  const { images } = selectionKinds()
  const bits = []
  if (images.length && (ui.intent === 'color' || ui.intent === 'name-color' || ui.intent === 'delete')) {
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
  else if (ui.intent === 'custom') replaceCommandText(ui.moreText.trim())
  else if (ui.intent === 'anchor') replaceCommandText('')
  else {
    const parts = []
    if (needsName(ui.intent) && ui.productName.trim()) parts.push(ui.productName.trim())
    if (needsColor(ui.intent) && ui.color) parts.push(ui.color)
    replaceCommandText(parts.join('，'))
  }
}

function nextIdea(list, key) {
  const i = ui[key] % list.length
  ui[key] += 1
  return list[i]
}

function goBack() {
  if (ui.step === 'values' && SKIP_ELSEWHERE.has(ui.intent)) {
    ui.step = 'intent'
    ui.intent = null
  } else if (ui.step === 'values') ui.step = 'elsewhere'
  else if (ui.step === 'elsewhere') {
    ui.step = 'intent'
    ui.intent = null
  }
  emit()
}

function heading(step, intent) {
  if (step === 'intent') return '这次要做什么'
  if (step === 'elsewhere') return '还改别处吗'
  if (step === 'review') return '已改这些地方'
  if (intent === 'name') return '改成什么名字'
  if (intent === 'color') return '改成什么颜色'
  if (intent === 'name-color') return '新品名和颜色'
  if (intent === 'insert-text') return '要插入的文字'
  if (intent === 'polish') return '润色这段'
  if (intent === 'longer') return '写长一点'
  if (intent === 'shorter') return '写短一点'
  if (intent === 'custom') return '其他要求'
  if (intent === 'anchor') return '照着这里改别处'
  return '补一下新值'
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
  caption.textContent = '像这样围一圈，圈住要改的字或杯子。不用画方框。字也可以直接点。'
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

function fillIntent(bar, spans, editor, deps) {
  const title = document.createElement('div')
  title.className = 'card-title'
  title.textContent = heading('intent')
  bar.append(title)
  const row = document.createElement('div')
  row.className = 'card-row'
  for (const [id, label] of intentButtons(spans)) {
    row.append(btn(label, { on: ui.intent === id }, () => pickIntent(id, deps, editor)))
  }
  bar.append(row)
}

function fillElsewhere(bar) {
  const title = document.createElement('div')
  title.className = 'card-title'
  title.textContent = heading('elsewhere')
  bar.append(title)
  const row = document.createElement('div')
  row.className = 'card-row'
  row.append(
    btn('只改圈里的', { on: ui.elsewhere === 'inside' }, () => {
      ui.elsewhere = 'inside'
      ui.step = 'values'
      emit()
    }),
    btn('页上同一个名字、杯子上印的字也改', { on: ui.elsewhere === 'follow' }, () => {
      ui.elsewhere = 'follow'
      ui.step = 'values'
      emit()
    }),
  )
  bar.append(row, btn('上一步', {}, goBack))
}

function fillValues(bar, editor, deps) {
  const title = document.createElement('div')
  title.className = 'card-title'
  title.textContent = heading('values', ui.intent)
  bar.append(title)

  if (ui.intent === 'delete') {
    const note = document.createElement('p')
    note.className = 'card-note'
    note.textContent = '会删掉圈里的字；若圈了图，那一块也会抹掉。'
    bar.append(note)
    bar.append(
      btn('确认删除', { primary: true }, () => {
        setScope('inside')
        replaceCommandText('')
        deps.runCommand('delete', editor)
      }),
      btn('上一步', {}, goBack),
    )
    return
  }

  if (ui.intent === 'anchor') {
    const note = document.createElement('p')
    note.className = 'card-note'
    note.textContent = '圈里当作已经对的例子，不再重画。只改别处对不上的品名、色词或印字。'
    bar.append(note)
    bar.append(
      btn(commitLabel(editor), { primary: true }, () => {
        setScope('anchor')
        replaceCommandText('')
        deps.runCommand('unify', editor)
      }),
      btn('上一步', {}, goBack),
    )
    return
  }

  if (ui.intent === 'polish' || ui.intent === 'longer' || ui.intent === 'shorter') {
    const note = document.createElement('p')
    note.className = 'card-note'
    note.textContent =
      ui.intent === 'longer'
        ? '只改圈里这句，把它写长一点。'
        : ui.intent === 'shorter'
          ? '只改圈里这句，把它写短一点。'
          : '只改圈里这句。'
    bar.append(note)
    bar.append(
      btn('改这些', { primary: true }, () => {
        setScope('inside')
        applyCommandText()
        deps.runCommand('rewrite', editor)
      }),
      btn('上一步', {}, goBack),
    )
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
    bar.append(
      btn('改这些', { primary: true }, () => {
        if (!ui.moreText.trim()) {
          deps.toast('先写下想改成什么样')
          return
        }
        setScope(ui.elsewhere === 'follow' ? 'follow' : 'inside')
        applyCommandText()
        deps.runCommand('rewrite', editor)
      }),
      btn('上一步', {}, goBack),
    )
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

  bar.append(
    btn(commitLabel(editor), { primary: true }, () => {
      if (needsName(ui.intent) && !ui.productName.trim() && !ui.color) {
        deps.toast('先写下新名字，或选一个颜色')
        return
      }
      if (needsColor(ui.intent) && !ui.color && ui.intent === 'color') {
        deps.toast('先在色板里选一个颜色')
        return
      }
      setScope(ui.elsewhere === 'follow' ? 'follow' : 'inside')
      applyCommandText()
      deps.runCommand('unify', editor)
    }),
    btn('上一步', {}, goBack),
  )
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
  if (canUndoInsert()) {
    bar.append(
      btn('撤回全部', {}, () => {
        if (undoLastInsert(editor)) {
          idleCard()
          deps.toast('已撤回整次修改')
        }
      }),
    )
  }
}

function fillMore(bar, deps) {
  const toggle = btn(ui.moreOpen ? '收起' : '更多', { on: ui.moreOpen }, () => {
    ui.moreOpen = !ui.moreOpen
    emit()
  })
  bar.append(toggle)
  if (!ui.moreOpen) return

  const input = document.createElement('input')
  input.type = 'text'
  input.value = ui.moreText
  input.placeholder = '输入其他要求'
  input.addEventListener('pointerdown', (e) => e.stopPropagation())
  input.addEventListener('input', () => {
    ui.moreText = input.value
  })
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const t = ui.moreText.trim()
    if (!t) {
      deps.toast('先写一句想改成什么样')
      return
    }
    ui.intent = 'custom'
    ui.step = 'elsewhere'
    ui.moreOpen = false
    replaceCommandText(t)
    emit()
  })
  bar.append(input)
}

export function fillNoviceCard(bar, editor, deps) {
  const snap = getSnapshot()
  const spans = snap.spans
  const showReview = ui.step === 'review' || (!spans.length && snap.changes.length)
  if (showReview && ui.step !== 'review') ui.step = 'review'

  if (!spans.length && !showReview) {
    if (ui.coachOn) {
      const title = document.createElement('div')
      title.className = 'card-title'
      title.textContent = '先围一圈'
      bar.append(title)
    }
    return
  }

  if (showReview) {
    fillReview(bar, editor, deps)
    return
  }

  fillHints(bar, editor, spans)
  if (ui.step === 'intent' || !ui.intent) {
    fillIntent(bar, spans, editor, deps)
    fillMore(bar, deps)
  } else if (ui.step === 'elsewhere') fillElsewhere(bar)
  else fillValues(bar, editor, deps)
}
