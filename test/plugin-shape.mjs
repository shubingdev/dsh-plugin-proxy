/**
 * Smoke test: the server plugin's export shape and Config schema against the
 * real @deepseek-ai packages (resolved through node_modules junctions).
 *
 * Run: `node test/plugin-shape.mjs`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config, apply, inject, name } from '../lib/index.js'

/** Read a Config field whether or not the schema wrapped it as volatile. */
const value = (field) => (field !== null && typeof field === 'object' && typeof field.get === 'function' ? field.get() : field)

test('plugin export shape matches the Cordis loader contract', () => {
  assert.equal(name, 'proxy')
  assert.ok(Array.isArray(inject))
  assert.ok(inject.includes('tools'))
  assert.ok(inject.includes('systemPrompt'))
  assert.ok(inject.includes('settings'))
  assert.equal(typeof apply, 'function')
  assert.equal(typeof Config, 'function', 'schemastery schema is callable')
})

test('every user-editable Config field is volatile (so the settings form sees it)', () => {
  const config = Config({})
  for (const field of ['enabled', 'mode', 'customUrl', 'noProxy', 'systemPollMs']) {
    assert.equal(
      typeof config[field]?.get,
      'function',
      `${field} must resolve to a live reference, not a plain value`,
    )
  }
})

test('Config resolves composition defaults', () => {
  const config = Config({})
  assert.equal(value(config.enabled), false)
  assert.equal(value(config.mode), 'system')
  assert.equal(value(config.customUrl), 'http://127.0.0.1:7890')
  assert.equal(value(config.noProxy), 'localhost,127.0.0.1,::1')
  assert.equal(value(config.systemPollMs), 30000)
})

test('Config accepts a full composition entry', () => {
  const config = Config({ enabled: true, mode: 'custom', customUrl: 'http://127.0.0.1:10809', noProxy: 'internal.local' })
  assert.equal(value(config.enabled), true)
  assert.equal(value(config.mode), 'custom')
  assert.equal(value(config.customUrl), 'http://127.0.0.1:10809')
  assert.equal(value(config.noProxy), 'internal.local')
})

test('Config rejects an unknown mode', () => {
  assert.throws(() => Config({ mode: 'banana' }))
})

test('Config rejects a negative poll interval', () => {
  assert.throws(() => Config({ systemPollMs: -1 }))
})
