import { defineConfig, loadEnv } from 'vite'
import { marksetApi } from './server/plugin.js'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    base: './',
    plugins: [marksetApi(env)],
    server: {
      port: 5173,
      host: true,
      strictPort: true,
    },
    preview: {
      port: 5173,
    },
  }
})
