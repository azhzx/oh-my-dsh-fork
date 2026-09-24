// Deliberately small tar subset: regular files, directories, and restricted PAX.
// No archive entry is ever extracted to the filesystem.
import { createHash } from 'node:crypto'
import { gunzip } from 'node:zlib'
import { promisify } from 'node:util'

export const MAX_COMPRESSED = 64 * 1024 * 1024
export const MAX_DECOMPRESSED = 256 * 1024 * 1024
export const DOWNLOAD_TIMEOUT_MS = 60_000
const unzip = promisify(gunzip)
const decoder = new TextDecoder('utf-8', { fatal: true })
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

export function safePath(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 ||
      /[\\\x00-\x1f\x7f:]/u.test(value) || value.split('/').some(part =>
        !part || part === '.' || part === '..' || /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error(`Unsafe path: ${JSON.stringify(value)}`)
  }
  return value
}

export function parseSource(source) {
  const match = typeof source === 'string' && /^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([a-f0-9]{40})(?:&path:\/(.+))?$/.exec(source)
  if (!match) throw new Error(`Invalid pinned GitHub source: ${source}`)
  const [, owner, repo, commit, subdir = ''] = match
  safePath(owner); safePath(repo)
  if (subdir) safePath(subdir)
  return { owner, repo, commit, subdir, url: `https://codeload.github.com/${owner}/${repo}/tar.gz/${commit}` }
}

export async function downloadArchive(source, { fetchImpl = globalThis.fetch, timeoutMs = DOWNLOAD_TIMEOUT_MS, maxCompressed = MAX_COMPRESSED } = {}) {
  if (!Number.isSafeInteger(maxCompressed) || maxCompressed < 1 || maxCompressed > MAX_COMPRESSED ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DOWNLOAD_TIMEOUT_MS) throw new Error('Invalid download limits')
  const { url } = parseSource(source)
  const controller = new AbortController()
  let timer
  let reader
  // Promise.race also bounds a stalled/custom body reader, not just response headers.
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('Archive download timeout')) }, timeoutMs)
  })
  try {
    return await Promise.race([deadline, (async () => {
      const response = await fetchImpl(url, { signal: controller.signal, redirect: 'error', headers: { 'Accept-Encoding': 'identity' } })
      controller.signal.throwIfAborted()
      if (response.status !== 200 || !response.body) throw new Error(`Archive download HTTP ${response.status}`)
      const length = response.headers.get('content-length')
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxCompressed)) throw new Error('Archive exceeds compressed limit')
      const encoding = response.headers.get('content-encoding')
      if (encoding && encoding !== 'identity') throw new Error('Unexpected HTTP content encoding')
      reader = response.body.getReader()
      const chunks = []
      let size = 0
      while (true) {
        const { done, value } = await reader.read()
        controller.signal.throwIfAborted()
        if (done) break
        size += value.byteLength
        if (size > maxCompressed) throw new Error('Archive exceeds compressed limit')
        chunks.push(Buffer.from(value))
      }
      if (length !== null && size !== Number(length)) throw new Error('Truncated archive download')
      return Buffer.concat(chunks, size)
    })()])
  } finally {
    clearTimeout(timer)
    controller.abort()
    if (reader) void reader.cancel().catch(() => {})
  }
}

function text(field) {
  const end = field.indexOf(0)
  if (end !== -1 && field.subarray(end).some(byte => byte !== 0)) throw new Error('Invalid tar string padding')
  return decoder.decode(end === -1 ? field : field.subarray(0, end))
}

function octal(field) {
  const value = field.toString('latin1')
  if (!/^[0-7]+[\x00 ]*$/.test(value) && !/^[ ]+[0-7]+[\x00 ]*$/.test(value)) throw new Error('Invalid tar octal field')
  const number = Number.parseInt(value.trim().replace(/\0.*$/, ''), 8)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('Invalid tar size')
  return number
}

function paxRecords(bytes, global) {
  const records = new Map()
  for (let offset = 0; offset < bytes.length;) {
    const space = bytes.indexOf(32, offset)
    if (space < 0 || space - offset > 8) throw new Error('Invalid PAX length')
    const digits = bytes.subarray(offset, space).toString('latin1')
    if (!/^[1-9][0-9]*$/.test(digits)) throw new Error('Invalid PAX length')
    const end = offset + Number(digits)
    if (end > bytes.length || end <= space + 2 || bytes[end - 1] !== 10) throw new Error('Truncated PAX record')
    const record = decoder.decode(bytes.subarray(space + 1, end - 1))
    const equals = record.indexOf('=')
    if (equals < 1 || /[\x00-\x1f\x7f]/u.test(record)) throw new Error('Invalid PAX record')
    const key = record.slice(0, equals), value = record.slice(equals + 1)
    if (records.has(key)) throw new Error('Duplicate PAX key')
    if (!['path', 'comment', 'mtime', 'atime', 'ctime'].includes(key) || (global && key === 'path')) throw new Error(`Unsupported PAX key: ${key}`)
    if (key === 'path') safePath(value.endsWith('/') ? value.slice(0, -1) : value)
    if (['mtime', 'atime', 'ctime'].includes(key) && !/^-?[0-9]+(?:\.[0-9]+)?$/.test(value)) throw new Error('Invalid PAX time')
    records.set(key, value)
    offset = end
  }
  return records
}

export function readTar(tar) {
  if (!Buffer.isBuffer(tar) || tar.length > MAX_DECOMPRESSED || tar.length % 512) throw new Error('Invalid or truncated tar length')
  const entries = new Map()
  let pending = null, root = null, ended = false, count = 0
  for (let offset = 0; offset < tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) {
      if (pending || offset + 1024 > tar.length || tar.subarray(offset).some(byte => byte !== 0)) throw new Error('Invalid tar end marker')
      ended = true
      break
    }
    if (++count > 100_000) throw new Error('Too many tar entries')
    const expected = octal(header.subarray(148, 156))
    let sum = 0
    for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 32 : header[index]
    if (sum !== expected) throw new Error('Tar header checksum mismatch')
    if (!['ustar\0', 'ustar '].includes(header.subarray(257, 263).toString('latin1'))) throw new Error('Unsupported tar format')
    const size = octal(header.subarray(124, 136))
    const end = offset + 512 + size
    const next = offset + 512 + Math.ceil(size / 512) * 512
    if (end > tar.length || next > tar.length) throw new Error('Truncated tar entry')
    if (tar.subarray(end, next).some(byte => byte !== 0)) throw new Error('Invalid tar data padding')
    const body = tar.subarray(offset + 512, end)
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156])
    const prefix = text(header.subarray(345, 500))
    let name = (prefix ? prefix + '/' : '') + text(header.subarray(0, 100))
    safePath(name.endsWith('/') ? name.slice(0, -1) : name)
    if (text(header.subarray(157, 257))) throw new Error('Tar links are forbidden')
    if (type === 'g' || type === 'x') {
      if (pending) throw new Error('Stacked PAX headers are forbidden')
      const records = paxRecords(body, type === 'g')
      if (type === 'x') pending = records
    } else {
      if (type !== '0' && type !== '5') throw new Error(`Unsupported tar entry type: ${type}`)
      if (pending?.has('path')) name = pending.get('path')
      pending = null
      if (type === '5') {
        if (size !== 0) throw new Error('Nonempty tar directory')
        if (name.endsWith('/')) name = name.slice(0, -1)
      }
      safePath(name)
      const top = name.split('/')[0]
      if (root === null) root = top
      if (top !== root || (name === root && type !== '5')) throw new Error('Archive must have one repository root directory')
      if (entries.has(name)) throw new Error(`Duplicate tar path: ${name}`)
      entries.set(name, { type, body })
    }
    offset = next
  }
  if (!ended || !root) throw new Error('Truncated or empty tar archive')
  const files = new Map()
  for (const [name, entry] of entries) {
    const parts = name.split('/')
    for (let i = 1; i < parts.length; i++) {
      if (entries.get(parts.slice(0, i).join('/'))?.type === '0') throw new Error('Tar file/directory collision')
    }
    if (entry.type === '0') files.set(name.slice(root.length + 1), entry.body)
  }
  return files
}

export async function unpackArchive(archive, expectedSha256, { maxDecompressed = MAX_DECOMPRESSED } = {}) {
  if (!Buffer.isBuffer(archive) || archive.length > MAX_COMPRESSED) throw new Error('Archive exceeds compressed limit')
  if (expectedSha256 !== undefined && (!/^[0-9a-f]{64}$/.test(expectedSha256) || sha256(archive) !== expectedSha256)) throw new Error('Archive SHA-256 mismatch')
  if (!Number.isSafeInteger(maxDecompressed) || maxDecompressed < 1 || maxDecompressed > MAX_DECOMPRESSED) throw new Error('Invalid decompressed limit')
  const tar = await unzip(archive, { maxOutputLength: maxDecompressed })
  return readTar(tar)
}
