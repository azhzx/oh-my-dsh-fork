// Postinstall downloads only reviewed bytes. Never runs git, npm, tar, or upstream code.
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { downloadArchive, parseSource, safePath, sha256, unpackArchive } from './archive.mjs'

export { downloadArchive } from './archive.mjs'
export const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const MEMBER_NAMES = [
  'dsh-trusted-page', 'dsh-mobile-upgrade', 'dsh-web-startup-auth',
  '@jiesou/dsh-webui-fix-mobile-enter-newline',
]
const digestPattern = /^[0-9a-f]{64}$/

export function validateLock(lock, { allowUnpinned = false } = {}) {
  if (lock?.schemaVersion !== 2 || !Array.isArray(lock.packages) || lock.packages.length !== MEMBER_NAMES.length ||
      new Set(lock.packages.map(entry => entry?.name)).size !== MEMBER_NAMES.length) throw new Error('Invalid schema2 plugin lock')
  for (const entry of lock.packages) {
    if (!MEMBER_NAMES.includes(entry.name) || typeof entry.version !== 'string' || !entry.version ||
        !Array.isArray(entry.runtime) || !entry.runtime.includes('LICENSE') ||
        !Array.isArray(entry.files) || !entry.files.length || (!allowUnpinned && !digestPattern.test(entry.archiveSha256))) throw new Error(`Invalid locked package: ${entry.name}`)
    const { subdir } = parseSource(entry.source)
    const paths = new Set(), sourcePaths = new Set()
    for (const file of entry.files) {
      safePath(file.path); safePath(file.sourcePath)
      if (paths.has(file.path) || sourcePaths.has(file.sourcePath) || (!allowUnpinned && !digestPattern.test(file.sha256))) throw new Error(`Invalid/duplicate file map: ${entry.name}/${file.path}`)
      // Only the repository-root license may be selected outside the package subdirectory.
      if (subdir && !file.sourcePath.startsWith(subdir + '/') && !(file.path === 'LICENSE' && file.sourcePath === 'LICENSE')) throw new Error(`Source file outside package: ${file.sourcePath}`)
      paths.add(file.path); sourcePaths.add(file.sourcePath)
    }
    for (const path of paths) {
      const parts = path.split('/')
      for (let i = 1; i < parts.length; i++) if (paths.has(parts.slice(0, i).join('/'))) throw new Error(`File/directory collision: ${path}`)
    }
    if (new Set(entry.runtime).size !== entry.runtime.length) throw new Error('Duplicate runtime path')
    if (entry.name === 'dsh-web-startup-auth' && ['lib/startup.js', 'lib/auth.js'].some(path => !entry.runtime.includes(path))) throw new Error('Missing authentication wrapper runtime target')
    for (const path of ['package.json', 'cordis.patch.yml', ...entry.runtime]) {
      safePath(path)
      if (!paths.has(path)) throw new Error(`Missing locked runtime: ${entry.name}/${path}`)
    }
  }
  return lock
}

export async function loadLock(root = PROJECT_ROOT) {
  return validateLock(JSON.parse(await readFile(join(root, 'vendor/members.json'), 'utf8')))
}

export function validatePackage(entry, files) {
  const bytes = files.get('package.json')
  if (!bytes) throw new Error(`Missing manifest: ${entry.name}`)
  const pkg = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (pkg.name !== entry.name || pkg.version !== entry.version || pkg.type !== 'module' ||
      pkg.dsh?.client?.platform !== 'web' || !pkg.dsh?.bundle?.patch || !pkg.exports?.['./client']) throw new Error(`Package identity/version/web client mismatch: ${entry.name}`)
  if (pkg.dsh.client.inject !== undefined && (!Array.isArray(pkg.dsh.client.inject) || pkg.dsh.client.inject.some(value => typeof value !== 'string'))) throw new Error('Invalid client injection manifest')
  function target(value) {
    if (typeof value !== 'string' || !value.startsWith('./')) throw new Error(`Invalid package export in ${entry.name}`)
    const path = safePath(value.slice(2))
    if (!files.has(path)) throw new Error(`Missing manifest target: ${entry.name}/${path}`)
    return path
  }
  function exportsList(value) {
    if (typeof value === 'string') return [target(value)]
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Unsupported package export in ${entry.name}`)
    return Object.values(value).flatMap(exportsList)
  }
  exportsList(pkg.exports)
  const clients = exportsList(pkg.exports['./client']).filter(path => !path.endsWith('.d.ts'))
  const hosts = pkg.main ? [target(pkg.main.startsWith('./') ? pkg.main : './' + pkg.main)] : exportsList(pkg.exports['.']).filter(path => !path.endsWith('.d.ts'))
  if (!clients.length || !hosts.length || [...clients, ...hosts].some(path => !entry.runtime.includes(path))) throw new Error(`Runtime omits host/client entry: ${entry.name}`)
  target(pkg.dsh.bundle.patch)
  if (pkg.types) target(pkg.types.startsWith('./') ? pkg.types : './' + pkg.types)
  for (const path of entry.runtime) if (!files.has(path)) throw new Error(`Missing runtime: ${entry.name}/${path}`)
  return pkg
}

export function selectPackage(entry, archiveFiles, { verifyHashes = true } = {}) {
  const selected = new Map()
  for (const file of entry.files) {
    const bytes = archiveFiles.get(file.sourcePath)
    if (!bytes) throw new Error(`Missing archive file: ${entry.name}/${file.sourcePath}`)
    if (verifyHashes && sha256(bytes) !== file.sha256) throw new Error(`File SHA-256 mismatch: ${entry.name}/${file.path}`)
    selected.set(file.path, bytes)
  }
  validatePackage(entry, selected)
  return selected
}

export function wrapperFiles() {
  const files = new Map()
  for (const [directory, target] of [['auth-startup', 'startup'], ['auth-guard', 'auth']]) {
    files.set(`${directory}/package.json`, Buffer.from(JSON.stringify({ name: `oh-my-dsh-${directory}`, private: true, type: 'module', main: './index.js' }, null, 2) + '\n'))
    files.set(`${directory}/index.js`, Buffer.from(`export * from '../dsh-web-startup-auth/lib/${target}.js'\n`))
  }
  return files
}

export async function readRegularTree(directory) {
  const files = new Map()
  async function walk(base, prefix) {
    if (!(await lstat(base)).isDirectory()) throw new Error(`Expected regular directory: ${base}`)
    for (const name of (await readdir(base)).sort()) {
      const path = safePath(prefix + name), full = join(base, name)
      const info = await lstat(full)
      if (info.isDirectory()) await walk(full, path + '/')
      else if (info.isFile()) files.set(path, await readFile(full))
      else throw new Error(`Symlink or special installed file: ${path}`)
    }
  }
  await walk(directory, '')
  return files
}

export async function checkInstalled({ root = PROJECT_ROOT, lock, pluginsDir } = {}) {
  lock = validateLock(lock ?? await loadLock(root))
  const actual = await readRegularTree(pluginsDir ?? join(root, 'plugins'))
  const expected = new Set()
  for (const entry of lock.packages) {
    const selected = new Map()
    for (const file of entry.files) {
      const path = `${entry.name}/${file.path}`, bytes = actual.get(path)
      if (!bytes || sha256(bytes) !== file.sha256) throw new Error(`Missing or tampered installed file: ${path}`)
      selected.set(file.path, bytes); expected.add(path)
    }
    validatePackage(entry, selected)
  }
  for (const [path, bytes] of wrapperFiles()) {
    if (!actual.get(path)?.equals(bytes)) throw new Error(`Missing or tampered auth wrapper: ${path}`)
    expected.add(path)
  }
  for (const path of actual.keys()) if (!expected.has(path)) throw new Error(`Unexpected installed file: ${path}`)
  return lock
}

async function materialize(base, files) {
  for (const [path, bytes] of files) {
    safePath(path)
    const full = join(base, path)
    await mkdir(dirname(full), { recursive: true, mode: 0o755 })
    await writeFile(full, bytes, { flag: 'wx', mode: 0o644 })
  }
}

export async function installPlugins({ root = PROJECT_ROOT, lock, download = downloadArchive, renameImpl = rename } = {}) {
  root = resolve(root)
  lock = validateLock(lock ?? await loadLock(root))
  const mutex = join(root, '.oh-my-dsh-install.lock')
  // Exclusive per-root writer. This two-rename swap is NOT crash-atomic: SIGKILL
  // can leave plugins absent and the old tree in .oh-my-dsh-install-*/previous.
  // After confirming no installer is active, recover that backup if needed and
  // remove the stale mutex manually. Never automatically delete a recovery copy.
  try { await mkdir(mutex, { mode: 0o700 }) }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('EEXIST: installer lock exists. If interrupted, confirm no installer is running; inspect .oh-my-dsh-install-*/previous for recovery, then remove stale .oh-my-dsh-install.lock and retry.')
    throw error
  }
  let temp, preserveBackup = false
  try {
    temp = await mkdtemp(join(root, '.oh-my-dsh-install-'))
    const stage = join(temp, 'plugins'), destination = join(root, 'plugins'), backup = join(temp, 'previous')
    await mkdir(stage, { mode: 0o755 })
    for (const entry of lock.packages) {
      const archive = await download(entry.source)
      const files = selectPackage(entry, await unpackArchive(archive, entry.archiveSha256))
      await materialize(join(stage, entry.name), files)
    }
    await materialize(stage, wrapperFiles())
    await checkInstalled({ root, lock, pluginsDir: stage })
    let hadPrevious = false
    try {
      const stat = await lstat(destination)
      if (!stat.isDirectory()) throw new Error('Existing plugins path is not a regular directory')
      hadPrevious = true
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (hadPrevious) await renameImpl(destination, backup)
    try {
      await renameImpl(stage, destination)
    } catch (error) {
      if (hadPrevious) {
        try { await renameImpl(backup, destination) }
        catch (rollbackError) {
          preserveBackup = true
          throw new AggregateError([error, rollbackError], `Install and rollback failed; previous installation retained at ${backup}`)
        }
      }
      throw error
    }
    return lock
  } finally {
    try { if (temp && !preserveBackup) await rm(temp, { recursive: true, force: true }) }
    finally { await rm(mutex, { recursive: true, force: true }) }
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    if (process.argv.length > 3) throw new Error('Usage: node scripts/install-plugins.mjs [install|check]')
    const command = process.argv[2] ?? 'install'
    const lock = command === 'install' ? await installPlugins() : command === 'check' ? await checkInstalled() : null
    if (!lock) throw new Error('Usage: node scripts/install-plugins.mjs [install|check]')
    for (const entry of lock.packages) console.log(`verified ${entry.name} ${entry.version}`)
  } catch (error) {
    console.error(`oh-my-dsh: ${error.message}`)
    console.error('Plugin verification/install failed. Fix the reported network or integrity problem, then rerun: node scripts/install-plugins.mjs install')
    process.exitCode = 1
  }
}
