import type { Config } from '../config.ts'
import type { DB } from '../db/index.ts'
import { createPlaywrightService } from './playwright/service.ts'
import { createSimulatedService } from './simulated.ts'
import type { LinkedInService } from './types.ts'

export type { LinkedInService } from './types.ts'
export { LinkedInError } from './types.ts'

/** The LinkedIn service selected by LINKEDIN_DRIVER ("simulated" fakes LinkedIn; anything else drives a real browser). */
export function createLinkedInService(deps: { db: DB; config: Config }): LinkedInService {
  return deps.config.linkedinDriver === 'simulated' ? createSimulatedService(deps) : createPlaywrightService(deps)
}
