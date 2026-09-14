const MAX_H = 14000

function waitImages(doc) {
  const imgs = [...(doc.images || [])]
  return Promise.all(
    imgs.map(
      (img) =>
        img.complete
          ? Promise.resolve()
          : new Promise((resolve) => {
              img.addEventListener('load', resolve, { once: true })
              img.addEventListener('error', resolve, { once: true })
            }),
    ),
  )
}

function naturalSize(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ w: img.naturalWidth || img.width, h: img.naturalHeight || img.height })
    img.onerror = () => reject(new Error('截图无法打开'))
    img.src = src
  })
}

export async function rasterizeSnapshot(html, width = 720) {
  const iframe = document.createElement('iframe')
  iframe.setAttribute('sandbox', 'allow-same-origin')
  iframe.setAttribute('tabindex', '-1')
  iframe.style.cssText = [
    'position:fixed',
    'left:-14000px',
    'top:0',
    `width:${width}px`,
    'height:1600px',
    'border:0',
    'opacity:0',
    'pointer-events:none',
    'background:#fff',
  ].join(';')
  document.body.append(iframe)
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('页面渲染超时')), 14000)
      iframe.onload = () => {
        clearTimeout(timer)
        resolve()
      }
      iframe.srcdoc = html
    })
    const doc = iframe.contentDocument
    if (!doc?.documentElement) throw new Error('没有渲染出页面')
    await waitImages(doc)
    await new Promise((resolve) => setTimeout(resolve, 80))
    const height = Math.min(
      MAX_H,
      Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight || 0, 480),
    )
    iframe.style.height = `${height}px`
    doc.documentElement.style.width = `${width}px`
    if (doc.body) {
      doc.body.style.width = `${width}px`
      doc.body.style.margin = '0'
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const { toJpeg } = await import('html-to-image')
    const src = await toJpeg(doc.body || doc.documentElement, {
      quality: 0.86,
      width,
      height,
      canvasWidth: width,
      canvasHeight: height,
      pixelRatio: 1.25,
      backgroundColor: '#ffffff',
      cacheBust: false,
    })
    const dim = await naturalSize(src)
    return { src, width: dim.w, height: dim.h }
  } finally {
    iframe.remove()
  }
}

export async function measureDataUrl(src) {
  return naturalSize(src)
}
