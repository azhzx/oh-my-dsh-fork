import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
const sources = JSON.parse(readFileSync(join(root, 'vendor/members.json'), 'utf8'))
const names = ['dsh-trusted-page', 'dsh-mobile-upgrade', 'dsh-web-startup-auth',
  '@jiesou/dsh-webui-fix-mobile-enter-newline']

function gitPaths(...paths) {
  const result = spawnSync('git', ['ls-files', '--', ...paths], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim().split('\n').filter(Boolean)
}
function row(id, name) {
  const entries = [...patch.matchAll(/^\s*- id: ([\w-]+)\s*\n\s*name:\s*(?:'([^']+)'|([^\s]+))\s*$/gm)]
  return entries.filter(e => e[1] === id && (e[2] ?? e[3]) === name).length
}

test('only postinstall materializes plugins; no Git subdependencies or prepare', () => {
  assert.equal(manifest.name, 'oh-my-dsh')
  assert.equal(manifest.private, true)
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.scripts.postinstall, 'node scripts/install-plugins.mjs')
  for (const hook of ['prepare', 'prepack', 'prepublish', 'publish', 'preinstall']) {
    assert.equal(manifest.scripts[hook], undefined, hook)
  }
  assert.equal(manifest.bin, undefined)
  assert.equal(manifest.bundledDependencies, undefined)
  assert.equal(manifest.dependencies['dsh-better-sidebar'], '0.19.1')
  assert.equal(manifest.dependencies['dsh-codex'], '0.3.0')
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.]+)?$/, name)
    assert.ok(!names.includes(name), `duplicate installation of ${name}`)
  }
  for (const name of ['@deepseek-ai/dsh-cmdline', '@deepseek-ai/dsh-credentials',
    '@deepseek-ai/schemastery', 'commander', 'yaml']) assert.ok(manifest.dependencies[name], name)
})

test('repository tracks source metadata but no downloaded plugins or archives', () => {
  assert.deepEqual(gitPaths('plugins', 'node_modules', '*.tgz', '*.tar', '*.tar.gz'), [])
  assert.equal(sources.schemaVersion, 2)
  assert.deepEqual(sources.packages.map(p => p.name).sort(), [...names].sort())
  for (const entry of sources.packages) {
    assert.match(entry.source, /^github:[^#]+#[a-f0-9]{40}(?:&path:\/[^\s]+)?$/)
    assert.match(entry.archiveSha256, /^[a-f0-9]{64}$/)
    const paths = new Set(entry.files.map(f => f.path))
    for (const file of ['package.json', 'cordis.patch.yml', 'LICENSE', ...entry.runtime]) {
      assert.ok(paths.has(file), `${entry.name}: missing ${file}`)
    }
    for (const file of entry.files) assert.match(file.sha256, /^[a-f0-9]{64}$/)
  }
})

test('Git packlist ships scripts and lock, never generated upstream files', () => {
  const pack = spawnSync('npm', ['pack', '--ignore-scripts', '--dry-run', '--json'],
    { cwd: root, encoding: 'utf8' })
  assert.equal(pack.status, 0, pack.stderr)
  const result = JSON.parse(pack.stdout)
  const details = Array.isArray(result) ? result[0] : result[manifest.name]
  const paths = new Set(details.files.map(({ path }) => path))
  assert.deepEqual(details.bundled ?? [], [])
  for (const name of ['package.json', 'cordis.patch.yml', 'THIRD_PARTY_NOTICES.md',
    'scripts/install-plugins.mjs', 'scripts/archive.mjs', 'vendor/members.json']) assert.ok(paths.has(name), name)
  assert.ok(![...paths].some(path => /^(plugins|node_modules|tests|bin)\//.test(path) || /\.(tgz|tar|gz)$/.test(path)))
  assert.ok(!paths.has('scripts/lock-plugins.mjs'))
})

test('all mandatory plugins and only Codex Web main are mounted once', () => {
  for (const [id, name] of Object.entries({
    'llm-openai-codex': 'dsh-codex',
    'dsh-trusted-page': './plugins/dsh-trusted-page/lib/index.js',
    'dsh-mobile-upgrade': './plugins/dsh-mobile-upgrade/lib/index.js',
    'dsh-web-startup-auth': './plugins/dsh-web-startup-auth/lib/index.js',
    'remote-web-startup': './plugins/auth-startup/index.js',
    'web-auth': './plugins/auth-guard/index.js',
    'mobile-enter-newline': './plugins/@jiesou/dsh-webui-fix-mobile-enter-newline/index.mjs',
    'better-sidebar': 'dsh-better-sidebar',
  })) assert.equal(row(id, name), 1, `${id} → ${name}`)
  assert.doesNotMatch(patch, /dsh-codex\/tui|id: openai-codex-tui|id: agent-default-model|id: web\n/)
  assert.match(patch, /^- id: web-startup\n  disabled: true$/m)
  assert.match(patch, /^- id: connection\n  inject: \[webServer, webRuntime, webAuth\]$/m)
  assert.match(patch, /id: better-sidebar\n\s+name: dsh-better-sidebar\n\s+disabled: !!js/)
})

test('upstream notice stays in third-party notices, not the project README', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  assert.doesNotMatch(readme, /NOTICE: This software includes code generated by artificial intelligence/)
  assert.match(readme, /dsh plugin --profile web add github:KeqingMoe\/oh-my-dsh\n/)
  assert.doesNotMatch(readme, /experiment\/|尚未合并/)
  const notices = readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8')
  assert.match(notices, /NOTICE: This software includes code generated by artificial intelligence/)
  assert.match(notices, /GLM 4\.6 \/ 5\.3-Flash/)
  for (const name of ['bin/oh-my-dsh.ts', 'bin/wizard.ts', 'bin/manifest.ts', 'scripts/update-bundled.mjs']) {
    assert.equal(existsSync(join(root, name)), false, name)
  }
})
