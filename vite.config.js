import { defineConfig, loadEnv } from 'vite'
import { marksetApi } from './server/plugin.js'
import { resolveRuntimeEnv, privateFilesPlugin } from './server/runtime-config.js'

export default defineConfig(({ mode }) => {
  const env = resolveRuntimeEnv(loadEnv(mode, process.cwd(), ''), process.cwd())
  return {
    base: './',
    plugins: [privateFilesPlugin(env), marksetApi(env)],
    server: {
      port: 5173,
      // This local app exposes paid API operations; do not bind to LAN by default.
      host: '127.0.0.1',
      strictPort: true,
    },
    preview: {
      port: 5173,
    },
  }
})
