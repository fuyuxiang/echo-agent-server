import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { saveOriginalFile, readOriginalFile, getOriginalPath } from '../../src/kb/storage/fs.js'

describe('kb storage fs', () => {
  let root: string
  beforeEach(() => {
    root = join(tmpdir(), `kb-fs-${Date.now()}-${Math.random()}`)
    process.env.ECHO_KB_STORAGE_ROOT = root
  })
  afterEach(() => { if (existsSync(root)) rmSync(root, { recursive: true }) })

  it('saves and reads back original file under groupId/docId', async () => {
    const buf = Buffer.from('hello world')
    const relPath = await saveOriginalFile('g1', 'd1', buf, 'txt')
    expect(relPath).toBe('g1/d1.txt')
    expect(await readOriginalFile('g1', 'd1', 'txt')).toEqual(buf)
    expect(getOriginalPath('g1', 'd1', 'txt')).toBe(join(root, 'g1/d1.txt'))
  })

  it('refuses path traversal in groupId or docId', async () => {
    await expect(saveOriginalFile('../etc', 'd1', Buffer.from('x'), 'txt')).rejects.toThrow(/path/)
    await expect(saveOriginalFile('g1', '..%2Fpasswd', Buffer.from('x'), 'txt')).rejects.toThrow(/path/)
  })
})
