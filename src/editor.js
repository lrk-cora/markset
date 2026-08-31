import { Editor, Extension } from '@tiptap/core'
import Image from '@tiptap/extension-image'
import StarterKit from '@tiptap/starter-kit'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
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
    ]
  },
})

const Placed = Extension.create({
  name: 'placed',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph'],
        attributes: {
          placed: {
            default: null,
            parseHTML: (el) => {
              if (!el.hasAttribute('data-placed-x')) return null
              return {
                x: Number(el.getAttribute('data-placed-x')),
                y: Number(el.getAttribute('data-placed-y')),
                w: Number(el.getAttribute('data-placed-w')),
                h: Number(el.getAttribute('data-placed-h') || 0),
              }
            },
            renderHTML: (attrs) => {
              if (!attrs.placed) return {}
              const { x, y, w, h } = attrs.placed
              return {
                class: 'is-placed',
                'data-placed-x': String(x),
                'data-placed-y': String(y),
                'data-placed-w': String(w),
                'data-placed-h': String(h || 0),
                style: `left:${x}px;top:${y}px;width:${w}px;${h ? `min-height:${h}px;` : ''}`,
              }
            },
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
          if (!el.hasAttribute('data-placed-x')) return null
          return {
            x: Number(el.getAttribute('data-placed-x')),
            y: Number(el.getAttribute('data-placed-y')),
            w: Number(el.getAttribute('data-placed-w')),
            h: Number(el.getAttribute('data-placed-h') || 0),
          }
        },
        renderHTML: (attrs) => {
          if (!attrs.placed) return {}
          return {
            class: 'is-placed',
            'data-placed-x': String(attrs.placed.x),
            'data-placed-y': String(attrs.placed.y),
            'data-placed-w': String(attrs.placed.w),
            'data-placed-h': String(attrs.placed.h || 0),
          }
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

const SelectionHighlight = Extension.create({
  name: 'selectionHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('marksetHighlight'),
        props: {
          decorations(pmState) {
            const decos = []
            for (const span of getSnapshot().spans) {
              if (span.kind !== 'text' || span.from == null || span.to == null) continue
              if (span.from >= span.to) continue
              if (span.to > pmState.doc.content.size) continue
              decos.push(
                Decoration.inline(span.from, span.to, {
                  class: span.willEdit === false ? 'mark-text-hl is-off' : 'mark-text-hl',
                }),
              )
            }
            return DecorationSet.create(pmState.doc, decos)
          },
        },
      }),
    ]
  },
})

function cupSrc() {
  return `${import.meta.env.BASE_URL}cup.jpg`
}

function para(blockId, text) {
  return {
    type: 'paragraph',
    attrs: { blockId },
    content: [{ type: 'text', text }],
  }
}

export function demoDoc(pageId = 'a') {
  const src = cupSrc()
  const heading = {
    type: 'heading',
    attrs: { level: 1, blockId: 'h-1' },
    content: [{ type: 'text', text: '原木杯' }],
  }
  const image = {
    type: 'image',
    attrs: {
      src,
      alt: pageId === 'b' ? '杯身已是雾蓝的杯子（演示，锚点时不要重画）' : '原木杯，盒侧面印着 OAK CUP，带杯盖，置于木桌边',
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
        para('p-note', '演示设定：杯身已经是雾蓝。锚点时不要重画杯子。'),
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
      para('p-print', '盒侧印字：OAK CUP'),
      price,
      ship,
    ],
  }
}

export const DEMO_KICKER = {
  a: '演示页 A · 任务 1 / 2 · 标题、正文、规格都有「原木杯」',
  b: '演示页 B · 任务 3 · 杯身已是雾蓝，说明仍写红色 / 原木',
}

export function applyDemoPage(editor, pageId = 'a') {
  editor.commands.setContent(demoDoc(pageId))
  const kicker = document.getElementById('page-kicker')
  if (kicker) kicker.textContent = DEMO_KICKER[pageId] || DEMO_KICKER.a
  document.querySelector('.page')?.classList.toggle('is-page-b', pageId === 'b')
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
  const host =
    document.querySelector('#editor .ProseMirror') || document.querySelector('.page')
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
