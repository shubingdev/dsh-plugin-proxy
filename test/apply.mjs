/**
 * Integration test: mount the real plugin on a Cordis root context with stub
 * services (tools / systemPrompt / settings) and prove the live proxy
 * behavior — a settings write lands in the process env and the global
 * dispatcher without a plugin reload.
 *
 * The settings stub models the DSH ≥0.2 chain faithfully, in three steps:
 *  1. a mounted plugin is handed **raw** config; cordis resolves it through the
 *     plugin's exported `Config`, which wraps every `.volatile()` field into a
 *     live reference (`{ get() }`);
 *  2. `update(entryId, patch)` merges the patch onto the entry's current config
 *     (as `SettingsForms.write` does) and persists it — this is what the
 *     plugin's own `proxy_set` tool calls;
 *  3. the persisted config is re-resolved and each value pushed into the live
 *     references with cosmokit's `updateVolatile`, then `loader/volatile-update`
 *     is emitted on the plugin's fiber — the loader's `_commitVolatile` path,
 *     and the only signal the plugin needs to re-apply itself.
 *
 * Run: `node test/apply.mjs` (needs the @deepseek-ai junctions + undici).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { setGlobalDispatcher, getGlobalDispatcher } from 'undici'
import { updateVolatile } from '@deepseek-ai/cosmokit'
import * as plugin from '../lib/index.js'

const PROXY_ENV = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']
const ENTRY_ID = 'proxy'

/**
 * Emit `loader/volatile-update` exactly as `cordis-plugin-loader` does: on the
 * entry fiber's context, with a filter that keeps only listeners owned by that
 * fiber (`owner.fiber === fiber`, where `fiber` is `registry.plugin(...).ctx.fiber`
 * — NOT the object `ctx.plugin()` returns).
 *
 * Replicating the filter matters: a broad `ctx.emit` would reach the listener
 * even if the loader's filtered emission never did, hiding a plugin that never
 * receives live updates in production.
 * @param fiber - the fiber returned by `ctx.plugin()`.
 */
function emitVolatileUpdate(fiber) {
  const entryFiber = fiber.ctx.fiber
  const self = Object.create(entryFiber.ctx)
  self[Context.filter] = (owner) => owner.fiber === entryFiber
  entryFiber.ctx.emit(self, 'loader/volatile-update', [['config']])
}

function saveEnv() {
  const saved = {}
  for (const key of PROXY_ENV) saved[key] = process.env[key]
  return saved
}

function restoreEnv(saved) {
  for (const key of PROXY_ENV) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
}

/**
 * Build the stub settings service plus a mount helper.
 * @returns the stub service, the persisted patches, and `mount(ctx, raw)`.
 */
function createHarness() {
  /** The persisted profile patch per entry id. */
  const persisted = new Map()
  /** The live references of the mounted plugin, once mounted. */
  let mounted

  const write = (entryId, patch) => {
    // Merge onto the entry's current config — the real `update` merge.
    const current = {}
    for (const [key, reference] of Object.entries(mounted.references)) current[key] = reference.get()
    persisted.set(entryId, { ...(persisted.get(entryId) ?? {}), ...patch })
    // Re-resolve over live + persisted, then commit — `_commitVolatile`.
    const next = plugin.Config({ ...current, ...persisted.get(entryId) })
    for (const [key, reference] of Object.entries(mounted.references)) {
      if (next[key] !== undefined) updateVolatile(reference, next[key])
    }
    emitVolatileUpdate(mounted.fiber)
  }

  const settings = { update: (entryId, patch) => { write(entryId, patch); return Promise.resolve() } }

  return {
    persisted,
    settings,
    /** Simulate the settings UI writing a set of fields. */
    writeFromUi: write,
    /**
     * Mount the plugin with raw composition config and wait for the fiber.
     * @param raw - the raw composition entry config.
     * @returns the fiber and the captured registrations.
     */
    async mount(raw) {
      const tools = []
      const sections = []
      const ctx = new Context()
      ctx.provide('tools', { register: (tool) => { tools.push(tool) } })
      ctx.provide('systemPrompt', { section: (section) => { sections.push(section) } })
      ctx.provide('settings', settings)
      const fiber = ctx.plugin(plugin, raw)
      await fiber
      // Read the references only after the fiber resolved: before that the
      // volatile wrappers do not exist yet, so a commit would write nowhere.
      mounted = { ctx, fiber, references: fiber.config }
      await settle()
      return { ctx, fiber, tools, sections }
    },
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

test('apply() wires tools, prompt section, and live proxy toggling', async () => {
  const savedEnv = saveEnv()
  const defaultDispatcher = getGlobalDispatcher()
  const harness = createHarness()
  try {
    const { ctx, fiber, tools, sections } = await harness.mount({})

    // Tools registered.
    const toolNames = tools.map((tool) => tool.name)
    assert.ok(toolNames.includes('proxy_status'))
    assert.ok(toolNames.includes('proxy_set'))

    // Dynamic system-prompt section registered.
    assert.equal(sections.length, 1)
    assert.equal(sections[0].name, 'proxy:status')
    assert.equal(typeof sections[0].text, 'function')

    // Startup applied the configuration: disabled means env untouched and the
    // dispatcher left alone — but the status must be initialized, not pending.
    assert.equal(process.env.HTTP_PROXY, savedEnv.HTTP_PROXY)
    assert.equal(getGlobalDispatcher(), defaultDispatcher)
    assert.match(sections[0].text(), /Proxy status: OFF/, 'startup must sync, not stay uninitialized')

    // The plugin must NOT have written anything on its own.
    assert.equal(harness.persisted.size, 0)

    // --- Enable the way the settings UI does.
    harness.writeFromUi(ENTRY_ID, { enabled: true, mode: 'custom', customUrl: 'http://127.0.0.1:7890' })
    await settle()

    assert.equal(process.env.HTTP_PROXY, 'http://127.0.0.1:7890')
    assert.equal(process.env.HTTPS_PROXY, 'http://127.0.0.1:7890')
    assert.equal(process.env.NO_PROXY, 'localhost,127.0.0.1,::1')
    assert.notEqual(getGlobalDispatcher(), defaultDispatcher, 'global dispatcher must be swapped while enabled')
    assert.match(sections[0].text(), /Proxy status: ON/)

    // --- Disable through the plugin's own tool (the write-back path). The
    // harness's `update` runs the full persist+commit chain, so the tool's own
    // resync already sees the new value — as it does in production, where
    // `configEditor.edit` awaits the loader reconciliation.
    const setTool = tools.find((tool) => tool.name === 'proxy_set')
    const result = await setTool.execute({ enabled: false })
    assert.equal(result.enabled, false)
    assert.equal(result.active, false)
    assert.deepEqual(harness.persisted.get(ENTRY_ID), {
      enabled: false,
      mode: 'custom',
      customUrl: 'http://127.0.0.1:7890',
    }, 'proxy_set must write only `enabled` and keep the other fields')
    assert.equal(process.env.HTTP_PROXY, savedEnv.HTTP_PROXY, 'disabling must restore the environment')
    assert.equal(getGlobalDispatcher(), defaultDispatcher, 'global dispatcher must be restored when disabled')

    // --- Unload restores everything even when left enabled.
    harness.writeFromUi(ENTRY_ID, { enabled: true, mode: 'custom', customUrl: 'http://127.0.0.1:7890' })
    await settle()
    assert.equal(process.env.HTTP_PROXY, 'http://127.0.0.1:7890')

    fiber.dispose()
    await fiber
    assert.equal(process.env.HTTP_PROXY, savedEnv.HTTP_PROXY)
    assert.equal(getGlobalDispatcher(), defaultDispatcher)
  } finally {
    restoreEnv(savedEnv)
    setGlobalDispatcher(defaultDispatcher)
  }
})

test('an enabled composition entry takes effect at startup without any write', async () => {
  const savedEnv = saveEnv()
  const defaultDispatcher = getGlobalDispatcher()
  const harness = createHarness()
  try {
    const { fiber, sections } = await harness.mount({ enabled: true, mode: 'custom', customUrl: 'http://127.0.0.1:7890' })

    assert.equal(process.env.HTTP_PROXY, 'http://127.0.0.1:7890', 'the composition entry must apply at startup')
    assert.notEqual(getGlobalDispatcher(), defaultDispatcher)
    assert.equal(harness.persisted.size, 0, 'startup must not write the profile')

    fiber.dispose()
    await fiber
    assert.equal(process.env.HTTP_PROXY, savedEnv.HTTP_PROXY)
    assert.equal(getGlobalDispatcher(), defaultDispatcher)
  } finally {
    restoreEnv(savedEnv)
    setGlobalDispatcher(defaultDispatcher)
  }
})

test('mode: none never installs a proxy even with the switch on', async () => {
  const savedEnv = saveEnv()
  const defaultDispatcher = getGlobalDispatcher()
  const harness = createHarness()
  try {
    const { fiber, sections } = await harness.mount({ enabled: true, mode: 'none' })

    assert.equal(getGlobalDispatcher(), defaultDispatcher, 'mode none must leave the dispatcher alone')
    assert.equal(process.env.HTTP_PROXY, savedEnv.HTTP_PROXY)
    assert.match(sections[0].text(), /Proxy status: OFF/)

    fiber.dispose()
    await fiber
  } finally {
    restoreEnv(savedEnv)
    setGlobalDispatcher(defaultDispatcher)
  }
})

test('mode: custom with an unusable URL stays direct and says so', async () => {
  const savedEnv = saveEnv()
  const defaultDispatcher = getGlobalDispatcher()
  const harness = createHarness()
  try {
    // A non-http(s) scheme: `normalizeProxyUrl` accepts a bare `host:port` by
    // prefixing http://, so the value that genuinely cannot be used is one
    // naming another protocol.
    const { fiber, tools } = await harness.mount({ enabled: true, mode: 'custom', customUrl: 'ftp://proxy.local:21' })

    assert.equal(getGlobalDispatcher(), defaultDispatcher, 'an unusable URL must not install a proxy')
    assert.equal(process.env.HTTP_PROXY, savedEnv.HTTP_PROXY)

    const statusTool = tools.find((tool) => tool.name === 'proxy_status')
    const status = await statusTool.execute({})
    assert.equal(status.active, false)
    assert.equal(status.reason, 'invalid-custom-url')

    fiber.dispose()
    await fiber
  } finally {
    restoreEnv(savedEnv)
    setGlobalDispatcher(defaultDispatcher)
  }
})
