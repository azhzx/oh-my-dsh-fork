// Run only inside a disposable, newly installed DSH profile.
// node tests/runtime-smoke.mjs http://127.0.0.1:3101 /path/to/profile
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const [base, profile] = process.argv.slice(2)
assert.ok(base && profile, 'provide Web URL and isolated profile path')
const names = ['dsh-trusted-page', 'dsh-mobile-upgrade', 'dsh-web-startup-auth',
  '@jiesou/dsh-webui-fix-mobile-enter-newline', 'dsh-better-sidebar', 'dsh-codex']
for (const name of names.slice(0, 4)) {
  const dir = join(profile, 'node_modules/oh-my-dsh/plugins', name)
  assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name, name)
  assert.ok(readFileSync(join(dir, 'LICENSE'), 'utf8').length > 100)
}
const request = (path, options = {}) => fetch(new URL(path, base), {
  signal: AbortSignal.timeout(20_000), ...options,
})
const status = await request('/api/auth/status')
assert.equal(status.status, 200)
assert.equal((await status.json()).registered, false, 'smoke test requires fresh credentials')
const password = randomBytes(24).toString('hex')
const register = await request('/api/auth/register', {
  method: 'POST', headers: { 'content-type': 'application/json', origin: base },
  body: JSON.stringify({ username: 'smoke-only', password }),
})
assert.equal(register.status, 200, await register.clone().text())
assert.equal((await register.json()).ok, true)
const cookie = register.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
const signedIn = await request('/api/auth/status', { headers: { cookie } })
assert.equal((await signedIn.json()).session, true)
const page = await request('/', { headers: { cookie } })
assert.equal(page.status, 200)
const html = await page.text()
assert.ok(html.includes('__DSH_BOOT__'))
for (const name of names) assert.ok(html.includes(`${name}/client.js`), `missing client ${name}`)
const match = html.match(/(?:src|href)="(\/plugins\/\?\?[^"\s]+)"/)
assert.ok(match, 'missing combined client URL')
const asset = await request(match[1].replaceAll('&amp;', '&'), { headers: { cookie } })
assert.equal(asset.status, 200)
const code = await asset.text()
for (const name of names) assert.ok(code.includes(name), `missing client code ${name}`)
console.log('Web OK: registration/session, six client entries, combined client HTTP 200')

const require = createRequire(join(profile, 'package.json'))
const pty = require('node-pty')
await new Promise((resolve, reject) => {
  const terminal = pty.spawn('/bin/sh', ['-c', 'printf PTY_SMOKE_OK'], { cols: 80, rows: 24 })
  let output = ''
  const timer = setTimeout(() => { terminal.kill(); reject(new Error('PTY timeout')) }, 10_000)
  terminal.onData(data => { output += data })
  terminal.onExit(({ exitCode }) => {
    clearTimeout(timer)
    try { assert.equal(exitCode, 0); assert.ok(output.includes('PTY_SMOKE_OK')); resolve() }
    catch (error) { reject(error) }
  })
})
console.log('PTY OK: native binding spawned a shell and returned output')
