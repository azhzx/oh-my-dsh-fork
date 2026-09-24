// MAINTAINER ONLY. Explicitly trusts fresh HTTPS archive bytes at reviewed commits.
// Never use this command in an install lifecycle: consumers verify, never re-pin.
import { createHash } from 'node:crypto'
import { readFile, writeFile, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { downloadArchive, parseSource, sha256, unpackArchive } from './archive.mjs'
import { MEMBER_NAMES, PROJECT_ROOT, readRegularTree, selectPackage, validateLock } from './install-plugins.mjs'

export async function pinLock(input, { root = PROJECT_ROOT, bootstrap = false, download = downloadArchive } = {}) {
  const lock = structuredClone(input)
  if (bootstrap) {
    if (lock.schemaVersion !== 1 || !Array.isArray(lock.packages) || lock.packages.length !== 4 ||
        new Set(lock.packages.map(p => p.name)).size !== 4 || lock.packages.some(p => !MEMBER_NAMES.includes(p.name))) throw new Error('Bootstrap requires the original schema1 lock and existing plugin trees')
  } else validateLock(lock, { allowUnpinned: true })
  for (const entry of lock.packages) {
    const { subdir } = parseSource(entry.source)
    const archive = await download(entry.source)
    const archiveFiles = await unpackArchive(archive)
    if (bootstrap) {
      const current = await readRegularTree(join(root, 'plugins', entry.name))
      const treeHash = createHash('sha256')
      for (const [path, bytes] of current) treeHash.update(path).update('\0').update(bytes).update('\0')
      if (treeHash.digest('hex') !== entry.sha256) throw new Error(`Original plugin tree differs from schema1 pin: ${entry.name}`)
      entry.files = [...current].map(([path, bytes]) => {
        let sourcePath = subdir ? `${subdir}/${path}` : path
        const rootLicense = entry.name === '@jiesou/dsh-webui-fix-mobile-enter-newline' && path === 'LICENSE' && !archiveFiles.has(sourcePath)
        if (rootLicense) sourcePath = 'LICENSE'
        const upstream = archiveFiles.get(sourcePath)
        if (!upstream || (!upstream.equals(bytes) && !(rootLicense && Buffer.concat([upstream, Buffer.from('\n')]).equals(bytes)))) throw new Error(`Existing bytes do not match upstream: ${entry.name}/${path}`)
        return { path, sourcePath, sha256: sha256(upstream) }
      })
      delete entry.sha256
    } else {
      // The explicit map is authoritative; no vendored tree or npm-pack heuristic.
      for (const file of entry.files) {
        const bytes = archiveFiles.get(file.sourcePath)
        if (!bytes) throw new Error(`Missing upstream mapped file: ${file.sourcePath}`)
        file.sha256 = sha256(bytes)
      }
    }
    entry.archiveSha256 = sha256(archive)
    selectPackage(entry, archiveFiles)
  }
  lock.schemaVersion = 2
  return validateLock(lock)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const temporary = join(PROJECT_ROOT, 'vendor', `.members-${process.pid}.tmp`)
  try {
    const command = process.argv[2]
    if (process.argv.length !== 3 || !['bootstrap', 'repin'].includes(command)) throw new Error('Maintainer-only usage: node scripts/lock-plugins.mjs bootstrap|repin')
    const path = join(PROJECT_ROOT, 'vendor/members.json')
    const lock = await pinLock(JSON.parse(await readFile(path, 'utf8')), { bootstrap: command === 'bootstrap' })
    await writeFile(temporary, JSON.stringify(lock, null, 2) + '\n', { flag: 'wx', mode: 0o644 })
    await rename(temporary, path)
    for (const entry of lock.packages) console.log(`pinned ${entry.name} ${entry.version}: ${entry.files.length} files, archive ${entry.archiveSha256}`)
  } catch (error) {
    console.error(`oh-my-dsh lock: ${error.message}`)
    process.exitCode = 1
  } finally { await rm(temporary, { force: true }) }
}
