/* ------------------------------------------------------------------ *
 * /proc/net/dev parsing behind GET /api/host's `net` counters (the Jarvis
 * tab's network vitals). The failure this guards is quiet: counting loopback
 * would show box-internal chatter (API ↔ Caddy on every poll) as network
 * traffic, and a column off by one reads packets as bytes. Neither throws.
 *
 * Hermetic: a fixed /proc/net/dev sample, no box state.
 * Run: node --test api/test/host-stats-net.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseNetDev } from '../src/host-stats-routes.mjs'

const SAMPLE = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 9999999    1000    0    0    0     0          0         0  9999999    1000    0    0    0     0       0          0
  eth0: 1500000    2000    0    0    0     0          0         0   700000    1800    0    0    0     0       0          0
tailscale0:  2500     30    0    0    0     0          0         0     4000      40    0    0    0     0       0          0
`

test('sums rx/tx bytes across interfaces and skips loopback', () => {
  assert.deepEqual(parseNetDev(SAMPLE), { rxBytes: 1502500, txBytes: 704000 })
})

test('answers null when nothing parses, instead of a misleading zero', () => {
  assert.equal(parseNetDev(''), null)
  assert.equal(parseNetDev('garbage'), null)
  assert.equal(parseNetDev('    lo: 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16'), null)
})
