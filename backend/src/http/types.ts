import type { Config } from '../config.ts'
import type { DB } from '../db/index.ts'
import type { LinkedInService } from '../linkedin/types.ts'

/** The part of the engine the API needs (the real engine has more methods). */
export interface EngineView {
  nextActionAt(userId: string): number | null
}

export interface AppDeps {
  db: DB
  linkedin: LinkedInService
  engine: EngineView
  config: Config
}
