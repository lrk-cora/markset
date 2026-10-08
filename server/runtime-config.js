import { statSync, realpathSync } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'

export const DEFAULT_KEY_FILE = '.markset-private/阿里.txt'
export const DEFAULT_REGION = 'cn-beijing'

function isFile(path) {
  try { return statSync(path).isFile() } catch { return false }
}

function inside(parent, path) {
  const rel = relative(parent, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'))
}

// Server-only defaults for a fresh checkout. Never probe regions or providers,
// and never override an explicitly disabled call gate or an explicit key path.
export function resolveRuntimeEnv(input, projectRoot) {
  const env = { ...input }
  env.MARKSET_PROVIDER ||= 'bailian'
  if (env.MARKSET_PROVIDER !== 'bailian') return env
  env.MARKSET_BAILIAN_REGION ||= DEFAULT_REGION
  const explicitFile = env.MARKSET_BAILIAN_KEY_FILE?.trim()
  const defaultFile = resolve(projectRoot, DEFAULT_KEY_FILE)
  env.MARKSET_BAILIAN_KEY_FILE = explicitFile
    ? resolve(projectRoot, explicitFile)
    : !env.MARKSET_BAILIAN_API_KEY && isFile(defaultFile) ? defaultFile : ''
  const file = env.MARKSET_BAILIAN_KEY_FILE
  if (file) {
    const realFile = isFile(file) ? realpathSync(file) : file
    if (inside(resolve(projectRoot, 'public'), file) || inside(resolve(projectRoot, 'public'), realFile)) {
      throw new Error('密钥文件不能放在 public 中；请使用 .markset-private/阿里.txt')
    }
  }
  // The normal parser still validates the file. Finding it does not assert
  // authentication, model availability, balance, or a successful model call.
  env.MARKSET_ALLOW_MODEL_CALLS ??= (env.MARKSET_BAILIAN_API_KEY || isFile(file)) ? '1' : '0'
  return env
}

const defaultDeny = ['.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**']
const globLiteral = path => path.replaceAll('\\', '/').replace(/[!*?{}[\]()]/gu, '\\$&')

// Git ignore is not an HTTP access control. Deny static, raw and module access,
// including the resolved path when an explicitly configured file is a symlink.
export function privateFilesPlugin(env) {
  const file = env.MARKSET_BAILIAN_KEY_FILE
  const protectedPaths = file ? [file, ...(isFile(file) ? [realpathSync(file)] : [])] : []
  const normalize = path => resolve(path).replaceAll('\\', '/').toLowerCase()
  const privatePaths = new Set(protectedPaths.map(normalize))
  return {
    name: 'markset-private-files',
    config(config) {
      return { server: { fs: { deny: [
        ...(config.server?.fs?.deny || defaultDeny),
        '**/.markset-private/**', ...protectedPaths.map(globLiteral),
      ] }, watch: { ignored: ['**/.markset-private/**'] } } }
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        let path
        try { path = decodeURIComponent((req.url || '').split('?')[0]).replaceAll('\\', '/') }
        catch { res.statusCode = 400; res.end('Invalid path'); return }
        const requestedFile = path.startsWith('/@fs/') ? path.slice(5) : resolve(server.config.root, `.${path}`)
        if (/(?:^|\/)\.markset-private(?:\/|$)/iu.test(path) || privatePaths.has(normalize(requestedFile))) {
          res.statusCode = 403
          res.setHeader('Content-Type', 'text/plain; charset=utf-8')
          res.end('Private files are not served')
          return
        }
        next()
      })
    },
  }
}
