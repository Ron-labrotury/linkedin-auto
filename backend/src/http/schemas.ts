import { z } from 'zod'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Trimmed, lower-cased email address. */
export const emailSchema = z
  .string('Enter an email address')
  .trim()
  .toLowerCase()
  .min(1, 'Enter an email address')
  .max(254, 'Email address is too long')
  .regex(EMAIL_RE, 'Enter a valid email address')

export const personNameSchema = z
  .string('Enter your name')
  .trim()
  .min(1, 'Enter your name')
  .max(80, 'Name must be at most 80 characters')

export const newPasswordSchema = z
  .string('Enter a password')
  .min(8, 'Password must be at least 8 characters')
  .max(200, 'Password must be at most 200 characters')
