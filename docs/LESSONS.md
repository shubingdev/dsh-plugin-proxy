# Lessons Learned

Durable lessons from shipping this plugin — read before touching the client bundle.

## 1. `exports.inject` (browser bundle) takes Cordis **service names**, not package names

**Incident (2026-08-21):** the first install of this plugin prevented DSH from
booting: `web boot: 1 entry did not activate dsh-plugin-proxy` — the plugin sat
permanently `pending` because its browser half declared

```js
exports.inject = ["@deepseek-ai/dsh-client-runtime", ...] // WRONG — package names
```

The browser-side Cordis loader waits for **services** by name, so those
packages could never resolve as services and the fiber never activated.

**The two injects are different things:**

| Location | Meaning | Values |
| --- | --- | --- |
| `package.json` → `dsh.client.inject` | module-graph edges (which bundles to load) | **package names** (`@deepseek-ai/dsh-client-*`) |
| `lib/client.js` → `exports.inject` | Cordis service dependencies (which fibers to wait for) | **service names** (`slots`, `configForms`, `locale`, `connection`, `remote`) |

The correct value here is what `apply()` actually uses:

```js
exports.inject = ["slots", "configForms"];
```

(`slots` is provided by `@deepseek-ai/dsh-client-ui-renderer`; `configForms` by
`@deepseek-ai/dsh-client-ui-settings`.)

**Regression guard:** `test/client-shape.mjs` executes `lib/client.js` in a
`vm` and asserts `exports.inject` equals exactly `["slots", "configForms"]`.
Keep that test; extend it if the client starts using another service.

**Reference trap:** the original `dsh-plugin-focus` client bundle also wrote
package names into `exports.inject`. Do not copy that line from it.

## 1b. DSH 0.2.0-rc.2 removed `settingsScope` — use `configForms`

The client-side `settingsScope` service and the plugin-registered settings
namespace are both gone. The replacements:

| 0.1.x | 0.2.0-rc.2 |
| --- | --- |
| `ctx.settingsScope.bind({ namespace })` | `ctx.configForms.get(<profile entry id>)` |
| `scope.getSnapshot()/subscribe()/set()` | same shape on the returned controller |
| server: `installSettingsSection(ctx, ns, Config, entry, hooks)` | fields marked `.volatile()`; the entry's own Config IS the form |
| `settingsNamespace('proxy')` | the profile **entry id** (`id: proxy`) |
| `settings.update(ns, patch)` | unchanged, but `ns` is now the entry id |

Server-side read: a `.volatile()` field resolves to a live reference
(`{ get() }`), so read it with `.get()` — never cache it. On a settings write the
loader commits the new values **into the same references** (no reload) and emits
`loader/volatile-update` on the plugin's fiber; listen for it with
`ctx.on("loader/volatile-update", ...)`.

**Two traps this migration hit:**

1. **No startup sync.** `installSettingsSection` used to fire `hooks.onChange()`
   once on registration, which is what applied the configuration at startup.
   Nothing replaces that automatically — a plugin must call its own sync once,
   or it sits idle until the first edit.
2. **The config seat is not automatic.** The framework does NOT project a
   `.volatile()` Config into a rendered form; the `autoGenerate` flag a form
   reports has **no shipped consumer yet**. A plugin that wants a form occupies
   the `plugins.row.config` keyed slot with key `<package name>#<row id>` —
   a wrong key renders nothing and raises nothing.

### Testing `loader/volatile-update` honestly

The loader does NOT emit broadly. It builds a filtered context and emits it
(`cordis-plugin-loader` → `_commitVolatile`):

```js
const fiber = this.fiber                    // = registry.plugin(...).ctx.fiber
const self = Object.create(fiber.ctx)
self[Context.filter] = (owner) => owner.fiber === fiber
fiber.ctx.emit(self, 'loader/volatile-update', paths)
```

Because of that filter, **`ctx.emit("loader/volatile-update")` from a test is
not evidence**: it reaches listeners the real filtered emission may never
reach, so a plugin that silently never updates in production still passes.
Reproduce the filter, and take `fiber` from `fiber.ctx.fiber`, NOT from the
object `ctx.plugin()` returns (in cordis ≥4.0.4 those are different objects —
the returned handle is a wrapper, and `owner.fiber === returnedFiber` is
`false`, which would make the test fail even though production works).

`test/apply.mjs` → `emitVolatileUpdate()` is the working reference.


## 2. Node 24 test runner: use `node --test test/*.mjs`

`node --test test/` fails on Node 24 (a directory is not a module). The
package script is `node --test test/*.mjs`. Run individual files directly too
when debugging.

## 3. `dsh plugin add` + `--dump-config` is not a boot acceptance test

It verifies the composition tree only. Client-fiber activation (and every
`exports.inject` mistake) only shows up on a real service restart — restart
DSH and check the page for `did not activate` / `pending` before declaring a
client-bearing plugin done.

## Related environment landmine

A profile-level drift of `@deepseek-ai/dsh-tools` (a nested old copy pulled in
by another plugin) crashed DSH with `Cannot read properties of undefined
(reading 'prepare')`. The fix on this machine is the profile
`pnpm-workspace.yaml` override pinning `@deepseek-ai/dsh-tools` to the harness
core link. When adding dependencies, re-check nested `node_modules` for stale
`@deepseek-ai/*` copies.
