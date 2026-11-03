import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { createServer } from 'node:net'
import { testConfig } from '../src/config.js'
import { probeAntivirus, scanDocument, scanSkillPackage } from '../src/security/content-scanner.js'

const cfg = testConfig()

describe('发布前技术扫描', () => {
  it('接受仅有空 embeddings 目录的普通 PPTX，仍拒绝实际嵌入对象', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<Types/>')
    zip.file('ppt/slides/slide1.xml', '<p:sld>普通文本幻灯片</p:sld>')
    zip.folder('ppt/embeddings')
    const clean = await scanDocument(await zip.generateAsync({type:'nodebuffer'}), 'pptx', cfg)
    expect(clean.status).toBe('passed')
    zip.file('ppt/embeddings/oleObject1.bin', Buffer.from([1,2,3]))
    const embedded = await scanDocument(await zip.generateAsync({type:'nodebuffer'}), 'pptx', cfg)
    expect(embedded.status).toBe('failed')
    expect(embedded.findings).toContainEqual(expect.objectContaining({code:'OFFICE_EMBEDDED_OBJECT',path:'ppt/embeddings/oleObject1.bin'}))
  })
  it('拒绝扩展名与真实文件魔数不一致', async () => {
    const report = await scanDocument(Buffer.from('not a pdf'), 'pdf', cfg)
    expect(report.status).toBe('failed')
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'MIME_MISMATCH' }))
  })

  it('拒绝 EICAR、PDF 主动内容与 Office 宏', async () => {
    const eicar = Buffer.from(
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'
    )
    expect((await scanDocument(eicar, 'txt', cfg)).status).toBe('failed')

    const pdf = await scanDocument(Buffer.from('%PDF-1.7\n/OpenAction /JavaScript'), 'pdf', cfg)
    expect(pdf.status).toBe('failed')
    expect(pdf.findings.map((item) => item.code)).toContain('PDF_JAVASCRIPT')

    const office = new JSZip()
    office.file('[Content_Types].xml', '<Types/>')
    office.file('word/document.xml', '<w:document/>')
    office.file('word/vbaProject.bin', Buffer.from([1, 2, 3]))
    const report = await scanDocument(
      await office.generateAsync({ type: 'nodebuffer' }),
      'docx',
      cfg
    )
    expect(report.status).toBe('failed')
    expect(report.findings.map((item) => item.code)).toContain('OFFICE_ACTIVE_CONTENT')
  })

  it('Skill 包拒绝密钥、破坏命令和未声明二进制', async () => {
    const zip = new JSZip()
    zip.file('SKILL.md', '---\nname: bad\nversion: 1.0.0\n---\nrm -rf /')
    zip.file('secret.txt', '-----BEGIN PRIVATE KEY-----')
    zip.file('payload.bin', Buffer.from([0, 1, 2, 3]))
    const report = await scanSkillPackage(
      await zip.generateAsync({ type: 'nodebuffer' }),
      cfg
    )
    expect(report.status).toBe('failed')
    expect(report.findings.map((item) => item.code)).toEqual(
      expect.arrayContaining(['SKILL_DANGEROUS_COMMAND', 'SKILL_SECRET', 'SKILL_BINARY_CONTENT'])
    )
  })

  it('防病毒引擎被设为必需但不可用时故障关闭', async () => {
    const report = await scanDocument(
      Buffer.from('普通文本'),
      'txt',
      testConfig({ antivirusRequired: true })
    )
    expect(report.status).toBe('failed')
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: 'ANTIVIRUS_UNAVAILABLE', severity: 'critical' })
    )
  })

  it('健康检查使用 clamd PING/PONG 验证引擎真实可达', async () => {
    const server = createServer((socket) => {
      socket.on('data', (data) => {
        if (data.toString('utf8').includes('PING')) socket.end(Buffer.from('PONG\0'))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务器端口无效')
    try {
      await expect(probeAntivirus(testConfig({
        antivirusHost: '127.0.0.1',
        antivirusPort: address.port,
        antivirusRequired: true
      }))).resolves.toBe(true)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) =>
        error ? reject(error) : resolve()))
    }
  })
  it('checks large text entries and compressed virus signatures rather than skipping them',async()=>{
    const zip=new JSZip()
    zip.file('large.md','x'.repeat(2*1024*1024+1)+'\nrm -rf /')
    zip.file('virus.txt','X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')
    const report=await scanSkillPackage(await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}),cfg)
    expect(report.status).toBe('failed')
    expect(report.findings.map(f=>f.code)).toEqual(expect.arrayContaining(['SKILL_DANGEROUS_COMMAND','EICAR_TEST_SIGNATURE']))
  })

})
