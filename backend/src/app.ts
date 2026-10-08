import fs from 'node:fs'
import path from 'node:path'
import cors from 'cors'
import express from 'express'
import type { AppDeps } from './http/types.ts'
import { HttpError, errorHandler, notFoundHandler } from './http/errors.ts'
import { createRequireAuth } from './auth/middleware.ts'
import { authRouter } from './routes/auth.ts'
import { settingsRouter } from './routes/settings.ts'
import { linkedinRouter } from './routes/linkedin.ts'
import { campaignsRouter } from './routes/campaigns.ts'
import { dashboardRouter } from './routes/dashboard.ts'
import { teamRouter } from './routes/team.ts'

export type { AppDeps } from './http/types.ts'

export function createApp(deps: AppDeps): express.Express {
  const { db, config } = deps
  const app = express()
  app.disable('x-powered-by')
  // Only the configured proxy hops may set the client IP via X-Forwarded-For (it keys the login rate limit).
  app.set('trust proxy', config.trustProxy)

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    next()
  })

  const requireAuth = createRequireAuth({ db, ttlMs: config.sessionTtlMs })
  const anyOrigin = !config.corsOrigins.length || config.corsOrigins.includes('*')

  const api = express.Router()
  // Bearer tokens, no cookies: credentials stay off, so "*" is safe.
  api.use(cors({ origin: anyOrigin ? '*' : config.corsOrigins, exposedHeaders: ['Retry-After'], maxAge: 600 }))
  api.use(express.json({ limit: '5mb' }))
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    next()
  })

  api.get('/health', (_req, res) => {
    res.json({ ok: true, driver: deps.linkedin.kind })
  })
  api.use('/auth', authRouter(deps, requireAuth))
  api.use('/settings', requireAuth, settingsRouter(deps))
  api.use('/linkedin', requireAuth, linkedinRouter(deps))
  api.use('/campaigns', requireAuth, campaignsRouter(deps))
  api.use('/dashboard', requireAuth, dashboardRouter(deps))
  api.use('/team', requireAuth, teamRouter(deps))
  api.use(() => {
    throw new HttpError(404, 'Not found')
  })
  app.use('/api', api)

  // Optional single-origin deploy: serve the built frontend and let the SPA route everything else.
  const indexHtml = path.join(config.frontendDist, 'index.html')
  if (fs.existsSync(indexHtml)) {
    app.use(
      express.static(config.frontendDist, {
        index: false,
        setHeaders(res, file) {
          if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        },
      }),
    )
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next()
      res.setHeader('Cache-Control', 'no-cache')
      res.sendFile(indexHtml)
    })
  }

  app.use(notFoundHandler)
  app.use(errorHandler)
  return app
}
