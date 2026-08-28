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

export function createEditor(element) {
  const cupSrc = `${import.meta.env.BASE_URL}cup.jpg`

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
    content: {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1, blockId: 'h-1' },
          content: [{ type: 'text', text: '琥珀陶杯' }],
        },
        {
          type: 'paragraph',
          attrs: { blockId: 'p-1' },
          content: [
            {
              type: 'text',
              text: '这款琥珀陶杯为暖茶色哑光釉，容量 280ml，杯口厚实，适合热饮与下午茶。附赠杯盖，出行不易洒。杯底防滑，可与同系列叠放在桌边。',
            },
          ],
        },
        {
          type: 'image',
          attrs: {
            src: cupSrc,
            alt: '暖茶琥珀陶杯，带杯盖，置于木桌边',
            blockId: 'img-1',
            width: 360,
            height: 360,
          },
        },
        {
          type: 'paragraph',
          attrs: { blockId: 'p-2' },
          content: [{ type: 'text', text: '售价 128 元' }],
        },
      ],
    },
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
