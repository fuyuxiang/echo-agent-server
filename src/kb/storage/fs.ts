import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = () => process.env.ECHO_KB_STORAGE_ROOT ?? './data/kb-files'

const ID_RE = /^[A-Za-z0-9_-]+$/
const EXT_RE = /^[A-Za-z0-9]{1,8}$/

function assertSafeId(id: string, label: string): void {
  if (!ID_RE.test(id)) throw new Error(`invalid path id ${label}: ${id}`)
}

function assertSafeExt(ext: string): void {
  if (!EXT_RE.test(ext)) throw new Error(`invalid path extension: ${ext}`)
}

export async function saveOriginalFile(
  groupId: string, docId: string, buf: Buffer, ext: string
): Promise<string> {
  assertSafeId(groupId, 'groupId')
  assertSafeId(docId, 'docId')
  assertSafeExt(ext)
  const rel = `${groupId}/${docId}.${ext}`
  const abs = join(ROOT(), rel)
  await mkdir(join(ROOT(), groupId), { recursive: true })
  await writeFile(abs, buf)
  return rel
}

export async function readOriginalFile(
  groupId: string, docId: string, ext: string
): Promise<Buffer> {
  assertSafeId(groupId, 'groupId')
  assertSafeId(docId, 'docId')
  assertSafeExt(ext)
  return readFile(getOriginalPath(groupId, docId, ext))
}

export function getOriginalPath(groupId: string, docId: string, ext: string): string {
  return join(ROOT(), `${groupId}/${docId}.${ext}`)
}
