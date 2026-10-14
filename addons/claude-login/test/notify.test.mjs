/* ------------------------------------------------------------------ *
 * addons/claude-login — notify.mjs: Telegram when it works, the dashboard
 * banner otherwise, and a "still broken" repeat throttled to once per
 * alarmIntervalMs. A stubbed `fetch`, a real temp state file.
 * Run: node --test addons/claude-login/test/notify.test.mjs
 * ------------------------------------------------------------------ */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { notifyOperator } from '../api/notify.mjs'
import { readState } from '../api/state.mjs'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-login-notify-'))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))
const freshFile = () => path.join(TMP, `${crypto.randomUUID()}.json`)
const ENV = { DASHBOARD_BEARER_TOKEN: 'dash-bearer', API_PORT: '3001' }

function telegramFetch({ ok = true } = {}) {
  const calls = []
  return {
    calls,
    fetch: async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) })
      return { ok, status: ok ? 200 : 503, json: async () => ({ ok }) }
    },
  }
}

test('sends via the telegram loopback route when it works', async () => {
  const file = freshFile()
  const { fetch, calls } = telegramFetch()
  const r = await notifyOperator('hello operator', { env: ENV, fetch, file })
  assert.equal(r.via, 'telegram')
  assert.equal(calls[0].url, 'http://127.0.0.1:3001/api/telegram/send')
  assert.equal(calls[0].body.text, 'hello operator')
})

test('falls back to the dashboard banner when telegram is unreachable', async () => {
  const file = freshFile()
  const { fetch } = telegramFetch({ ok: false })
  const r = await notifyOperator('still broken', { env: ENV, fetch, file })
  assert.equal(r.via, 'banner')
  const state = readState(file)
  assert.equal(state.banner.text, 'still broken')
})

test('falls back to the banner when there is no bearer configured at all (never throws)', async () => {
  const file = freshFile()
  const r = await notifyOperator('no bearer', { env: {}, fetch: async () => { throw new Error('must not be called') }, file })
  assert.equal(r.via, 'banner')
})

test('a repeat notification is throttled to once per alarmIntervalMs', async () => {
  const file = freshFile()
  const { fetch, calls } = telegramFetch()
  await notifyOperator('first', { env: ENV, fetch, file, repeat: true, alarmIntervalMs: 60_000 })
  const r = await notifyOperator('second, too soon', { env: ENV, fetch, file, repeat: true, alarmIntervalMs: 60_000 })
  assert.equal(r.via, 'throttled')
  assert.equal(calls.length, 1, 'the second repeat must not actually send')
})

test('a repeat notification sends again once alarmIntervalMs has passed', async () => {
  const file = freshFile()
  const { fetch, calls } = telegramFetch()
  await notifyOperator('first', { env: ENV, fetch, file, repeat: true, alarmIntervalMs: 1 })
  await new Promise((r) => setTimeout(r, 5))
  const r = await notifyOperator('second, later', { env: ENV, fetch, file, repeat: true, alarmIntervalMs: 1 })
  assert.equal(r.via, 'telegram')
  assert.equal(calls.length, 2)
})

test('a NON-repeat notification is never throttled', async () => {
  const file = freshFile()
  const { fetch, calls } = telegramFetch()
  await notifyOperator('one-off A', { env: ENV, fetch, file })
  await notifyOperator('one-off B', { env: ENV, fetch, file })
  assert.equal(calls.length, 2)
})
