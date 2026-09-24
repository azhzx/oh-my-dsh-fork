import test from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { downloadArchive, MAX_COMPRESSED, parseSource, readTar, safePath, sha256, unpackArchive } from '../scripts/archive.mjs'
import { checkInstalled, installPlugins, MEMBER_NAMES, selectPackage, validateLock, wrapperFiles } from '../scripts/install-plugins.mjs'
import { pinLock } from '../scripts/lock-plugins.mjs'

function header(name, bytes = Buffer.alloc(0), type = '0', link = '') {
  const result = Buffer.alloc(512)
  result.write(name, 0, 100)
  result.write('0000644\0', 100)
  result.write('0000000\0', 108); result.write('0000000\0', 116)
  result.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124)
  result.write('00000000000\0', 136)
  result.fill(32, 148, 156)
  result.write(type, 156); result.write(link, 157, 100)
  result.write('ustar\0', 257); result.write('00', 263)
  result.write([...result].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148)
  return result
}
function tar(entries) {
  return Buffer.concat([...entries.flatMap(([name, value = '', type = '0', link = '']) => {
    const bytes = Buffer.from(value)
    return [header(name, bytes, type, link), bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]
  }), Buffer.alloc(1024)])
}
function pax(key, value) {
  const record = `${key}=${value}\n`
  let length = Buffer.byteLength(record) + 2
  while (length !== Buffer.byteLength(record) + String(length).length + 1) length = Buffer.byteLength(record) + String(length).length + 1
  return `${length} ${record}`
}
function fixture() {
  const archives = new Map()
  const packages = MEMBER_NAMES.map((name, index) => {
    const source = `github:example/repo${index}#${String(index).repeat(40)}`
    const files = new Map([
      ['package.json', JSON.stringify({ name, version: '1.0.0', type: 'module', main: 'lib/index.js', exports: { '.': './lib/index.js', './client': './lib/client.js' }, dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } }, scripts: { postinstall: 'THIS MUST NEVER RUN' } })],
      ['LICENSE', 'exact upstream license without newline'], ['cordis.patch.yml', '[]\n'],
      ['lib/index.js', 'export const host = true\n'], ['lib/client.js', 'export const client = true\n'],
      ['lib/startup.js', 'export const startup = true\n'], ['lib/auth.js', 'export const auth = true\n'],
    ])
    const archive = gzipSync(tar([['repo/', '', '5'], ...[...files].map(([path, value]) => ['repo/' + path, value])]))
    archives.set(source, archive)
    return { name, version: '1.0.0', source, runtime: ['lib/index.js', 'lib/client.js', 'LICENSE', ...(name === 'dsh-web-startup-auth' ? ['lib/startup.js', 'lib/auth.js'] : [])], archiveSha256: sha256(archive), files: [...files].map(([path, bytes]) => ({ path, sourcePath: path, sha256: sha256(bytes) })) }
  })
  return { lock: { schemaVersion: 2, packages }, download: async source => archives.get(source), archives }
}
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'oh-my-dsh-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

// The tar reader validates the ENTIRE archive, not only selected package files.
test('tar reader accepts regular files, directories, and restricted codeload PAX', () => {
  const bytes = tar([
    ['pax_global_header', pax('comment', 'a'.repeat(40)), 'g'],
    ['repo/', '', '5'], ['repo/dir/', '', '5'],
    ['repo/pax', pax('path', 'repo/dir/许可证.txt') + pax('mtime', '1.25'), 'x'],
    ['repo/placeholder', 'license'], ['repo/file', 'hello'],
  ])
  const files = readTar(bytes)
  assert.equal(files.get('dir/许可证.txt').toString(), 'license')
  assert.equal(files.get('file').toString(), 'hello')
  assert.equal(files.size, 2)
})

test('tar rejects traversal, absolute, Windows, ambiguous and control paths', () => {
  for (const path of ['../escape', '/tmp/escape', 'repo/../escape', 'repo/./file', 'repo//file', 'repo\\escape', 'C:/escape', 'repo/bad\nname', 'repo/con', 'repo/alias.']) {
    assert.throws(() => readTar(tar([[path, 'evil']])), /Unsafe path/, path)
  }
  for (const value of ['', '.', '..', '/x', 'a//b', 'a\\b', 'a\0b']) assert.throws(() => safePath(value))
})

test('tar rejects links and every unsupported special entry even when unselected', () => {
  for (const type of ['1', '2', '3', '4', '6', '7', 'L', 'K', 'S']) {
    assert.throws(() => readTar(tar([['repo/', '', '5'], ['repo/unsafe', '', type]])), /Unsupported tar entry/)
  }
  assert.throws(() => readTar(tar([['repo/file', '', '0', '../outside']])), /links are forbidden/)
})

test('tar verifies checksums, octal size, padding, truncation, roots and collisions', () => {
  const valid = tar([['repo/file', 'abc']])
  const broken = Buffer.from(valid); broken[0] ^= 1
  assert.throws(() => readTar(broken), /checksum/)
  assert.throws(() => readTar(valid.subarray(0, valid.length - 1)), /truncated/)
  assert.throws(() => readTar(valid.subarray(0, 1024)), /Truncated/)
  assert.throws(() => readTar(valid.subarray(0, 1536)), /end marker/)
  const badPadding = Buffer.from(valid); badPadding[516] = 1
  assert.throws(() => readTar(badPadding), /padding/)
  const badEnd = Buffer.from(valid); badEnd[1536] = 1
  assert.throws(() => readTar(badEnd), /end marker/)
  assert.throws(() => readTar(tar([['repo/file', 'a'], ['repo/file', 'b']])), /Duplicate/)
  assert.throws(() => readTar(tar([['repo/file', 'a'], ['repo/file/child', 'b']])), /collision/)
  assert.throws(() => readTar(tar([['repo/file', 'a'], ['other/file', 'b']])), /one repository root/)
  assert.throws(() => readTar(tar([['repo/', 'bad', '5']])), /Nonempty/)
  const badSize = header('repo/file'); badSize[124] = 0x80; badSize.fill(32, 148, 156)
  badSize.write([...badSize].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148)
  assert.throws(() => readTar(Buffer.concat([badSize, Buffer.alloc(1024)])), /octal/)
  const tooBig = header('repo/file', Buffer.alloc(2048))
  assert.throws(() => readTar(Buffer.concat([tooBig, Buffer.alloc(1024)])), /Truncated/)
})

test('PAX cannot override sizes, link paths, global paths or introduce unsafe names', () => {
  for (const [key, value, type] of [['size', '999', 'x'], ['linkpath', '../evil', 'x'], ['path', 'repo/good', 'g'], ['path', 'repo/../evil', 'x'], ['GNU.sparse.map', '0,1', 'x']]) {
    assert.throws(() => readTar(tar([['pax', pax(key, value), type], ['repo/file', 'x']])), /PAX|Unsafe/)
  }
  assert.throws(() => readTar(tar([['pax', '999 path=repo/file\n', 'x']])), /Truncated PAX/)
  assert.throws(() => readTar(tar([['pax', pax('path', 'repo/a') + pax('path', 'repo/b'), 'x']])), /Duplicate PAX/)
  assert.throws(() => readTar(tar([['pax', pax('path', 'repo/a'), 'x']])), /end marker/)
  assert.throws(() => readTar(tar([['pax', pax('path', 'repo/a'), 'x'], ['pax2', pax('path', 'repo/b'), 'x']])), /Stacked/)
})

test('gzip is bounded and archive SHA-256 is checked before decompression', async () => {
  const archive = gzipSync(tar([['repo/file', 'hello']]))
  assert.equal((await unpackArchive(archive, sha256(archive))).get('file').toString(), 'hello')
  await assert.rejects(unpackArchive(archive, '0'.repeat(64)), /Archive SHA-256/)
  await assert.rejects(unpackArchive(Buffer.from('not gzip'), '0'.repeat(64)), /Archive SHA-256/)
  await assert.rejects(unpackArchive(archive.subarray(0, archive.length - 5)))
  await assert.rejects(unpackArchive(archive, sha256(archive), { maxDecompressed: 512 }))
  await assert.rejects(unpackArchive(Buffer.alloc(MAX_COMPRESSED + 1)), /compressed limit/)
})

test('fetch only uses pinned codeload HTTPS and rejects HTTP failures/redirects/oversize', async () => {
  const source = fixture().lock.packages[0].source
  let options
  const result = await downloadArchive(source, { fetchImpl: async (url, opts) => {
    assert.match(url, /^https:\/\/codeload.github.com\/example\/repo0\/tar.gz\/[0-9a-f]{40}$/)
    options = opts
    return new Response('abc', { headers: { 'content-length': '3' } })
  } })
  assert.equal(result.toString(), 'abc'); assert.equal(options.redirect, 'error')
  for (const response of [new Response('', { status: 404 }), new Response('', { status: 302 }), new Response('abc', { headers: { 'content-length': '4' } }), new Response('abc', { headers: { 'content-encoding': 'gzip' } })]) {
    await assert.rejects(downloadArchive(source, { fetchImpl: async () => response }))
  }
  await assert.rejects(downloadArchive(source, { maxCompressed: 2, fetchImpl: async () => new Response('abc') }), /compressed limit/)
  await assert.rejects(downloadArchive(source, { maxCompressed: 2, fetchImpl: async () => new Response('', { headers: { 'content-length': '3' } }) }), /compressed limit/)
  await assert.rejects(downloadArchive(source, { timeoutMs: 10, fetchImpl: async () => new Promise(() => {}) }), /timeout/)
  const stalled = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])) } }))
  await assert.rejects(downloadArchive(source, { timeoutMs: 10, fetchImpl: async () => stalled }), /timeout/)
  for (const source of ['https://evil.test/archive', 'github:a/b#main', `github:a/b#${'a'.repeat(40)}&path:/../evil`]) assert.throws(() => parseSource(source))
})

test('lock and selected files fail closed on missing files, digests and identity', async () => {
  const { lock, archives } = fixture()
  validateLock(lock)
  const entry = lock.packages[0]
  const files = await unpackArchive(archives.get(entry.source), entry.archiveSha256)
  assert.equal(selectPackage(entry, files).size, entry.files.length)
  const badHash = structuredClone(entry); badHash.files[0].sha256 = '0'.repeat(64)
  assert.throws(() => selectPackage(badHash, files), /File SHA-256/)
  const missing = new Map(files); missing.delete('LICENSE')
  assert.throws(() => selectPackage(entry, missing), /Missing archive file/)
  assert.throws(() => selectPackage({ ...entry, version: '2.0.0' }, files), /identity\/version/)
  for (const modify of [
    copy => { copy.schemaVersion = 1 },
    copy => { copy.packages.pop() },
    copy => { copy.packages[0].files[0].path = '../evil' },
    copy => { copy.packages[0].files.push(copy.packages[0].files[0]) },
    copy => { copy.packages[0].archiveSha256 = '' },
    copy => { copy.packages[0].runtime.push('missing.js') },
    copy => { copy.packages[0].files.push({ path: 'lib', sourcePath: 'lib', sha256: 'a'.repeat(64) }) },
  ]) {
    const copy = structuredClone(lock); modify(copy); assert.throws(() => validateLock(copy))
  }
  for (const mutation of [pkg => { pkg.name = 'wrong' }, pkg => { pkg.dsh.client.platform = 'tui' }, pkg => { pkg.exports['./client'] = './missing.js' }]) {
    const changed = new Map(files), pkg = JSON.parse(changed.get('package.json'))
    mutation(pkg); changed.set('package.json', Buffer.from(JSON.stringify(pkg)))
    assert.throws(() => selectPackage(entry, changed, { verifyHashes: false }))
  }
})

test('installation stages all four, checks exact bytes and detects missing/tampered/extra files', async t => {
  const root = await temporary(t), { lock, download } = fixture()
  await installPlugins({ root, lock, download })
  await checkInstalled({ root, lock })
  const names = []
  for (const directory of ['auth-startup', 'auth-guard']) {
    const pkg = JSON.parse(await readFile(join(root, 'plugins', directory, 'package.json')))
    assert.equal(pkg.dsh?.client, undefined); names.push(pkg.name)
  }
  assert.equal(new Set(names).size, 2)
  assert.equal((await readFile(join(root, 'plugins', lock.packages[0].name, 'LICENSE'))).at(-1), 'e'.charCodeAt(0))
  const path = join(root, 'plugins', lock.packages[0].name, 'lib/index.js')
  await writeFile(path, 'tampered')
  await assert.rejects(checkInstalled({ root, lock }), /tampered/)
  await installPlugins({ root, lock, download }) // Reinstall verifies fresh downloads and repairs, never bypasses.
  await rm(path)
  await assert.rejects(checkInstalled({ root, lock }), /Missing/)
  await installPlugins({ root, lock, download })
  await writeFile(join(root, 'plugins', 'unexpected.js'), 'bad')
  await assert.rejects(checkInstalled({ root, lock }), /Unexpected/)
  await rm(join(root, 'plugins', 'unexpected.js'))
  await writeFile(join(root, 'plugins/auth-startup/index.js'), 'tampered wrapper')
  await assert.rejects(checkInstalled({ root, lock }), /wrapper/)
})

test('fourth download/hash/manifest failure preserves complete existing installation and removes staging', async t => {
  const root = await temporary(t), { lock, download } = fixture()
  await mkdir(join(root, 'plugins')); await writeFile(join(root, 'plugins/sentinel'), 'previous installation')
  for (const fail of ['network', 'archive', 'file', 'manifest']) {
    const copy = structuredClone(lock)
    if (fail === 'file') copy.packages[3].files[0].sha256 = '0'.repeat(64)
    if (fail === 'manifest') copy.packages[3].version = '9.9.9'
    let calls = 0
    await assert.rejects(installPlugins({ root, lock: copy, download: async source => {
      calls++
      if (calls === 4 && fail === 'network') throw new Error('offline')
      if (calls === 4 && fail === 'archive') return Buffer.from('wrong archive')
      return download(source)
    } }))
    assert.equal(calls, 4)
    assert.equal(await readFile(join(root, 'plugins/sentinel'), 'utf8'), 'previous installation')
    assert.deepEqual(await readdir(root), ['plugins'])
  }
})

test('failed final rename rolls back; failed rollback preserves backup for recovery', async t => {
  for (const rollbackFails of [false, true]) {
    const root = await temporary(t), { lock, download } = fixture()
    await mkdir(join(root, 'plugins')); await writeFile(join(root, 'plugins/sentinel'), 'old')
    let calls = 0
    await assert.rejects(installPlugins({ root, lock, download, renameImpl: async (...args) => {
      calls++
      if (calls === 2 || (rollbackFails && calls === 3)) throw new Error('simulated rename failure')
      return rename(...args)
    } }), rollbackFails ? /previous installation retained/ : /simulated rename failure/)
    if (rollbackFails) {
      const temp = (await readdir(root)).find(name => name.startsWith('.oh-my-dsh-install-'))
      assert.equal(await readFile(join(root, temp, 'previous/sentinel'), 'utf8'), 'old')
    } else {
      assert.equal(await readFile(join(root, 'plugins/sentinel'), 'utf8'), 'old')
      assert.deepEqual(await readdir(root), ['plugins'])
    }
  }
})

test('symlinked installation and concurrent writer fail closed', async t => {
  const root = await temporary(t), outside = await temporary(t), { lock, download } = fixture()
  await symlink(outside, join(root, 'plugins'), 'dir')
  await assert.rejects(checkInstalled({ root, lock }), /regular directory/)
  await assert.rejects(installPlugins({ root, lock, download }), /regular directory/)
  assert.deepEqual(await readdir(outside), [])
  await rm(join(root, 'plugins'))
  await installPlugins({ root, lock, download })
  await symlink(outside, join(root, 'plugins/unsafe'), 'dir')
  await assert.rejects(checkInstalled({ root, lock }), /Symlink/)
  await mkdir(join(root, '.oh-my-dsh-install.lock'))
  let downloaded = false
  await assert.rejects(installPlugins({ root, lock, download: async () => { downloaded = true } }), /EEXIST/)
  assert.equal(downloaded, false)
})

test('maintainer re-pin uses explicit maps without installed trees and enforces manifest identity', async t => {
  const root = await temporary(t), { lock, download } = fixture()
  const edited = structuredClone(lock)
  for (const pkg of edited.packages) {
    delete pkg.archiveSha256
    for (const file of pkg.files) delete file.sha256
  }
  assert.deepEqual(await pinLock(edited, { root, download }), lock)
  assert.deepEqual(await readdir(root), [])
  edited.packages[0].version = '2.0.0'
  await assert.rejects(pinLock(edited, { root, download }), /identity\/version/)
})

test('scripts import without side effects and CLIs reject unsupported commands', async t => {
  const root = await temporary(t)
  for (const file of ['archive.mjs', 'install-plugins.mjs', 'lock-plugins.mjs']) {
    const url = new URL('../scripts/' + file, import.meta.url)
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url.href)})`], { cwd: root, encoding: 'utf8' })
    assert.equal(imported.status, 0, imported.stderr)
    assert.equal(imported.stdout, '')
  }
  assert.deepEqual(await readdir(root), [])
  for (const file of ['install-plugins.mjs', 'lock-plugins.mjs']) {
    const result = spawnSync(process.execPath, [new URL('../scripts/' + file, import.meta.url).pathname, 'invalid'], { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 1); assert.match(result.stderr, /usage/i)
  }
  assert.equal(wrapperFiles().size, 4)
})
