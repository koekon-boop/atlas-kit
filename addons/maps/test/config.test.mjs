/* ------------------------------------------------------------------ *
 * userAgent(): the one string shared by every outbound call this addon
 * makes (nominatim.mjs, overpass.mjs). Node's fetch/Headers rejects a
 * non-Latin-1 header value with a TypeError — a smart quote or an em-dash
 * in the fallback string breaks EVERY geocode/nearby call the moment
 * ATLAS_MAPS_CONTACT is unset, not just this function. Pinned here so a
 * future edit to the fallback text can't reintroduce that class of bug.
 *
 * Run: node --test addons/maps/test/config.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { userAgent } from '../api/config.mjs'

test('userAgent() is always header-safe (Latin-1/ASCII), with or without ATLAS_MAPS_CONTACT', () => {
  const prev = process.env.ATLAS_MAPS_CONTACT
  try {
    delete process.env.ATLAS_MAPS_CONTACT
    const noContact = userAgent()
    assert.match(noContact, /^atlas-kit-maps-addon\/1\.0/)
    assert.doesNotThrow(() => new Headers({ 'User-Agent': noContact }), 'the no-contact fallback must be a valid header value')
    assert.ok(/^[\x00-\x7f]*$/.test(noContact), 'expected ASCII-only, got a non-ASCII character')

    process.env.ATLAS_MAPS_CONTACT = 'ops@example.com'
    const withContact = userAgent()
    assert.match(withContact, /\(ops@example\.com\)/)
    assert.doesNotThrow(() => new Headers({ 'User-Agent': withContact }))
  } finally {
    if (prev === undefined) delete process.env.ATLAS_MAPS_CONTACT
    else process.env.ATLAS_MAPS_CONTACT = prev
  }
})
