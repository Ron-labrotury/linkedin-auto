import path from 'node:path'
import { config } from './config.ts'
import { openDb } from './db/index.ts'
import { createLinkedInService } from './linkedin/index.ts'
import { createEngine } from './engine/engine.ts'
import { createApp } from './app.ts'

const db = openDb(path.join(config.dataDir, 'app.db'))
const linkedin = createLinkedInService({ db, config })
const engine = createEngine({ db, linkedin, tickMs: config.engineTickMs })
const app = createApp({ db, linkedin, engine, config })

const server = app.listen(config.port, () => {
  console.log(`[api] listening on http://localhost:${config.port} (driver: ${linkedin.kind})`)
  if (config.usingDevSecret) console.warn('[api] APP_SECRET is not set – using an insecure development secret')
  if (config.engineEnabled) engine.start()
  else console.warn('[engine] disabled (ENGINE_ENABLED=false)')
})

let closing = false
async function shutdown(signal: string) {
  if (closing) return
  closing = true
  console.log(`[api] ${signal} received, shutting down`)
  engine.stop()
  server.close()
  await linkedin.shutdown().catch(() => {})
  db.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
