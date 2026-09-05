// Copies the MediaPipe Tasks Vision wasm runtime out of node_modules into
// public/vendor/mediapipe/wasm so it is served from our own origin (no CDN).
// Runs on postinstall; also invokable via `npm run sync-mediapipe-wasm`.
import { cp, mkdir, access } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = resolve(root, 'node_modules/@mediapipe/tasks-vision/wasm')
const dest = resolve(root, 'public/vendor/mediapipe/wasm')

try {
  await access(src)
} catch {
  console.warn('[sync-mediapipe-wasm] @mediapipe/tasks-vision not installed yet; skipping.')
  process.exit(0)
}

await mkdir(dest, { recursive: true })
await cp(src, dest, { recursive: true })
console.log(`[sync-mediapipe-wasm] copied wasm runtime -> ${dest}`)
