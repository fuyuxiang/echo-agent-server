export function fmtBytes(n: number): string {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export function fmtTime(ms: number | null | undefined): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fmtRelative(ms: number | null | undefined): string {
  if (!ms) return '—'
  const diff = Date.now() - ms
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  return fmtTime(ms)
}

export function fmtPercent(v: number | null | undefined, digits = 1): string {
  if (v == null) return '—'
  return `${(v * 100).toFixed(digits)}%`
}

const KIND_LABEL: Record<string, string> = {
  fact: '事实',
  decision: '决策',
  convention: '约定',
  pitfall: '坑点',
  howto: '操作方法',
}

export function memoryKindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind
}

const SOURCE_LABEL: Record<string, string> = {
  meeting: '会议',
  qa: '问答',
  task: '任务',
  manual: '手动',
}

export function sourceLabel(source: string): string {
  return SOURCE_LABEL[source] ?? source
}
