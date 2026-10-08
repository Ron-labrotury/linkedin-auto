import type { Sequence } from '../../../shared/types.ts'
import { pickDelayMs } from '../../../shared/sequence.ts'
import { type DB, all, run, tx } from '../db/index.ts'

/**
 * After a sequence edit, repair leads whose current step no longer exists (see docs/ENGINE.md).
 * Leads never acted on restart at the new root; leads already in progress are finished.
 * A lead whose step is running on LinkedIn right now still looks "never acted on" here; when that
 * step's result arrives, the engine places the lead as if the result had been saved before the
 * edit (steps.ts leadWriter, `rerooted`), so it never gets the new root as a second first action.
 */
export function reconcileLeads(db: DB, campaignId: string, sequence: Sequence, now = Date.now(), rand: () => number = Math.random) {
  const root = sequence.rootId ? sequence.steps[sequence.rootId] : undefined
  const leads = all<{ id: string; current_step_id: string | null; last_action_at: number | null }>(
    db,
    `SELECT id, current_step_id, last_action_at FROM leads
     WHERE campaign_id = ? AND status NOT IN ('finished', 'skipped', 'failed')`,
    campaignId,
  )
  tx(db, () => {
    for (const l of leads) {
      if (l.current_step_id && sequence.steps[l.current_step_id]) continue
      if (l.last_action_at == null) {
        const due = root ? now + pickDelayMs(root.delay, rand) : null
        run(db, `UPDATE leads SET current_step_id = ?, next_action_at = ?, step_started_at = ?, attempts = 0 WHERE id = ?`, root?.id ?? null, due, due, l.id)
      } else {
        run(db, `UPDATE leads SET status = CASE WHEN status = 'replied' THEN 'replied' ELSE 'finished' END,
                 current_step_id = NULL, next_action_at = NULL WHERE id = ?`, l.id)
      }
    }
  })
}
