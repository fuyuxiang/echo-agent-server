import { mkdir, writeFile, readFile, unlink, rename } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * 对象存储抽象(本地 FS 实现)。
 *
 * 存储键用随机 UUID,不用原始文件名:文件名可能含路径分隔符、Unicode
 * 同形字符或超长片段,拼进路径就是穿越漏洞。原始名另存在 documents.title。
 */
export interface Storage {
  put(data: Buffer, ext: string, partition?: StoragePartition): Promise<string>
  get(key: string): Promise<Buffer>
  delete(key: string): Promise<void>
  move(key: string, partition: StoragePartition): Promise<string>
  pathOf(key: string): string
}

const EXT_RE = /^[A-Za-z0-9]{1,8}$/
export type StoragePartition =
  | 'quarantine/documents'
  | 'published/documents'
  | 'quarantine/skills'
  | 'published/skills'
  | 'published/misc'

const PARTITIONS = new Set<StoragePartition>([
  'quarantine/documents',
  'published/documents',
  'quarantine/skills',
  'published/skills',
  'published/misc'
])

export class FsStorage implements Storage {
  constructor(private root: string) {}

  async put(
    data: Buffer,
    ext: string,
    partition: StoragePartition = 'published/misc'
  ): Promise<string> {
    const clean = ext.replace(/^\./, '').toLowerCase()
    if (!EXT_RE.test(clean)) throw new Error(`非法扩展名: ${ext}`)
    if (!PARTITIONS.has(partition)) throw new Error(`非法存储分区: ${partition}`)

    // 按 uuid 前两位分桶,避免单目录堆积上万文件拖慢 readdir。
    const id = randomUUID()
    const bucket = id.slice(0, 2)
    const key = `${partition}/${bucket}/${id}.${clean}`
    const abs = this.pathOf(key)
    await mkdir(join(this.root, partition, bucket), { recursive: true })
    await writeFile(abs, data)
    return key
  }

  /** 同一文件系统内原子提升，扫描未通过时永远不进入 published。 */
  async move(key: string, partition: StoragePartition): Promise<string> {
    if (!PARTITIONS.has(partition)) throw new Error(`非法存储分区: ${partition}`)
    const file = key.split('/').at(-1)
    if (!file || !/^[0-9a-f-]+\.[A-Za-z0-9]{1,8}$/i.test(file)) {
      throw new Error(`存储键格式无效: ${key}`)
    }
    const bucket = file.slice(0, 2).toLowerCase()
    const target = `${partition}/${bucket}/${file}`
    await mkdir(join(this.root, partition, bucket), { recursive: true })
    await rename(this.pathOf(key), this.pathOf(target))
    return target
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
