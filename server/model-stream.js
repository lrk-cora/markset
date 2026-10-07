import { readEventStream } from '../src/event-stream.js'
import { requestFailure as failure, machineCause, transientTransport } from './retry.js'

/** Assemble indexed native tool calls without exposing reasoning or executing
 * partial arguments. Each attempt owns its own buffers. */
export async function readModelStream(response, { signal, onDelta, onProgress } = {}) {
  const calls = new Map()
  let content = '', usage = null, id = '', finished = false, done = false
  try {
    await readEventStream(response.body, ({ data }) => {
      if (data === '[DONE]') { done = true; return }
      if (done) throw new Error('data-after-done')
      const chunk = JSON.parse(data)
      if (chunk.error) throw new Error('provider-stream-error')
      id ||= chunk.id || ''
      if (chunk.usage) usage = chunk.usage
      const choice = chunk.choices?.find(value => (value.index ?? 0) === 0)
      if (!choice) return
      if (choice.finish_reason) {
        if (!['stop', 'tool_calls'].includes(choice.finish_reason)) throw new Error('incomplete-model-output')
        finished = true
      }
      const delta = choice.delta || {}
      let useful = typeof delta.content === 'string' && delta.content.length > 0
      if (typeof delta.content === 'string') content += delta.content
      for (const part of delta.tool_calls || []) {
        const index = part.index ?? 0
        if (!Number.isInteger(index) || index < 0 || index > 7) throw new Error('invalid-tool-index')
        const call = calls.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } }
        if (part.id) call.id = part.id
        if (part.function?.name) call.function.name += part.function.name
        if (typeof part.function?.arguments === 'string') call.function.arguments += part.function.arguments
        useful ||= typeof part.function?.arguments === 'string' && part.function.arguments.length > 0
        calls.set(index, call)
      }
      if (content.length + [...calls.values()].reduce((sum, call) => sum + call.function.arguments.length, 0) > 500_000) throw new Error('model-output-too-large')
      // reasoning_content is deliberately ignored. Only a public result field
      // will be extracted from these accumulated plan arguments by the caller.
      if (useful) onProgress?.()
      onDelta?.({ content, toolCalls: [...calls.values()] })
    }, { signal })
  } catch (error) {
    signal?.throwIfAborted()
    if (transientTransport(error)) throw failure('AI 连接中断', 'model_gateway_unreachable', 502, { causeCode: machineCause(error), transient: true })
    throw failure('AI 流式结果不完整或格式异常', 'model_gateway_invalid_response', 502)
  }
  if (!finished || !done) throw failure('AI 连接中断，方案尚未完整返回', 'model_gateway_unreachable', 502, { transient: true })
  const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call)
  if (toolCalls.some(call => !call.id || !call.function.name || !call.function.arguments)) throw failure('AI 工具结果不完整', 'model_gateway_invalid_response', 502)
  return { id, usage, choices: [{ message: { content, tool_calls: toolCalls } }] }
}

/** Read ONLY a top-level public string from incomplete JSON. Nested node text,
 * rationale and hidden reasoning can never masquerade as the suggestion. */
export function partialPlanSuggestion(source) {
  const text = String(source || '')
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '{' || char === '[') { depth++; continue }
    if (char === '}' || char === ']') { depth--; continue }
    if (char !== '"') continue
    const start = i++
    for (; i < text.length; i++) { if (text[i] === '\\') i++; else if (text[i] === '"') break }
    if (i >= text.length) break
    if (depth !== 1) continue
    let key
    try { key = JSON.parse(text.slice(start, i + 1)) } catch { continue }
    let cursor = i + 1
    while (/\s/u.test(text[cursor] || '') && cursor < text.length) cursor++
    if (text[cursor] !== ':') continue
    cursor++; while (/\s/u.test(text[cursor] || '') && cursor < text.length) cursor++
    if (key !== 'suggestion' || text[cursor] !== '"') continue
    let value = ''
    for (cursor++; cursor < text.length && value.length < 180; cursor++) {
      if (text[cursor] === '"') break
      if (text[cursor] !== '\\') { value += text[cursor]; continue }
      const escaped = text[++cursor]
      if (escaped === 'u') {
        const hex = text.slice(cursor + 1, cursor + 5)
        if (!/^[\da-f]{4}$/iu.test(hex)) break
        value += String.fromCharCode(parseInt(hex, 16)); cursor += 4
      } else {
        const escapes = { '"': '"', '\\': '\\', '/': '/', n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }
        if (!(escaped in escapes)) break
        value += escapes[escaped]
      }
    }
    return value.replace(/[\u0000-\u001f]/gu, ' ').replace(/[\ud800-\udbff]$/u, '').slice(0, 180)
  }
  return ''
}
