import { importPageRequest, maybeSmartArrange } from './import-page.js'

function send(res, status, body) {
  const json = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(json)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('invalid json'))
      }
    })
    req.on('error', reject)
  })
}

function dashBase(env) {
  return (env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(
    /\/$/,
    '',
  )
}

function models(env) {
  return {
    rewriteModel: env.DASHSCOPE_REWRITE_MODEL || 'qwen3.6-flash',
    plannerModel: env.DASHSCOPE_PLANNER_MODEL || 'qwen3-vl-plus',
    inpaintModel: env.DASHSCOPE_INPAINT_MODEL || 'wanx2.1-imageedit',
  }
}

function missing(env) {
  return {
    dashscope: !env.DASHSCOPE_API_KEY,
  }
}

function allowModelCalls(env, req) {
  return env.MARKSET_ALLOW_MODEL_CALLS === '1' && req.headers['x-markset-call'] === '1'
}

function redact(text, env) {
  let out = String(text || 'api error')
  const secret = env.DASHSCOPE_API_KEY
  if (secret && secret.length > 6) out = out.split(secret).join('[redacted]')
  return out
}

function keyHints(env) {
  const dash = env.DASHSCOPE_API_KEY || ''
  return {
    dashscopePrefixOk: dash.startsWith('sk-'),
  }
}

function dashNativeOrigin(env) {
  const raw = dashBase(env)
  if (raw.includes('/compatible-mode')) return raw.replace(/\/compatible-mode\/v1$/, '')
  if (raw.endsWith('/v1')) return raw.slice(0, -3)
  return 'https://dashscope.aliyuncs.com'
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function dashChat(env, { model, messages, temperature = 0.2 }) {
  const res = await fetch(`${dashBase(env)}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.DASHSCOPE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature,
      enable_thinking: false,
      messages,
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error?.message || data.message || `dashscope ${res.status}`)
    err.status = 502
    throw err
  }
  const textOut = data.choices?.[0]?.message?.content?.trim()
  if (!textOut) {
    const err = new Error('dashscope empty')
    err.status = 502
    throw err
  }
  return textOut
}

async function rewrite(env, payload) {
  const { rewriteModel } = models(env)
  const instruction = String(payload.instruction || '').trim()
  const text = String(payload.text || '')
  if (!instruction) {
    const err = new Error('missing instruction')
    err.status = 400
    throw err
  }
  const textOut = await dashChat(env, {
    model: rewriteModel,
    messages: [
      {
        role: 'system',
        content:
          'You rewrite the selected Chinese product-page text. Return only the rewritten text, no quotes or explanation.',
      },
      {
        role: 'user',
        content: `指令：${instruction}\n原文：${text}`,
      },
    ],
  })
  return { text: textOut, model: rewriteModel }
}

function planSystem(task) {
  if (task === 'intent' || task === 'ink') {
    return [
      'Output JSON only: {"guesses":[{"id":"delete","label":"删掉圈中的这块","note":"delete","command":""}],"text":"识别出的手写","note":"delete","guess":"..."}.',
      'First read any handwritten Chinese (text field). Then look at the drawing (lasso, scribble, X, underline, shadow, arrow) and WHERE it sits on the page.',
      'Combine the written words WITH the drawn region. Example: circle an icon and write 删 = delete that icon; scribble beside an image and write 阴影 = add shadow there.',
      'Do NOT guess the site logo unless the stroke actually covers it. If the circle contains only text, edit that text; only an image, edit that image; both, edit both.',
      'If the circle is empty or a freehand sketch away from the logo, do not propose logo edits.',
      'Give 3 or 4 guesses, most likely first. label is a short spoken Chinese sentence.',
      'id is one of: delete, delete-image, delete-text, color, name, polish, custom, frame, circle, shadow, reflect, scale-down, scale-up, indent, move-layout, strike, longer, shorter, highlight, underline.',
      'Do NOT assume a closed loop is a selection. command is a concrete value if any (雾蓝, 海盐杯). If asked for more, do not repeat already offered labels.',
    ].join(' ')
  }
  if (task === 'guess') {
    return 'Output JSON only: {"guess":"..."}. One short Chinese phrase for what the user wants the stroked/blue-boxed region to become (color, print, or object). No quotes or explanation.'
  }
  if (task === 'find-same') {
    return 'Output JSON only: {"boxes":[{"x":0,"y":0,"w":0,"h":0}]}. Natural image pixels. List OTHER instances of the same object class as the currently marked blue boxes. Do not repeat already-marked boxes. Empty array if none.'
  }
  return [
    'Output JSON only: {"ops":[{"id":"C1","scope":"in"|"out"|"untouched","target":"T1","tool":"llm_rewrite"|"image_inpaint"|"none","args":{}}]}.',
    'inside: only in. follow (辐射式): MUST rewrite every circled text AND every 圈外相同品名 listed below, even if those outside hits have no #T number. Do not stop at the lasso. anchor (锚定式): untouched for selected images, out for contradicting color words. Never edit price or shipping.',
    'llm_rewrite args {before,after,block_id,start,end}. image_inpaint args {prompt,print?,bbox?}.',
    'Packaging print (box-side letters such as OAK CUP): image_inpaint with args.print true and args.bbox {x,y,w,h} in natural pixels of the printed letters, not the cup body.',
  ].join(' ')
}

async function plan(env, payload) {
  const { plannerModel } = models(env)
  const task = String(payload.task || 'ops')
  const defaults = {
    guess: '根据选中笔迹猜测用户想把这块改成什么，输出一句简短中文。',
    ink: '读出手写和圈选，判断用户想删、改颜色、改字、加装饰还是挪位置。',
    intent: '看网页截图和手写批注，理解用户意图。',
    'find-same': '找出图中与当前选中物体同类的其他物体，不要重复已圈的框。',
  }
  const instruction = String(payload.instruction || '').trim() || defaults[task] || ''
  const marks = String(payload.marks || '')
  const outsideTexts = String(payload.outsideTexts || '')
  const pageText = String(payload.pageText || '')
  const scope = String(payload.scope || 'inside')
  const kind = String(payload.kind || 'unify')
  const imageUrl = payload.imageDataUrl || payload.image_url
  const extraImages = Array.isArray(payload.imageDataUrls) ? payload.imageDataUrls : []
  if (!instruction) {
    const err = new Error('missing instruction')
    err.status = 400
    throw err
  }
  const handwriting = String(payload.handwriting || '').trim()
  const userContent = [
    {
      type: 'text',
      text: [
        `任务：${task}`,
        `指令：${instruction}`,
        `范围：${scope}`,
        `按钮：${kind}`,
        handwriting ? `本地先认出的手写字：${handwriting}` : '若图中有手写，先读出汉字。',
        `当前圈到的内容：\n${marks || '无'}`,
        outsideTexts ? `圈外相同品名（辐射式必须改，不要只改圈内）：\n${outsideTexts}` : '',
        pageText ? `全文（禁改：价格/物流/专利）：\n${pageText}` : '',
        '把「手写字」和「画在哪一块」合在一起理解。只输出 JSON。',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ]
  const seen = new Set()
  for (const url of [imageUrl, ...extraImages]) {
    if (!url || seen.has(url)) continue
    seen.add(url)
    userContent.push({ type: 'image_url', image_url: { url } })
  }
  const textOut = await dashChat(env, {
    model: plannerModel,
    temperature: 0,
    messages: [
      { role: 'system', content: planSystem(task) },
      { role: 'user', content: userContent },
    ],
  })
  let ops = []
  let boxes = []
  let guess = ''
  let note = ''
  let command = ''
  let intent = ''
  let guesses = []
  try {
    const start = textOut.indexOf('{')
    const end = textOut.lastIndexOf('}')
    if (start >= 0 && end > start) {
      const json = JSON.parse(textOut.slice(start, end + 1))
      if (Array.isArray(json.ops)) ops = json.ops
      if (Array.isArray(json.boxes)) boxes = json.boxes
      if (Array.isArray(json.guesses)) guesses = json.guesses
      if (json.guess) guess = String(json.guess)
      if (json.note) note = String(json.note)
      if (json.command) command = String(json.command)
      if (json.intent) intent = String(json.intent)
      if (json.text && !guess) guess = String(json.text)
    }
  } catch {
    ops = []
  }
  return { text: textOut, ops, boxes, guess, note, command, intent, guesses, model: plannerModel }
}

async function inlineImage(url) {
  if (!url || String(url).startsWith('data:')) return url
  const res = await fetch(url)
  if (!res.ok) {
    const err = new Error('万相结果图下载失败')
    err.status = 502
    throw err
  }
  const buf = Buffer.from(await res.arrayBuffer())
  const mime = res.headers.get('content-type') || 'image/png'
  return `data:${mime};base64,${buf.toString('base64')}`
}

function wanxError(body, fallback) {
  return (
    body?.output?.message ||
    body?.message ||
    body?.output?.code ||
    body?.code ||
    fallback
  )
}

async function wanxInpaint(env, { model, prompt, imageUrl, maskUrl }) {
  const origin = dashNativeOrigin(env)
  const started = await fetch(`${origin}/api/v1/services/aigc/image2image/image-synthesis`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.DASHSCOPE_API_KEY}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify({
      model,
      input: {
        function: 'description_edit_with_mask',
        prompt,
        base_image_url: imageUrl,
        mask_image_url: maskUrl,
      },
      parameters: { n: 1 },
    }),
  })
  const first = await started.json().catch(() => ({}))
  if (!started.ok) {
    const err = new Error(wanxError(first, `万相 ${started.status}`))
    err.status = 502
    throw err
  }
  const taskId = first.output?.task_id
  if (!taskId) {
    const err = new Error(wanxError(first, '万相未返回任务号'))
    err.status = 502
    throw err
  }
  for (let i = 0; i < 45; i += 1) {
    await sleep(2000)
    const st = await fetch(`${origin}/api/v1/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${env.DASHSCOPE_API_KEY}` },
    })
    const body = await st.json().catch(() => ({}))
    const status = body.output?.task_status
    if (status === 'SUCCEEDED') return body
    if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
      const err = new Error(wanxError(body, '万相任务失败'))
      err.status = 502
      throw err
    }
    if (!st.ok) {
      const err = new Error(wanxError(body, `万相查询 ${st.status}`))
      err.status = 502
      throw err
    }
  }
  const err = new Error('万相超时')
  err.status = 504
  throw err
}

async function inpaint(env, payload) {
  const { inpaintModel } = models(env)
  const prompt = String(payload.prompt || '').trim() || '按标注修改选中区域，其余画面保持不变'
  const imageUrl = payload.imageDataUrl || payload.image_url
  const maskUrl = payload.maskDataUrl || payload.mask_url
  if (!imageUrl || !maskUrl) {
    const err = new Error('missing image or mask')
    err.status = 400
    throw err
  }
  const data = await wanxInpaint(env, {
    model: inpaintModel,
    prompt,
    imageUrl,
    maskUrl,
  })
  const results = data.output?.results || []
  const url = results[0]?.url || results[0]?.image_url
  if (!url) {
    const err = new Error(wanxError(data, '万相未返回图片'))
    err.status = 502
    throw err
  }
  const resultUrl = await inlineImage(url)
  return { imageUrl: resultUrl, model: inpaintModel }
}

export function marksetApi(env) {
  return {
    name: 'markset-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0] || ''
        if (!url.startsWith('/api/')) return next()

        try {
          if (req.method === 'GET' && url === '/api/health') {
            const miss = missing(env)
            send(res, 200, {
              ok: !miss.dashscope,
              dashscope: !miss.dashscope,
              wanx: !miss.dashscope,
              fal: false,
              sam: false,
              allowCalls: env.MARKSET_ALLOW_MODEL_CALLS === '1',
              importPage: true,
              renderedImport: Boolean(env.BROWSERLESS_API_KEY || env.BROWSERLESS_TOKEN),
              ...models(env),
              hints: keyHints(env),
            })
            return
          }

          if (req.method !== 'POST') {
            send(res, 405, { error: 'method' })
            return
          }

          const body = await readBody(req)
          const miss = missing(env)

          if (url === '/api/import-page') {
            let page = await importPageRequest(body, env)
            if (body?.smart) {
              if (!allowModelCalls(env, req)) {
                page.warnings = [
                  ...(page.warnings || []),
                  '智能整理未执行：请勾选「允许调用云端模型」，且 .env 中 MARKSET_ALLOW_MODEL_CALLS=1',
                ]
              } else if (miss.dashscope) {
                page.warnings = [...(page.warnings || []), '智能整理未执行：未填 DASHSCOPE_API_KEY']
              } else {
                try {
                  page = await maybeSmartArrange(page, {
                    chatFn: (opts) => dashChat(env, opts),
                    model: models(env).rewriteModel,
                  })
                } catch {
                  page.warnings = [...(page.warnings || []), '智能整理失败，已用抓取结果']
                }
              }
            }
            send(res, 200, page)
            return
          }

          if (url === '/api/plan' && (body.task === 'intent' || body.task === 'ink')) {
            if (env.MARKSET_ALLOW_MODEL_CALLS !== '1') {
              send(res, 403, { error: 'model calls disabled', code: 'calls_disabled' })
              return
            }
            if (miss.dashscope) {
              send(res, 503, { error: 'missing DASHSCOPE_API_KEY' })
              return
            }
            send(res, 200, await plan(env, body))
            return
          }

          if (!allowModelCalls(env, req)) {
            send(res, 403, {
              error: 'model calls disabled',
              code: env.MARKSET_ALLOW_MODEL_CALLS === '1' ? 'no_client_gate' : 'calls_disabled',
            })
            return
          }

          if (url === '/api/rewrite' || url === '/api/plan') {
            if (miss.dashscope) {
              send(res, 503, { error: 'missing DASHSCOPE_API_KEY' })
              return
            }
            send(res, 200, url === '/api/plan' ? await plan(env, body) : await rewrite(env, body))
            return
          }

          if (url === '/api/inpaint') {
            if (miss.dashscope) {
              send(res, 503, { error: 'missing DASHSCOPE_API_KEY' })
              return
            }
            send(res, 200, await inpaint(env, body))
            return
          }

          if (url === '/api/sam') {
            send(res, 501, { error: '云端贴轮廓已关闭，请用鼠标圈选范围', code: 'sam_disabled' })
            return
          }

          send(res, 404, { error: 'not found' })
        } catch (err) {
          send(res, err.status || 500, { error: redact(err.message, env), code: err.code })
        }
      })
    },
  }
}
