/**
 * Smoke test: the browser half's export shape, its Cordis service names, and
 * the two slots it occupies. The real risk here is a silent one — a slot key
 * or entry id that does not match what the host dispatches, which renders
 * nothing and raises nothing.
 *
 * Run: `node test/client-shape.mjs`
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

/**
 * Load the browser bundle in a VM with a stubbed module loader and a stubbed
 * cordis context, then run the plugin body.
 * @returns the exports the bundle produced and every slot it registered.
 */
function loadClient() {
  let registration
  const context = vm.createContext({
    window: {
      __ModuleLoader__: {
        load(value) {
          registration = value
        },
      },
    },
  })
  vm.runInContext(clientSource, context)
  assert.equal(registration?.id, 'dsh-plugin-proxy/client')

  const client = registration.factory((specifier) => {
    if (specifier === 'react') {
      return { useSyncExternalStore: () => undefined, createElement: () => undefined }
    }
    throw new Error(`unexpected client external: ${specifier}`)
  })

  const registered = []
  const injected = []
  const ctx = {
    slots: {
      inject(name, register) {
        injected.push(name)
        registered.push(register())
      },
      register(options) {
        return options
      },
    },
    configForms: {
      get(id) {
        return { entryId: id }
      },
    },
  }
  client.apply(ctx)
  return { client, registered, injected }
}

test('browser face injects Cordis service names rather than package names', () => {
  const { client } = loadClient()
  assert.deepEqual(Array.from(client.inject), ['slots', 'configForms'])
})

test('entry id stays in step with the composition row id', async () => {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  // The host keys a settings form by the profile entry id, so the client's
  // PROXY_ENTRY_ID must equal the `id:` this bundle's patch declares.
  const rowId = /^\s*-\s*id:\s*(\S+)\s*$/m.exec(patch)?.[1]
  assert.equal(rowId, 'proxy', 'cordis.patch.yml must mount the row as id: proxy')

  const { registered } = loadClient()
  const key = registered.find((entry) => entry.name === 'plugins.row.config')?.key
  assert.equal(key, `dsh-plugin-proxy#${rowId}`, 'the config seat key is <package>#<row id>')
})

test('registers the sidebar switch and the plugin config page', () => {
  const { registered, injected } = loadClient()

  assert.deepEqual(injected, ['sidebar.footer.action', 'plugins.row.config'])

  const toggle = registered.find((entry) => entry.name === 'sidebar.footer.action')
  assert.equal(toggle?.id, 'proxy-toggle')

  const config = registered.find((entry) => entry.name === 'plugins.row.config')
  assert.equal(config?.key, 'dsh-plugin-proxy#proxy')
})
