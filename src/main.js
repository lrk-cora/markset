import './styles.css'
import { createEditor, refreshDecorations } from './editor.js'
import { bindChromeKeys, renderChrome, toast } from './chrome.js'
import { hitImageAt, hitImages, hitText, hitWordAt } from './hit-test.js'
import { bindLasso } from './overlay.js'
import {
  appendSpans,
  coversTextPos,
  replaceSpans,
  setSuggest,
  subscribe,
} from './store.js'

const editor = createEditor(document.getElementById('editor'))

subscribe(() => {
  refreshDecorations(editor)
  renderChrome(editor)
})

bindChromeKeys()
renderChrome(editor)

let ignoreClickUntil = 0

function applyHits(textSpans, imageHits, { append }) {
  const next = [...textSpans, ...imageHits.found]
  if (!next.length) {
    if (imageHits.suggest[0]) setSuggest(imageHits.suggest[0])
    else toast('这一圈没有碰到字或图')
    return
  }
  if (append) appendSpans(next)
  else replaceSpans(next)
  if (imageHits.suggest[0]) setSuggest(imageHits.suggest[0])
}

bindLasso({
  onBegin() {
    ignoreClickUntil = Number.POSITIVE_INFINITY
  },
  onFinish(polygon, { shift }) {
    ignoreClickUntil = performance.now() + 400
    const textSpans = hitText(editor.view, polygon, { skipCovered: shift })
    const imageHits = hitImages(editor.view, polygon)
    applyHits(textSpans, imageHits, { append: shift })
  },
  onCancel() {
    ignoreClickUntil = performance.now() + 200
  },
})

window.addEventListener(
  'click',
  (e) => {
    if (e.altKey || performance.now() < ignoreClickUntil) {
      e.preventDefault()
      return
    }
    const target = e.target instanceof Element ? e.target : e.target.parentElement
    if (target?.closest('.chrome-layer, .inspector, .topbar, .suggest')) return

    const image = hitImageAt(editor.view, e.clientX, e.clientY)
    if (image) {
      e.preventDefault()
      appendSpans([image])
      return
    }

    const word = hitWordAt(editor.view, e.clientX, e.clientY)
    if (word) {
      e.preventDefault()
      if (coversTextPos(word.from)) return
      appendSpans([word])
    }
  },
  true,
)

window.addEventListener('resize', () => renderChrome(editor))
