import { Editor, Extension, Mark } from '@tiptap/core'
import Image from '@tiptap/extension-image'
import StarterKit from '@tiptap/starter-kit'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { schemeTextFill } from './colors.js'
import { getSnapshot } from './store.js'

const BlockId = Extension.create({
  name: 'blockId',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading', 'image'],
        attributes: {
          blockId: {
            default: null,
            parseHTML: (el) => el.getAttribute('data-block-id'),
            renderHTML: (attrs) => (attrs.blockId ? { 'data-block-id': attrs.blockId } : {}),
          },
        },
      },
      {
        types: ['paragraph', 'heading'],
        attributes: {
          inkColor: {
            default: null,
            parseHTML: (el) => el.getAttribute('data-ink-color'),
            renderHTML: (attrs) => {
              if (!attrs.inkColor) return {}
              const fill = schemeTextFill(attrs.inkColor)
              return {
                'data-ink-color': attrs.inkColor,
                style: `--ink-tint:${fill};color:${fill}`,
              }
            },
          },
        },
      },
    ]
  },
})

function parsePlaced(el) {
  if (el.hasAttribute('data-shift-dx')) {
    return {
      mode: 'shift',
      dx: Number(el.getAttribute('data-shift-dx') || 0),
      dy: Number(el.getAttribute('data-shift-dy') || 0),
      sx: Number(el.getAttribute('data-shift-sx') || 1),
      sy: Number(el.getAttribute('data-shift-sy') || 1),
      x: Number(el.getAttribute('data-placed-x') || 0),
      y: Number(el.getAttribute('data-placed-y') || 0),
      w: Number(el.getAttribute('data-placed-w') || 0),
      h: Number(el.getAttribute('data-placed-h') || 0),
    }
  }
  if (!el.hasAttribute('data-placed-x')) return null
  return {
    x: Number(el.getAttribute('data-placed-x')),
    y: Number(el.getAttribute('data-placed-y')),
    w: Number(el.getAttribute('data-placed-w')),
    h: Number(el.getAttribute('data-placed-h') || 0),
  }
}

function shiftStyle(placed) {
  const dx = placed.dx || 0
  const dy = placed.dy || 0
  const sx = placed.sx ?? 1
  const sy = placed.sy ?? 1
  return `transform:translate(${dx}px,${dy}px) scale(${sx},${sy});transform-origin:top left;`
}

function renderPlaced(placed, { text = false } = {}) {
  if (!placed) return {}
  if (placed.mode === 'shift') {
    return {
      class: 'is-shifted',
      'data-shift-dx': String(placed.dx || 0),
      'data-shift-dy': String(placed.dy || 0),
      'data-shift-sx': String(placed.sx ?? 1),
      'data-shift-sy': String(placed.sy ?? 1),
      'data-placed-x': String(placed.x || 0),
      'data-placed-y': String(placed.y || 0),
      'data-placed-w': String(placed.w || 0),
      'data-placed-h': String(placed.h || 0),
      style: shiftStyle(placed),
    }
  }
  const { x, y, w, h } = placed
  return {
    class: 'is-placed',
    'data-placed-x': String(x),
    'data-placed-y': String(y),
    'data-placed-w': String(w),
    'data-placed-h': String(h || 0),
    style: text
      ? `left:${x}px;top:${y}px;width:${w}px;${h ? `min-height:${h}px;` : ''}`
      : undefined,
  }
}

const Placed = Extension.create({
  name: 'placed',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading'],
        attributes: {
          placed: {
            default: null,
            parseHTML: (el) => parsePlaced(el),
            renderHTML: (attrs) => renderPlaced(attrs.placed, { text: true }),
          },
        },
      },
    ]
  },
})

const DocImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: 360,
        parseHTML: (el) => Number(el.getAttribute('width')) || 360,
        renderHTML: (attrs) => {
          const parts = [`width:${attrs.width}px`, `height:${attrs.height || attrs.width}px`]
          if (attrs.placed?.mode === 'shift') {
            parts.push(shiftStyle(attrs.placed).replace(/;$/, ''))
            return {
              width: attrs.width,
              class: 'is-shifted',
              style: parts.join(';'),
            }
          }
          if (attrs.placed) {
            parts.push(
              'position:absolute',
              `left:${attrs.placed.x}px`,
              `top:${attrs.placed.y}px`,
            )
          }
          return {
            width: attrs.width,
            class: attrs.placed ? 'is-placed' : undefined,
            style: parts.join(';'),
          }
        },
      },
      height: {
        default: 360,
        parseHTML: (el) => Number(el.getAttribute('height')) || 360,
        renderHTML: (attrs) => ({ height: attrs.height }),
      },
      placed: {
        default: null,
        parseHTML: (el) => {
          return parsePlaced(el)
        },
        renderHTML: (attrs) => {
          const html = renderPlaced(attrs.placed)
          if (attrs.placed?.mode === 'shift' && html?.style) {
            const { style: _style, ...rest } = html
            return rest
          }
          return html
        },
      },
    }
  },
}).configure({
  inline: false,
  allowBase64: true,
  HTMLAttributes: {
    draggable: false,
  },
})

export const TextAnno = Mark.create({
  name: 'textAnno',
  addAttributes() {
    return {
      kind: { default: 'underline' },
    }
  },
  parseHTML() {
    return [{ tag: 'span[data-text-anno]' }]
  },
  renderHTML({ HTMLAttributes }) {
    const kind = HTMLAttributes.kind || 'underline'
    return ['span', { 'data-text-anno': kind, class: `text-anno is-${kind}` }, 0]
  },
})

export const TextTint = Mark.create({
  name: 'textTint',
  addAttributes() {
    return {
      color: { default: '' },
      fill: { default: '' },
    }
  },
  parseHTML() {
    return [
      {
        tag: 'span[data-text-tint]',
        getAttrs: (el) => ({
          color: el.getAttribute('data-text-tint') || '',
          fill: el.style?.color || '',
        }),
      },
    ]
  },
  renderHTML({ HTMLAttributes }) {
    const { color, fill, ...rest } = HTMLAttributes
    return ['span', { ...rest, 'data-text-tint': color || '', style: fill ? `color:${fill}` : undefined }, 0]
  },
})

const SelectionHighlight = Extension.create({
  name: 'selectionHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('marksetHighlight'),
        props: {
          decorations(pmState) {
            const decos = []
            const snap = getSnapshot()
            for (const span of snap.spans) {
              if (span.kind !== 'text' || span.from == null || span.to == null) continue
              if (span.from >= span.to) continue
              if (span.to > pmState.doc.content.size) continue
              decos.push(
                Decoration.inline(span.from, span.to, {
                  class: span.willEdit === false ? 'mark-text-hl is-off' : 'mark-text-hl',
                }),
              )
            }
            for (const item of snap.changes || []) {
              if (item.kind !== 'text' || item.from == null || item.to == null) continue
              if (item.from >= item.to || item.to > pmState.doc.content.size) continue
              const cls = [
                'mark-change',
                item.keep === false ? 'is-restored' : '',
                item.status === 'fail' ? 'is-fail' : '',
                snap.changeActive === item.id ? 'is-active' : '',
              ]
                .filter(Boolean)
                .join(' ')
              decos.push(Decoration.inline(item.from, item.to, { class: cls }))
            }
            return DecorationSet.create(pmState.doc, decos)
          },
        },
      }),
    ]
  },
})

export const DEMO_CUP = {
  a: {
    file: 'cup-a.png',
    cup: { xRel: 0.05, yRel: 0.16, wRel: 0.52, hRel: 0.70 },
    pack: { xRel: 0.46, yRel: 0.18, wRel: 0.52, hRel: 0.62 },
    print: { xRel: 0.12, yRel: 0.38, wRel: 0.36, hRel: 0.24 },
  },
  b: {
    file: 'cup-b.png',
    cup: { xRel: 0.05, yRel: 0.14, wRel: 0.52, hRel: 0.72 },
    pack: { xRel: 0.46, yRel: 0.16, wRel: 0.52, hRel: 0.64 },
    print: { xRel: 0.10, yRel: 0.40, wRel: 0.38, hRel: 0.22 },
  },
}

let currentDemoPage = 'a'
let importedMeta = null

export function getDemoPage() {
  return currentDemoPage
}

export function getImportedMeta() {
  return importedMeta
}

export function isDemoPage() {
  return currentDemoPage === 'a' || currentDemoPage === 'b'
}

function cupSrc(pageId = 'a') {
  const file = DEMO_CUP[pageId]?.file || DEMO_CUP.a.file
  return `${import.meta.env.BASE_URL}${file}?v=b-blank-3`
}

function para(blockId, text) {
  return {
    type: 'paragraph',
    attrs: { blockId },
    content: [{ type: 'text', text }],
  }
}

export function demoDoc(pageId = 'a') {
  const src = cupSrc(pageId)
  const heading = {
    type: 'heading',
    attrs: { level: 1, blockId: 'h-1' },
    content: [{ type: 'text', text: '原木杯' }],
  }
  const image = {
    type: 'image',
    attrs: {
      src,
      alt: pageId === 'b' ? '雾蓝杯身，无印字（演示，照着杯子改说明时不要重画杯子）' : '原木杯，釉上印着品名，带杯盖，置于木桌边',
      blockId: 'img-1',
      width: 360,
      height: 360,
    },
  }
  const price = para('p-price', '¥59')
  const ship = para('p-ship', '48小时内发货，偏远地区顺延。')

  if (pageId === 'b') {
    return {
      type: 'doc',
      content: [
        heading,
        para(
          'p-1',
          '红色原木杯，暖茶釉面，容量 280ml，杯口厚实。附赠杯盖，出行不易洒。',
        ),
        para('p-spec', '规格：原木杯 / 红色'),
        image,
        para('p-note', '演示设定：杯身已经是雾蓝。照着杯子改说明时不要重画杯子。'),
        price,
        ship,
      ],
    }
  }

  return {
    type: 'doc',
    content: [
      heading,
      para(
        'p-1',
        '这款原木杯为暖茶色哑光釉，容量 280ml，杯口厚实，适合热饮。附赠杯盖，出行不易洒。杯底防滑。',
      ),
      para('p-spec', '规格：原木杯 / 暖茶 / 280ml'),
      image,
      price,
      ship,
    ],
  }
}

export const DEMO_KICKER = {
  a: '演示页 A · 文案三处「原木杯」，杯面釉上印字',
  b: '演示页 B · 杯身已是雾蓝、无印字；说明仍写红色 / 原木。圈杯子可把说明改成和杯子一致',
}

export function applyDemoPage(editor, pageId = 'a') {
  currentDemoPage = pageId === 'b' ? 'b' : 'a'
  importedMeta = null
  document.querySelector('.page')?.classList.remove('is-import', 'is-web-doc')
  const host = document.getElementById('web-doc-host')
  if (host) host.hidden = true
  editor.commands.setContent(demoDoc(currentDemoPage))
  const kicker = document.getElementById('page-kicker')
  if (kicker) {
    kicker.hidden = true
    kicker.textContent = ''
  }
}

function textNode(text) {
  const t = String(text || '').trim()
  return t ? [{ type: 'text', text: t }] : []
}

export function importedDoc(page) {
  const content = []
  let heads = 0
  let paras = 0
  let imgs = 0
  let usedPrice = false
  let usedShip = false
  for (const block of page?.blocks || []) {
    if (block.type === 'heading') {
      const text = textNode(block.text)
      if (!text.length) continue
      heads += 1
      content.push({
        type: 'heading',
        attrs: { level: 1, blockId: heads === 1 ? 'h-1' : `h-${heads}` },
        content: text,
      })
      continue
    }
    if (block.type === 'image' && block.src) {
      imgs += 1
      content.push({
        type: 'image',
        attrs: {
          src: block.src,
          alt: block.alt || page.title || '导入的图',
          blockId: imgs === 1 ? 'img-1' : `img-${imgs}`,
          width: block.width || 360,
          height: block.height || 280,
        },
      })
      continue
    }
    const text = textNode(block.text)
    if (!text.length) continue
    paras += 1
    const raw = String(block.text || '')
    let id = `p-${paras}`
    if (!usedPrice && /¥\s*\d+|售价/.test(raw)) {
      id = 'p-price'
      usedPrice = true
    } else if (!usedShip && /发货|物流|顺延/.test(raw)) {
      id = 'p-ship'
      usedShip = true
    }
    content.push({
      type: 'paragraph',
      attrs: { blockId: id },
      content: text,
    })
  }
  if (!content.length) {
    content.push({
      type: 'paragraph',
      attrs: { blockId: 'p-1' },
      content: [{ type: 'text', text: '这个网页没有读出可用内容。' }],
    })
  }
  return { type: 'doc', content }
}

export async function applyImportedPage(editor, page) {
  const { blocksToHtml, mountWebDoc, screenshotToHtml, unmountWebDoc } = await import('./web-doc.js')
  currentDemoPage = 'import'
  importedMeta = {
    title: page?.title || '',
    sourceUrl: page?.sourceUrl || '',
    siteName: page?.siteName || '',
  }
  const host = (() => {
    try {
      return page?.sourceUrl ? new URL(page.sourceUrl).hostname : ''
    } catch {
      return ''
    }
  })()
  const kicker = document.getElementById('page-kicker')
  if (kicker) {
    kicker.hidden = true
    kicker.textContent = ''
  }

  const html =
    String(page?.snapshotHtml || '').trim() ||
    (page?.blocks?.length ? blocksToHtml(page) : '') ||
    (page?.screenshotDataUrl ? screenshotToHtml(page.screenshotDataUrl, page.title) : '')
  editor.commands.setContent({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        attrs: { blockId: 'p-import' },
        content: [{ type: 'text', text: page?.title || '导入的网页' }],
      },
    ],
  })
  if (html && mountWebDoc(html, importedMeta)) {
    return page?.snapshotHtml ? 'html' : page?.screenshotDataUrl && !page?.blocks?.length ? 'snapshot' : 'html'
  }
  unmountWebDoc()
  editor.commands.setContent(importedDoc(page))
  return 'blocks'
}

export function createEditor(element) {
  return new Editor({
    element,
    editable: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1] },
        codeBlock: false,
        blockquote: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        code: false,
        horizontalRule: false,
      }),
      DocImage,
      BlockId,
      Placed,
      TextAnno,
      TextTint,
      SelectionHighlight,
    ],
    editorProps: {
      attributes: {
        spellcheck: 'false',
      },
      handleClick() {
        return true
      },
    },
    content: demoDoc('a'),
  })
}

export function refreshDecorations(editor) {
  editor.view.dispatch(editor.view.state.tr.setMeta('markset', true))
}

export function newBlockId(prefix) {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
}

export function posBeforeBlockAtY(view, clientY) {
  const { doc } = view.state
  let insertPos = doc.content.size
  doc.forEach((_node, offset) => {
    try {
      const coords = view.coordsAtPos(Math.min(offset + 1, doc.content.size))
      if (coords.top >= clientY) insertPos = Math.min(insertPos, offset)
    } catch {
      /* ignore */
    }
  })
  return insertPos
}

export function pageRelativeRect(screenRect) {
  const frame = document.getElementById('web-doc-frame')
  const host = document.querySelector('.page.is-web-doc') && frame
    ? frame
    : document.querySelector('#editor .ProseMirror') || document.querySelector('.page')
  if (!host || !screenRect) return null
  const box = host.getBoundingClientRect()
  const style = getComputedStyle(host)
  const borderLeft = parseFloat(style.borderLeftWidth) || 0
  const borderTop = parseFloat(style.borderTopWidth) || 0
  return {
    x: Math.round(screenRect.x - box.left - borderLeft),
    y: Math.round(screenRect.y - box.top - borderTop),
    w: Math.round(Math.max(48, screenRect.w)),
    h: Math.round(Math.max(24, screenRect.h)),
  }
}

export function insertParagraphAt(editor, pos, text, blockId, placed) {
  const { schema } = editor
  const content = text ? [schema.text(text)] : []
  const insertPos = placed ? editor.view.state.doc.content.size : pos
  const node = schema.nodes.paragraph.create({ blockId, placed: placed || null }, content)
  const tr = editor.view.state.tr.insert(insertPos, node)
  const mapping = tr.mapping
  editor.view.dispatch(tr)
  const from = insertPos + 1
  const to = from + text.length
  return {
    mapping,
    span: {
      kind: 'text',
      block_id: blockId,
      start: 0,
      end: text.length,
      text,
      from,
      to,
    },
  }
}

export function insertImageAt(editor, pos, attrs) {
  const insertPos = attrs.placed ? editor.view.state.doc.content.size : pos
  const node = editor.schema.nodes.image.create(attrs)
  const tr = editor.view.state.tr.insert(insertPos, node)
  const mapping = tr.mapping
  editor.view.dispatch(tr)
  return { mapping, blockId: attrs.blockId }
}

export function replaceRangeText(editor, from, to, text) {
  const tr = editor.view.state.tr.insertText(text, from, to)
  const mapping = tr.mapping
  editor.view.dispatch(tr)
  return mapping
}

export function setImageSrcByBlockId(editor, blockId, src) {
  const { doc } = editor.view.state
  let pos = null
  doc.descendants((node, p) => {
    if (node.type.name === 'image' && node.attrs.blockId === blockId) {
      pos = p
      return false
    }
  })
  if (pos == null) return false
  const node = editor.view.state.doc.nodeAt(pos)
  editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, null, { ...node.attrs, src }))
  return true
}
