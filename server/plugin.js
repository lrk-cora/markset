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
    inpaintModel: env.FAL_INPAINT_MODEL || 'fal-ai/flux-pro/v1/fill',
    samModel: env.FAL_SAM_MODEL || 'fal-ai/sam2/image',
  }
}

function missing(env) {
  return {
    dashscope: !env.DASHSCOPE_API_KEY,
    fal: !env.FAL_KEY,
  }
}

function allowModelCalls(env, req) {
  return env.MARKSET_ALLOW_MODEL_CALLS === '1' && req.headers['x-markset-call'] === '1'
}

function redact(text, env) {
  let out = String(text || 'api error')
  for (const secret of [env.DASHSCOPE_API_KEY, env.FAL_KEY]) {
    if (secret && secret.length > 6) out = out.split(secret).join('[redacted]')
  }
  return out
}

function keyHints(env) {
  const dash = env.DASHSCOPE_API_KEY || ''
  const fal = env.FAL_KEY || ''
  return {
    dashscopePrefixOk: dash.startsWith('sk-'),
    falPairOk: Boolean(fal) && fal.includes(':') && !fal.includes(' '),
  }
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

async function plan(env, payload) {
  const { plannerModel } = models(env)
  const instruction = String(payload.instruction || '').trim()
  const marks = String(payload.marks || '')
  const imageUrl = payload.imageDataUrl || payload.image_url
  if (!instruction) {
    const err = new Error('missing instruction')
    err.status = 400
    throw err
  }
  const userContent = [
    {
      type: 'text',
      text: `指令：${instruction}\n当前编号：${marks || '无'}\n只输出 JSON，不要其它文字。`,
    },
  ]
  if (imageUrl) {
    userContent.push({ type: 'image_url', image_url: { url: imageUrl } })
  }
  const textOut = await dashChat(env, {
    model: plannerModel,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content:
          'Output JSON only: {"ops":[{"target":"T1","tool":"llm_rewrite","args":{"instruction":"..."}},{"target":"I2","tool":"image_inpaint","args":{"prompt":"..."}}]}',
      },
      { role: 'user', content: userContent },
    ],
  })
  return { text: textOut, model: plannerModel }
}

async function falRun(env, model, body) {
  const res = await fetch(`https://fal.run/${model}`, {
    method: 'POST',
    headers: {
      Authorization: `Key ${env.FAL_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.detail || data.message || `fal ${res.status}`)
    err.status = 502
    throw err
  }
  return data
}

async function inpaint(env, payload) {
  const { inpaintModel } = models(env)
  const prompt = String(payload.prompt || '').trim()
  const imageUrl = payload.imageDataUrl || payload.image_url
  const maskUrl = payload.maskDataUrl || payload.mask_url
  if (!prompt || !imageUrl || !maskUrl) {
    const err = new Error('missing prompt, image, or mask')
    err.status = 400
    throw err
  }
  const data = await falRun(env, inpaintModel, {
    prompt,
    image_url: imageUrl,
    mask_url: maskUrl,
    sync_mode: true,
    output_format: 'png',
  })
  const url = data.images?.[0]?.url || data.image?.url
  if (!url) {
    const err = new Error('fal empty')
    err.status = 502
    throw err
  }
  const resultUrl = url.startsWith('data:') ? url : await inlineImage(url)
  return { imageUrl: resultUrl, model: inpaintModel }
}

async function inlineImage(url) {
  const res = await fetch(url)
  if (!res.ok) {
    const err = new Error('fal image fetch')
    err.status = 502
    throw err
  }
  const buf = Buffer.from(await res.arrayBuffer())
  const mime = res.headers.get('content-type') || 'image/png'
  return `data:${mime};base64,${buf.toString('base64')}`
}

async function sam(env, payload) {
  const { samModel } = models(env)
  const imageUrl = payload.imageDataUrl || payload.image_url
  if (!imageUrl) {
    const err = new Error('missing image')
    err.status = 400
    throw err
  }
  const body = {
    image_url: imageUrl,
    apply_mask: false,
    sync_mode: true,
    output_format: 'png',
  }
  if (payload.box) body.box_prompts = [payload.box]
  if (payload.points?.length) body.prompts = payload.points
  const data = await falRun(env, samModel, body)
  const url = data.image?.url || data.images?.[0]?.url
  if (!url) {
    const err = new Error('sam empty')
    err.status = 502
    throw err
  }
  const maskDataUrl = url.startsWith('data:') ? url : await inlineImage(url)
  return { maskDataUrl, model: samModel }
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
              ok: !miss.dashscope && !miss.fal,
              dashscope: !miss.dashscope,
              fal: !miss.fal,
              allowCalls: env.MARKSET_ALLOW_MODEL_CALLS === '1',
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

          if (url === '/api/inpaint' || url === '/api/sam') {
            if (miss.fal) {
              send(res, 503, { error: 'missing FAL_KEY' })
              return
            }
            send(res, 200, url === '/api/sam' ? await sam(env, body) : await inpaint(env, body))
            return
          }

          send(res, 404, { error: 'not found' })
        } catch (err) {
          send(res, err.status || 500, { error: redact(err.message, env) })
        }
      })
    },
  }
}
