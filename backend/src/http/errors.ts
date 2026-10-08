import { STATUS_CODES } from 'node:http'
import type { ErrorRequestHandler, RequestHandler } from 'express'
import { z } from 'zod'
import type { ApiError } from '../../../shared/types.ts'

/** Throw from any handler; the error middleware turns it into an `ApiError` response. */
export class HttpError extends Error {
  readonly status: number
  readonly details?: Record<string, string>
  constructor(status: number, message: string, details?: Record<string, string>) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.details = details
  }
}

const pathKey = (path: readonly PropertyKey[]) => (path.length ? path.map(String).join('.') : 'body')

/** First message per field path, e.g. `{ "leads.3.profileUrl": "…" }`. */
export function zodDetails(err: z.ZodError): Record<string, string> {
  const details: Record<string, string> = {}
  for (const issue of err.issues) details[pathKey(issue.path)] ??= issue.message
  return details
}

/** zod's built-in messages don't name the field, so prefix them with the path. */
function issueSummary(issue: z.ZodError['issues'][number]) {
  const generic = /^(Invalid|Too (small|big)|Unrecognized|Expected)/.test(issue.message)
  return generic && issue.path.length ? `${pathKey(issue.path)}: ${issue.message}` : issue.message
}

export function validationError(err: z.ZodError | null, extra: Record<string, string> = {}): HttpError {
  const details = { ...(err ? zodDetails(err) : {}), ...extra }
  const message = err?.issues[0] ? issueSummary(err.issues[0]) : (Object.values(extra)[0] ?? 'Invalid request')
  return new HttpError(400, message, details)
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: 'Not found' } satisfies ApiError)
}

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err)
  let status = 500
  let body: ApiError = { error: 'Internal server error' }

  if (err instanceof HttpError) {
    status = err.status
    body = err.details && Object.keys(err.details).length ? { error: err.message, details: err.details } : { error: err.message }
  } else if (err instanceof z.ZodError) {
    const e = validationError(err)
    status = 400
    body = { error: e.message, details: e.details }
  } else if (err?.type === 'entity.parse.failed') {
    status = 400
    body = { error: 'Request body is not valid JSON' }
  } else if (err?.type === 'entity.too.large') {
    status = 413
    body = { error: 'Request body is too large' }
  } else if (err?.status === 400 && err instanceof URIError) {
    // the router could not decode a path parameter (malformed percent-encoding such as "%ZZ")
    status = 400
    body = { error: 'Malformed URL' }
  } else if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500) {
    // body-parser / http-errors client errors (unsupported charset, aborted request …); the message
    // is only shown when the error marks it safe to expose
    status = err.status
    body = { error: err.expose && err.message ? String(err.message) : (STATUS_CODES[status] ?? 'Bad request') }
  }

  if (status >= 500) console.error(`[api] ${req.method} ${req.originalUrl} failed:`, err?.stack ?? err)
  res.status(status).json(body)
}
