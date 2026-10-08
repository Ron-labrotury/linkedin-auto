import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = fileURLToPath(new URL('../shared', import.meta.url))
const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig(({ command, mode }) => {
  // On Vercel the frontend is a static site and the API runs elsewhere (e.g. Render). Without
  // VITE_API_URL every API call goes to the static site itself; the build still succeeds (so
  // previews keep deploying) and the sign-in page explains what to set.
  if (command === 'build' && process.env.VERCEL && !loadEnv(mode, root, 'VITE_').VITE_API_URL?.trim()) {
    console.warn(
      '\n⚠ VITE_API_URL is not set. On Vercel the frontend needs the URL of your backend API, e.g. https://linkedin-auto.onrender.com – ' +
        'add VITE_API_URL in the Vercel project (Settings → Environment Variables) and redeploy.\n',
    )
  }
  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@shared': shared } },
    server: {
      fs: { allow: ['..'] },
      // In dev, /api goes to the backend (npm run dev in backend/).
      proxy: { '/api': { target: process.env.VITE_DEV_API_TARGET ?? 'http://localhost:8787', changeOrigin: true } },
    },
  }
})
