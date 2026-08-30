import net from 'node:net'
import JSZip from 'jszip'
import type { Config } from '../config.js'

export type FindingSeverity = 'info' | 'warning' | 'high' | 'critical'

export interface ScanFinding {
  code: string
  severity: FindingSeverity
  message: string
  path?: string
}

export interface ScanReport {
  version: 1
  status: 'passed' | 'failed'
  kind: 'document' | 'skill'
  detectedMime: string
  engines: Array<{ name: string; status: 'clean' | 'infected' | 'unavailable'; detail?: string }>
  findings: ScanFinding[]
  scannedAt: number
}

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'
const BLOCKING = new Set<FindingSeverity>(['high', 'critical'])
const TEXT_TYPES = new Set(['md', 'txt', 'qa', 'meeting'])
const OOXML_ROOT: Record<string, string> = { docx: 'word/', pptx: 'ppt/', xlsx: 'xl/' }

function finding(
  code: string,
  severity: FindingSeverity,
  message: string,
  path?: string
): ScanFinding {
  return { code, severity, message, ...(path ? { path } : {}) }
}

function startsWith(data: Buffer, bytes: number[]): boolean {
  return bytes.every((byte, index) => data[index] === byte)
}

function detectedMime(data: Buffer, sourceType: string): string | null {
  if (TEXT_TYPES.has(sourceType)) {
    if (data.includes(0)) return null
    return sourceType === 'md' ? 'text/markdown' : 'text/plain'
  }
  if (sourceType === 'pdf') return data.subarray(0, 5).toString('ascii') === '%PDF-' ? 'application/pdf' : null
  if (sourceType in OOXML_ROOT) return startsWith(data, [0x50, 0x4b, 0x03, 0x04]) ?
    'application/vnd.openxmlformats-officedocument' : null
  if (sourceType === 'image') {
    if (startsWith(data, [0x89, 0x50, 0x4e, 0x47])) return 'image/png'
    if (startsWith(data, [0xff, 0xd8, 0xff])) return 'image/jpeg'
    if (data.subarray(0, 6).toString('ascii').startsWith('GIF8')) return 'image/gif'
    if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
    if (data.subarray(0, 2).toString('ascii') === 'BM') return 'image/bmp'
    return null
  }
  if (sourceType === 'audio') {
    if (data.subarray(0, 3).toString('ascii') === 'ID3' || startsWith(data, [0xff, 0xfb])) return 'audio/mpeg'
    if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WAVE') return 'audio/wav'
    if (data.subarray(0, 4).toString('ascii') === 'fLaC') return 'audio/flac'
    if (data.subarray(0, 4).toString('ascii') === 'OggS') return 'audio/ogg'
    if (data.subarray(4, 8).toString('ascii') === 'ftyp') return 'audio/mp4'
    return null
  }
  if (sourceType === 'video') {
    if (data.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4'
    if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'AVI ') return 'video/x-msvideo'
    if (startsWith(data, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm'
    return null
  }
  return null
}

async function inspectOffice(
  data: Buffer,
  sourceType: string,
  findings: ScanFinding[]
): Promise<void> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(data, { checkCRC32: true })
  } catch {
    findings.push(finding('DOC_ARCHIVE_INVALID', 'critical', 'Office 文件的 ZIP 结构无效'))
    return
  }
  const names = Object.keys(zip.files)
  const expected = OOXML_ROOT[sourceType]
  if (!zip.file('[Content_Types].xml') || !names.some((name) => name.startsWith(expected))) {
    findings.push(finding('MIME_MISMATCH', 'critical', `文件内容与 ${sourceType} 扩展名不匹配`))
  }
  for (const name of names) {
    if (/(?:vbaProject\.bin|macrosheets?|activeX|customUI)/i.test(name)) {
      findings.push(finding('OFFICE_ACTIVE_CONTENT', 'critical', '检测到宏或 ActiveX 主动内容', name))
    }
    if (/(?:embeddings?|oleObject)/i.test(name)) {
      findings.push(finding('OFFICE_EMBEDDED_OBJECT', 'high', '检测到嵌入对象', name))
    }
  }
  for (const entry of names.filter((name) => name.endsWith('.rels'))) {
    const text = await zip.file(entry)?.async('string')
    if (text && /TargetMode\s*=\s*["']External["']/i.test(text)) {
      findings.push(finding('OFFICE_EXTERNAL_LINK', 'warning', '文件包含外部链接，审核时需确认', entry))
    }
  }
}

function inspectPdf(data: Buffer, findings: ScanFinding[]): void {
  const ascii = data.toString('latin1')
  const active = [
    ['/JavaScript', 'PDF_JAVASCRIPT'], ['/JS', 'PDF_JAVASCRIPT'],
    ['/Launch', 'PDF_LAUNCH_ACTION'], ['/EmbeddedFile', 'PDF_EMBEDDED_FILE'],
    ['/OpenAction', 'PDF_OPEN_ACTION']
  ] as const
  for (const [needle, code] of active) {
    if (ascii.includes(needle)) findings.push(finding(code, 'critical', `PDF 包含主动内容 ${needle}`))
  }
}

function inspectTextDocument(data: Buffer, findings: ScanFinding[]): void {
  const text = data.toString('utf8')
  if ((text.match(/\uFFFD/g)?.length ?? 0) > Math.max(2, text.length / 1000)) {
    findings.push(finding('TEXT_ENCODING_INVALID', 'high', '文本不是有效 UTF-8'))
  }
  if (/<script\b|javascript\s*:/i.test(text)) {
    findings.push(finding('DOCUMENT_ACTIVE_SCRIPT', 'high', '文档包含可执行脚本或 javascript URL'))
  }
}

async function clamScan(data: Buffer, cfg: Config): Promise<{ status: 'clean' | 'infected' | 'unavailable'; detail?: string }> {
  if (!cfg.antivirusHost) return { status: 'unavailable', detail: '未配置 ClamAV' }
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: cfg.antivirusHost, port: cfg.antivirusPort })
    let response = ''
    let settled = false
    const finish = (result: { status: 'clean' | 'infected' | 'unavailable'; detail?: string }) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(cfg.antivirusTimeoutMs)
    socket.on('connect', () => {
      socket.write(Buffer.from('zINSTREAM\0'))
      const block = 64 * 1024
      for (let offset = 0; offset < data.length; offset += block) {
        const chunk = data.subarray(offset, Math.min(data.length, offset + block))
        const size = Buffer.allocUnsafe(4)
        size.writeUInt32BE(chunk.length)
        socket.write(size)
        socket.write(chunk)
      }
      socket.end(Buffer.alloc(4))
    })
    socket.on('data', (chunk) => { response += chunk.toString('utf8') })
    socket.on('end', () => {
      const detail = response.replace(/\0/g, '').trim().slice(0, 300)
      if (/\bFOUND\b/.test(detail)) finish({ status: 'infected', detail })
      else if (/\bOK\b/.test(detail)) finish({ status: 'clean', detail })
      else finish({ status: 'unavailable', detail: detail || 'ClamAV 未返回有效结果' })
    })
    socket.on('timeout', () => finish({ status: 'unavailable', detail: 'ClamAV 扫描超时' }))
    socket.on('error', (error) => finish({ status: 'unavailable', detail: error.message.slice(0, 200) }))
  })
}

/**
 * 就绪检查使用 clamd PING 协议验证真实可达性，不仅判断主机名
 * 是否已配置。使用独立短超时，避免编排器健康检查被扫描超时拖住。
 */
export async function probeAntivirus(cfg: Config): Promise<boolean> {
  if (!cfg.antivirusHost) return false
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: cfg.antivirusHost, port: cfg.antivirusPort })
    let settled = false
    const finish = (available: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(available)
    }
    socket.setTimeout(Math.min(cfg.antivirusTimeoutMs, 2_000))
    socket.on('connect', () => socket.end(Buffer.from('zPING\0')))
    socket.on('data', (chunk) => {
      if (chunk.toString('utf8').replace(/\0/g, '').trim() === 'PONG') finish(true)
    })
    socket.on('end', () => finish(false))
    socket.on('timeout', () => finish(false))
    socket.on('error', () => finish(false))
  })
}

async function commonReport(
  kind: 'document' | 'skill',
  data: Buffer,
  mime: string,
  findings: ScanFinding[],
  cfg: Config
): Promise<ScanReport> {
  if (data.toString('latin1').includes(EICAR)) {
    findings.push(finding('EICAR_TEST_SIGNATURE', 'critical', '检测到 EICAR 防病毒测试签名'))
  }
  const antivirus = await clamScan(data, cfg)
  if (antivirus.status === 'infected') {
    findings.push(finding('ANTIVIRUS_DETECTED', 'critical', antivirus.detail ?? '防病毒引擎检测到威胁'))
  } else if (antivirus.status === 'unavailable') {
    findings.push(finding(
      'ANTIVIRUS_UNAVAILABLE',
      cfg.antivirusRequired ? 'critical' : 'warning',
      antivirus.detail ?? '防病毒引擎不可用'
    ))
  }
  return {
    version: 1,
    status: findings.some((item) => BLOCKING.has(item.severity)) ? 'failed' : 'passed',
    kind,
    detectedMime: mime,
    engines: [{ name: 'echo-static', status: 'clean' }, { name: 'clamav', ...antivirus }],
    findings,
    scannedAt: Date.now()
  }
}

export async function scanDocument(
  data: Buffer,
  sourceType: string,
  cfg: Config
): Promise<ScanReport> {
  const findings: ScanFinding[] = []
  const mime = detectedMime(data, sourceType)
  if (!mime) {
    findings.push(finding('MIME_MISMATCH', 'critical', '文件魔数/内容与声明类型不匹配'))
  } else if (TEXT_TYPES.has(sourceType)) {
    inspectTextDocument(data, findings)
  } else if (sourceType === 'pdf') {
    inspectPdf(data, findings)
  } else if (sourceType in OOXML_ROOT) {
    await inspectOffice(data, sourceType, findings)
  }
  return commonReport('document', data, mime ?? 'application/octet-stream', findings, cfg)
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'PEM 私钥'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS Access Key'],
  [/\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/, 'GitHub Token'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/, 'API Key']
]
const DANGEROUS_COMMANDS: Array<[RegExp, string]> = [
  [/\brm\s+-rf\s+(?:\/|~|\$HOME)(?:\s|$)/i, '破坏性删除命令'],
  [/(?:curl|wget)[^\n|]{0,300}\|\s*(?:sh|bash|zsh)\b/i, '远程下载后直接执行'],
  [/\bnc\s+[^\n]{0,100}-e\b|\/dev\/tcp\/|powershell[^\n]{0,100}-enc(?:odedcommand)?\b/i, '反向 Shell/编码执行']
]

export async function scanSkillPackage(data: Buffer, cfg: Config): Promise<ScanReport> {
  const findings: ScanFinding[] = []
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(data, { checkCRC32: true })
  } catch {
    return commonReport('skill', data, 'application/zip', [
      finding('SKILL_ARCHIVE_INVALID', 'critical', 'Skill 包不是有效 ZIP')
    ], cfg)
  }
  for (const entry of Object.values(zip.files).filter((item) => !item.dir)) {
    const bytes = Buffer.from(await entry.async('uint8array'))
    if (bytes.length > 2 * 1024 * 1024) continue
    if (bytes.includes(0)) {
      if (!/\.(?:png|jpe?g|gif|webp|pdf)$/i.test(entry.name)) {
        findings.push(finding('SKILL_BINARY_CONTENT', 'high', '未声明的二进制内容', entry.name))
      }
      continue
    }
    const text = bytes.toString('utf8')
    for (const [pattern, label] of SECRET_PATTERNS) {
      if (pattern.test(text)) findings.push(finding('SKILL_SECRET', 'critical', `检测到疑似 ${label}`, entry.name))
    }
    for (const [pattern, label] of DANGEROUS_COMMANDS) {
      if (pattern.test(text)) findings.push(finding('SKILL_DANGEROUS_COMMAND', 'critical', label, entry.name))
    }
    if (/\b(?:https?|wss?):\/\//i.test(text)) {
      findings.push(finding('SKILL_NETWORK_ADDRESS', 'warning', '包含外部网络地址，需人工确认', entry.name))
    }
    if (/(?:\/etc\/(?:passwd|shadow)|~\/\.ssh|\.aws\/credentials|Keychain|Credential Manager)/i.test(text)) {
      findings.push(finding('SKILL_SENSITIVE_PATH', 'high', '尝试访问敏感系统路径', entry.name))
    }
    if (/\.(?:sh|bash|zsh|ps1|bat|cmd|py|js|ts)$/i.test(entry.name)) {
      findings.push(finding('SKILL_SCRIPT', 'warning', '包含可执行脚本，需人工审核', entry.name))
    }
  }
  return commonReport('skill', data, 'application/zip', findings, cfg)
}
