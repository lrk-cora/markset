import { COLOR_SCHEMES, colorFill, paperFill, schemeTextFill, swatchLabel } from './colors.js'
import { DEMO_CUP, getDemoPage, setImageSrcByBlockId } from './editor.js'
import { COLOR_TERMS, FORBIDDEN_BLOCKS } from './forbidden.js'
import { imageSpanFromNaturalBox } from './hit-test.js'
import { localPaintMasked } from './pending.js'
import { collectCupBody } from './print-region.js'
import { getSnapshot } from './store.js'

const DEFAULT_PAPER = '#fffaf2'

export function schemeById(id) {
  return COLOR_SCHEMES.find((s) => s.id === id) || null
}

export function getPagePaper() {
  return document.querySelector('.page')?.style.getPropertyValue('--page') || ''
}

export function setPagePaper(hex) {
  const page = document.querySelector('.page')
  if (!page) return
  if (hex) page.style.setProperty('--page', hex)
  else page.style.removeProperty('--page')
}

export function resetPagePaper() {
  setPagePaper('')
}

function originalCupSrc() {
  const file = DEMO_CUP[getDemoPage()]?.file || DEMO_CUP.a.file
  return `${import.meta.env.BASE_URL}${file}?v=b-blank-3`
}

export function listColorBlocks(editor) {
  const blocks = []
  editor.state.doc.descendants((node, pos) => {
    if (!node.isTextblock || !node.textContent) return true
    const blockId = node.attrs?.blockId
    blocks.push({
      blockId,
      from: pos + 1,
      to: pos + node.nodeSize - 1,
      pos,
      text: node.textContent,
    })
    return true
  })
  return blocks
}

function previewOf(text, fallback) {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  if (!t) return fallback
  return t.length > 10 ? `${t.slice(0, 10)}…` : t
}

function textModuleSelected(block, spans) {
  return spans.some((s) => {
    if (s.kind !== 'text') return false
    if (s.block_id && block.blockId && s.block_id === block.blockId) return true
    if (s.from == null || s.to == null) return false
    return s.from < block.to && s.to > block.from
  })
}

export function collectSchemeModules(editor, { pageWide = false } = {}) {
  const spans = getSnapshot().spans || []
  const modules = []
  for (const block of listColorBlocks(editor)) {
    if (!pageWide && !textModuleSelected(block, spans)) continue
    const isHead = block.blockId === 'h-1'
    modules.push({
      id: `text:${block.blockId || block.from}`,
      kind: 'text',
      blockId: block.blockId,
      from: block.from,
      label: `${isHead ? '标题' : '这段'} · ${previewOf(block.text, '文字')}`,
    })
  }
  const imageOn = pageWide || spans.some((s) => s.kind === 'image')
  if (imageOn) {
    modules.push({
      id: 'image:img-1',
      kind: 'image',
      blockId: 'img-1',
      label: '杯子',
    })
  }
  if (pageWide) {
    modules.push({
      id: 'paper',
      kind: 'paper',
      label: '纸面',
    })
  }
  return modules
}

export function assignSchemeToModules(scheme, modules) {
  const colors = scheme?.colors || []
  const assign = {
    paper: scheme?.paper || paperFill(colors[0] || '米色'),
  }
  let i = 0
  for (const module of modules) {
    if (module.kind === 'paper') {
      assign[module.id] = assign.paper
      continue
    }
    assign[module.id] = colors[i % Math.max(1, colors.length)] || '暖茶'
    i += 1
  }
  return assign
}

export function moduleSwatch(assign, module) {
  if (module.kind === 'paper') {
    const hex = assign.paper || DEFAULT_PAPER
    return { name: '背景', fill: hex }
  }
  const colorId = assign[module.id]
  if (module.kind === 'image') return { name: swatchLabel(colorId) || '杯子', fill: colorFill(colorId) }
  return {
    name: swatchLabel(colorId) || '文字',
    fill: schemeTextFill(colorId),
  }
}

function findBlockPos(editor, blockId) {
  let found = null
  editor.state.doc.descendants((node, pos) => {
    if (found != null) return false
    if (node.attrs?.blockId === blockId) {
      found = pos
      return false
    }
    return true
  })
  return found
}

function setBlockInk(editor, blockId, colorId) {
  if (!blockId || !colorId) return false
  const pos = findBlockPos(editor, blockId)
  if (pos == null) return false
  const node = editor.state.doc.nodeAt(pos)
  if (!node || !node.isTextblock) return false
  const fill = schemeTextFill(colorId)
  const from = pos + 1
  const to = pos + node.nodeSize - 1
  const markType = editor.schema.marks.textTint
  let tr = editor.state.tr.setNodeMarkup(pos, null, {
    ...node.attrs,
    inkColor: colorId,
  })
  if (markType && from < to) {
    tr = tr.removeMark(from, to, markType)
    tr = tr.addMark(from, to, markType.create({ color: colorId, fill }))
  }
  editor.view.dispatch(tr)
  const el = editor.view.dom.querySelector(`[data-block-id="${blockId}"]`)
  if (el) {
    el.style.setProperty('--ink-tint', fill)
    el.style.color = fill
    el.setAttribute('data-ink-color', colorId)
  }
  return true
}

function replaceGlazeWords(editor, glaze, blockIds) {
  if (!glaze || !blockIds?.size) return
  const hits = []
  const terms = [...COLOR_TERMS].sort((a, b) => b.length - a.length)
  editor.state.doc.descendants((node, pos) => {
    if (!node.isTextblock || !node.textContent) return true
    const blockId = node.attrs?.blockId
    if (!blockIds.has(blockId)) return true
    if (FORBIDDEN_BLOCKS.has(blockId)) return true
    const from = pos + 1
    const text = node.textContent
    let i = 0
    while (i < text.length) {
      const hit = terms.find((term) => text.startsWith(term, i))
      if (!hit) {
        i += 1
        continue
      }
      if (hit !== glaze) hits.push({ from: from + i, to: from + i + hit.length, next: glaze })
      i += hit.length
    }
    return true
  })
  for (const hit of hits.sort((a, b) => b.from - a.from)) {
    editor.view.dispatch(editor.state.tr.insertText(hit.next, hit.from, hit.to))
  }
}

async function paintProduct(editor, colorId) {
  if (!colorId) return false
  const demo = DEMO_CUP[getDemoPage()]
  const img = editor.view.dom.querySelector('img[data-block-id="img-1"]')
  if (!img || !demo) return false
  let src = originalCupSrc()
  const regions = [demo.pack, demo.cup].filter(Boolean)
  for (const region of regions) {
    const span = imageSpanFromNaturalBox(img, region, {})
    const mask = span?.maskCanvas || (region === demo.cup ? collectCupBody(editor.view)?.maskCanvas : null)
    if (!mask) continue
    src = await localPaintMasked(src, mask, colorId, 'unify', null, { color: colorId })
  }
  if (src) setImageSrcByBlockId(editor, 'img-1', src)
  return Boolean(src)
}

export async function applyPageScheme(editor, { assign, modules = [], slot = null } = {}) {
  if (!editor || !assign || !modules.length) return false
  const targets = slot ? modules.filter((m) => m.id === slot) : modules
  if (!targets.length) return false

  const paperMod = targets.find((m) => m.kind === 'paper')
  if (paperMod) {
    setPagePaper(assign.paper?.startsWith('#') ? assign.paper : paperFill(assign.paper || assign[paperMod.id] || DEFAULT_PAPER))
  }

  const imageMod = targets.find((m) => m.kind === 'image')
  if (imageMod) await paintProduct(editor, assign[imageMod.id])

  const glazeMod = modules.find((m) => m.kind === 'image')
  const glaze = glazeMod ? assign[glazeMod.id] : null
  const wordIds = new Set(
    targets.filter((m) => m.kind === 'text' && m.blockId).map((m) => m.blockId),
  )
  if (!slot && glaze) {
    wordIds.clear()
    for (const m of modules) if (m.kind === 'text' && m.blockId) wordIds.add(m.blockId)
  }
  if (glaze && wordIds.size && (!slot || slot.startsWith('image:') || slot.startsWith('text:'))) {
    replaceGlazeWords(editor, glaze, wordIds)
  }

  for (const module of targets) {
    if (module.kind === 'text') setBlockInk(editor, module.blockId, assign[module.id])
  }
  return true
}
