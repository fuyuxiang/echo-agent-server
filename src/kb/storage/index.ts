import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * 对象存储抽象(本地 FS 实现)。
 *
 * 存储键用随机 UUID,不用原始文件名:文件名可能含路径分隔符、Unicode
 * 同形字符或超长片段,拼进路径就是穿越漏洞。原始名另存在 documents.title。
 */
export interface Storage {
  put(data: Buffer, ext: string): Promise<string>
  get(key: string): Promise<Buffer>
  delete(key: string): Promise<void>
  pathOf(key: string): string
}

const EXT_RE = /^[A-Za-z0-9]{1,8}$/

export class FsStorage implements Storage {
  constructor(private root: string) {}

  async put(data: Buffer, ext: string): Promise<string> {
    const clean = ext.replace(/^\./, '').toLowerCase()
    if (!EXT_RE.test(clean)) throw new Error(`非法扩展名: ${ext}`)

    // 按 uuid 前两位分桶,避免单目录堆积上万文件拖慢 readdir。
    const id = randomUUID()
    const bucket = id.slice(0, 2)
    const key = `${bucket}/${id}.${clean}`
    const abs = this.pathOf(key)
    await mkdir(join(this.root, bucket), { recursive: true })
    await writeFile(abs, data)
    return key
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathOf(key))
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.pathOf(key))
    } catch (e) {
      // 文件已不存在视为删除成功 —— 幂等,便于重试。
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
  }

  /** 解析并校验路径必须落在 root 内,挡住 ../ 穿越。 */
  pathOf(key: string): string {
    const abs = resolve(this.root, key)
    const rootAbs = resolve(this.root)
    if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
      throw new Error(`存储键越界: ${key}`)
    }
    return abs
  }
}
