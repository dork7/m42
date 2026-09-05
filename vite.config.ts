import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/analyze-skin': {
        target: 'https://matifimran.app.n8n.cloud',
        changeOrigin: true,
        rewrite: (path) =>
          path.replace(/^\/api\/analyze-skin/, '/webhook/analyze-skin'),
      },
    },
  },
})
