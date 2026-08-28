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

const DocImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: 360,
        parseHTML: (el) => Number(el.getAttribute('width')) || 360,
        renderHTML: (attrs) => ({ width: attrs.width }),
      },
      height: {
        default: 360,
        parseHTML: (el) => Number(el.getAttribute('height')) || 360,
        renderHTML: (attrs) => ({ height: attrs.height }),
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
              decos.push(Decoration.inline(span.from, span.to, { class: 'mark-text-hl' }))
            }
            return DecorationSet.create(pmState.doc, decos)
          },
        },
      }),
    ]
  },
})

export function createEditor(element) {
  const cupSrc = `${import.meta.env.BASE_URL}cup.svg`

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
          content: [{ type: 'text', text: '海盐杯' }],
        },
        {
          type: 'paragraph',
          attrs: { blockId: 'p-1' },
          content: [
            {
              type: 'text',
              text: '手工吹制玻璃，雾蓝釉面。容量 280ml，杯口薄、杯身微锥，适合冷萃与日常饮水。',
            },
          ],
        },
        {
          type: 'image',
          attrs: {
            src: cupSrc,
            alt: '雾蓝海盐杯',
            blockId: 'img-1',
            width: 360,
            height: 360,
          },
        },
        {
          type: 'paragraph',
          attrs: { blockId: 'p-2' },
          content: [
            {
              type: 'text',
              text: '卖点：防滑杯底、可叠放、雾蓝色号与包装一致。今日把说明和照片里的杯子一起改成海盐杯、雾蓝。',
            },
          ],
        },
      ],
    },
  })
}

export function refreshDecorations(editor) {
  editor.view.dispatch(editor.view.state.tr.setMeta('markset', true))
}
