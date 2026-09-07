import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: {
      '/api/analyze-skin': {
        target: 'https://matifimran.app.n8n.cloud',
        changeOrigin: true,
        rewrite: (path) =>
          path.replace(/^\/api\/analyze-skin/, '/webhook/analyze-skin'),
      },
      // Local-only: dev "AI CHECK" button → local vision service. The proxy
      // injects the Cookie the service expects (browsers can't set it via fetch)
      // and sidesteps CORS. No effect in production builds.
      '/vision-api': {
        target: 'http://localhost:2020',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/vision-api/, '/v1/vision'),
        // The local model can take minutes to respond — don't cut it off.
        timeout: 300_000,
        proxyTimeout: 300_000,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('cookie', 'logUuid=anpysut127')
          })
        },
      },
    },
  },
})
