import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export function importFail(message, status = 400, code = 'import_error') {
  const err = new Error(message)
  err.status = status
  err.code = code
  return err
}

function isPrivateIp(ip) {
  const v = String(ip || '')
    .toLowerCase()
    .replace(/^::ffff:/, '')
  if (!v || v === '::1' || v === '0.0.0.0') return true
  if (/^127\./.test(v) || /^10\./.test(v) || /^192\.168\./.test(v) || /^169\.254\./.test(v)) return true
  const m = v.match(/^172\.(\d+)\./)
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true
  if (v.includes(':') && (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80'))) return true
  return false
}

export async function assertPublicUrl(raw) {
  let parsed
  try {
    parsed = new URL(String(raw || '').trim())
  } catch {
    throw importFail('地址无效，请粘贴 http(s) 链接')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw importFail('只支持 http / https 网页')
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw importFail('不能抓本机或内网地址')
  }
  const ips = []
  if (isIP(host)) ips.push(host)
  else {
    try {
      const found = await lookup(host, { all: true })
      ips.push(...found.map((row) => row.address))
    } catch {
      throw importFail('这个域名解析失败')
    }
  }
  if (!ips.length || ips.some(isPrivateIp)) throw importFail('不能抓本机或内网地址')
  return parsed
}
