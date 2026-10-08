// Run: node --test "frontend/src/**/*.test.ts"
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { absoluteUrl, isPublicPath, loginPath, safeNext } from './links.ts'

test('safeNext keeps in-app paths with query and hash', () => {
  assert.equal(safeNext('/campaigns/abc?tab=leads#top'), '/campaigns/abc?tab=leads#top')
  assert.equal(safeNext('/'), '/')
  assert.equal(safeNext('  /settings  '), '/settings')
})

test('safeNext rejects open redirects and auth pages', () => {
  for (const bad of [null, undefined, '', 'https://evil.com', '//evil.com/x', '/\\evil.com', 'javascript:alert(1)', 'settings', '/login', '/signup?invite=x', '/login/x', '/a\nb']) {
    assert.equal(safeNext(bad), null, String(bad))
  }
})

test('safeNext normalises dot segments without leaving the app', () => {
  assert.equal(safeNext('/campaigns/../settings'), '/settings')
  assert.equal(safeNext('/..//evil.com'), null)
  assert.equal(safeNext('/./%2e%2e//evil.com'), null)
})

test('loginPath carries the page the user wanted', () => {
  assert.equal(loginPath('/'), '/login')
  assert.equal(loginPath(null), '/login')
  assert.equal(loginPath('/campaigns/x?y=1'), '/login?next=%2Fcampaigns%2Fx%3Fy%3D1')
  assert.equal(loginPath('/login?next=/x'), '/login')
})

test('isPublicPath', () => {
  assert.equal(isPublicPath('/login'), true)
  assert.equal(isPublicPath('/signup'), true)
  assert.equal(isPublicPath('/signups'), false)
  assert.equal(isPublicPath('/connect'), false)
})

test('absoluteUrl resolves app-relative invite links', () => {
  assert.equal(absoluteUrl('/signup?invite=abc', 'https://app.example.com'), 'https://app.example.com/signup?invite=abc')
  assert.equal(absoluteUrl('https://other.example.com/signup?invite=abc', 'https://app.example.com'), 'https://other.example.com/signup?invite=abc')
})
