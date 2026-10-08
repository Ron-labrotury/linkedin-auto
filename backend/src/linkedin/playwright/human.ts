/** Human-like pacing: random pauses, per-key typing delays and light scrolling. */
import type { Page } from 'playwright'
import { randInt, sleep } from '../common.ts'

export interface Pacing {
  /** pause between interactions */
  pauseMs: [number, number]
  /** short pause (after a click, between fields) */
  shortPauseMs: [number, number]
  keyDelayMs: [number, number]
  navTimeoutMs: number
  /** how long to wait for an element / page to appear */
  elementTimeoutMs: number
  /** how long to wait for LinkedIn to confirm an action */
  verifyTimeoutMs: number
  /**
   * An opened conversation that shows no messages counts as empty only after this long without a
   * loader and without any message appearing (LinkedIn renders the message box before the history).
   */
  historySettleMs: number
  scroll: boolean
}

export const HUMAN_PACING: Pacing = {
  pauseMs: [1000, 3000],
  shortPauseMs: [250, 800],
  keyDelayMs: [35, 120],
  navTimeoutMs: 45_000,
  elementTimeoutMs: 20_000,
  verifyTimeoutMs: 12_000,
  historySettleMs: 3_000,
  scroll: true,
}

export const pause = (p: Pacing) => sleep(randInt(...p.pauseMs))
export const shortPause = (p: Pacing) => sleep(randInt(...p.shortPauseMs))

/** Messages longer than this are typed partly key-by-key, then pasted in chunks. */
const KEY_BY_KEY_LIMIT = 400

/**
 * Type into the focused element. Newlines become Shift+Enter (plain Enter can send a LinkedIn
 * message); characters not on a keyboard (emoji, accents) are inserted by Playwright as text.
 */
export async function typeLikeHuman(page: Page, text: string, p: Pacing) {
  const chars = Array.from(text.replace(/\r\n?/g, '\n').replace(/\t/g, ' '))
  const slow = chars.length <= KEY_BY_KEY_LIMIT ? chars.length : 80
  for (const ch of chars.slice(0, slow)) {
    if (ch === '\n') await page.keyboard.press('Shift+Enter')
    else await page.keyboard.type(ch)
    await sleep(randInt(...p.keyDelayMs))
  }
  if (slow < chars.length) await insertText(page, chars.slice(slow).join(''), p)
}

/** Insert text in chunks (no key events), keeping line breaks as Shift+Enter. */
export async function insertText(page: Page, text: string, p: Pacing) {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await page.keyboard.press('Shift+Enter')
    for (const chunk of lines[i].match(/[\s\S]{1,60}(\s|$)|[\s\S]{1,60}/g) ?? []) {
      await page.keyboard.insertText(chunk)
      await sleep(randInt(...p.keyDelayMs) * 3)
    }
  }
}

/** Scroll down a bit and back, with a little mouse movement. */
export async function browseLightly(page: Page, p: Pacing) {
  if (!p.scroll) return
  try {
    const vp = page.viewportSize() ?? { width: 1366, height: 768 }
    await page.mouse.move(randInt(200, vp.width - 200), randInt(150, vp.height - 150), { steps: randInt(5, 15) })
    await page.mouse.wheel(0, randInt(250, 650))
    await sleep(randInt(...p.shortPauseMs) * 2)
    await page.mouse.wheel(0, -randInt(150, 650))
    await sleep(randInt(...p.shortPauseMs))
  } catch {
    /* scrolling is cosmetic */
  }
}

/** Scroll to the bottom in steps so lazily rendered content (e.g. search results, pagination) appears. */
export async function scrollThrough(page: Page, p: Pacing, steps = 6) {
  for (let i = 0; i < steps; i++) {
    try {
      await page.mouse.wheel(0, randInt(500, 900))
    } catch {
      return
    }
    await sleep(p.scroll ? randInt(300, 900) : 50)
  }
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {})
  await sleep(p.scroll ? randInt(500, 1200) : 50)
}
