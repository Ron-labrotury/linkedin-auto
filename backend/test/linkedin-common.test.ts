import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createKeyedMutex, normalizeName, sameName, sleep, splitName } from '../src/linkedin/common.ts'
import { isStorageState, userAgentFor } from '../src/linkedin/playwright/browser.ts'

describe('linkedin helpers', () => {
  it('the keyed mutex serializes per key, releases on errors and leaves other keys alone', async () => {
    const lock = createKeyedMutex()
    const order: string[] = []
    const failing = lock('u1', async () => {
      order.push('u1:a')
      await sleep(20)
      throw new Error('boom')
    })
    const next = lock('u1', async () => {
      order.push('u1:b')
      return 42
    })
    const other = lock('u2', async () => {
      order.push('u2')
    })
    await assert.rejects(failing, /boom/)
    assert.equal(await next, 42)
    await other
    assert.deepEqual(order, ['u1:a', 'u2', 'u1:b'])
  })

  it('splits and compares names the way LinkedIn shows them', () => {
    assert.deepEqual(splitName('  Jane   van der Berg, PhD '), { firstName: 'Jane', lastName: 'van der Berg' })
    assert.deepEqual(splitName('Cher'), { firstName: 'Cher', lastName: '' })
    assert.equal(normalizeName('José Álvarez-Núñez, MBA'), 'jose alvarez nunez')
    assert.ok(sameName('Jane Doe', 'jane doe'))
    assert.ok(sameName('Jane Doe, MBA', 'Jane Doe'))
    assert.ok(sameName('Jane D.', 'Jane Doe'))
    assert.ok(sameName('Jane', 'Jane Doe'))
    assert.ok(!sameName('Jane Doe', 'John Doe'))
    assert.ok(!sameName('', 'Jane'))
  })

  it('builds a desktop Chrome user agent for the host OS', () => {
    assert.equal(userAgentFor('141.0.7390.37', 'linux'), 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36')
    assert.match(userAgentFor('141.0.7390.37', 'darwin'), /Macintosh.*Chrome\/141\.0\.0\.0/)
    assert.match(userAgentFor('141.0.7390.37', 'win32'), /Windows NT 10\.0/)
    assert.ok(!/Headless/i.test(userAgentFor('141.0.7390.37')))
  })

  it('recognises Playwright storage states', () => {
    assert.ok(isStorageState({ cookies: [], origins: [] }))
    assert.ok(!isStorageState({ simulated: true }))
    assert.ok(!isStorageState(null))
  })
})
