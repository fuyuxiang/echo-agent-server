import { useEffect, useState, useCallback } from 'react'
import {
  Card, Button, Space, Tag, Input, Modal, Form, Empty, message, Segmented,
  Descriptions, Spin, Alert, Tabs, Switch,
} from 'antd'
import { CheckOutlined, CloseOutlined, DownloadOutlined, EditOutlined } from '@ant-design/icons'
import * as api from '../api'
import type {
  Promotion, MemoryPayload, DocumentPayload, PromotionState,
  DocumentSubmission, SkillSubmission,
} from '../types'
import { loadAuth } from '../store/auth'
import { fmtRelative, memoryKindLabel, sourceLabel } from '../utils/format'

/**
 * 审核队列。
 *
 * 这里是"知识双向流动"的闸门:员工从会议、问答、任务里沉淀的候选知识在此
 * 汇总。审核人可以在通过前直接修订 —— 没有这个能力,要么放低标准让低质内容
 * 进组织库,要么让提交人反复返工,几次之后就没人愿意再提了。
 */
export default function Review() {
  const [queue, setQueue] = useState('knowledge')
  return (
    <>
      <Tabs
        activeKey={queue}
        onChange={setQueue}
        items={[
          { key: 'knowledge', label: '知识条目' },
          { key: 'documents', label: '文档发布' },
          { key: 'skills', label: 'Skill 发布' },
        ]}
      />
      {queue === 'knowledge' && <PromotionReview />}
      {queue === 'documents' && <DocumentSubmissionReview />}
      {queue === 'skills' && <SkillSubmissionReview />}
    </>
  )
}

function PromotionReview() {
  const [state, setState] = useState<PromotionState>('pending')
  const [items, setItems] = useState<Promotion[]>([])
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState<Promotion | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setItems(await api.listPromotions(state))
    } finally {
      setLoading(false)
    }
  }, [state])

  useEffect(() => { void load() }, [load])

  const approve = async (p: Promotion, edits?: Record<string, unknown>, note?: string): Promise<void> => {
    await api.approvePromotion(p.id, { note, edits })
    message.success('已通过,内容已进入组织知识库')
    setEditing(null)
    void load()
  }

  const reject = (p: Promotion): void => {
    let note = ''
    Modal.confirm({
      title: '驳回这条提交',
      content: (
        <>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="驳回原因会展示给提交人"
            description="写清楚原因,提交人才知道怎么改。这也是知识标准的一次传达。"
          />
          <Input.TextArea
            rows={3}
            placeholder="如:与现行制度冲突,请核对最新版《报销管理办法》"
            onChange={(e) => { note = e.target.value }}
          />
        </>
      ),
      okText: '驳回',
      okButtonProps: { danger: true },
      onOk: async () => {
        if (!note.trim()) {
          message.error('请填写驳回原因')
          return Promise.reject(new Error('need note'))
        }
        await api.rejectPromotion(p.id, note)
        message.success('已驳回')
        void load()
      },
    })
  }

  return (
    <>
      <Space style={{ marginBottom: 16 }}>
        <Segmented
          value={state}
          onChange={(v) => setState(v as PromotionState)}
          options={[
            { label: '待审核', value: 'pending' },
            { label: '已通过', value: 'approved' },
            { label: '已驳回', value: 'rejected' },
          ]}
        />
        <Button onClick={() => void load()}>刷新</Button>
      </Space>

      {loading ? (
        <Spin />
      ) : items.length === 0 ? (
        <Empty
          description={
            state === 'pending'
              ? '暂无待审核的提交。员工在客户端沉淀知识后会出现在这里'
              : '暂无记录'
          }
        />
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {items.map((p) => (
            <Card
              key={p.id}
              size="small"
              title={
                <Space wrap>
                  <Tag color={p.payloadType === 'memory' ? 'purple' : 'cyan'}>
                    {p.payloadType === 'memory' ? '知识条目' : '文档'}
                  </Tag>
                  <Tag>{sourceLabel(p.source)}</Tag>
                  <span style={{ fontWeight: 400, fontSize: 13 }}>
                    {p.submitterName} 提交 · {fmtRelative(p.createdAt)}
                  </span>
                  <Tag color={p.scopeKind === 'org' ? 'blue' : 'geekblue'}>
                    → {p.scopeKind === 'org' ? '全公司' : p.scopeName}
                  </Tag>
                </Space>
              }
              extra={
                state === 'pending' && (
                  <Space>
                    <Button size="small" icon={<EditOutlined />} onClick={() => setEditing(p)}>
                      修订后通过
                    </Button>
                    <Button
                      size="small"
                      type="primary"
                      icon={<CheckOutlined />}
                      onClick={() => void approve(p)}
                    >
                      直接通过
                    </Button>
                    <Button size="small" danger icon={<CloseOutlined />} onClick={() => reject(p)}>
                      驳回
                    </Button>
                  </Space>
                )
              }
            >
              <PayloadView p={p} />
              {p.reviewNote && (
                <div style={{ marginTop: 8, fontSize: 13, color: '#888' }}>
                  审核意见:{p.reviewNote}
                  {p.reviewerName ? `(${p.reviewerName})` : ''}
                </div>
              )}
            </Card>
          ))}
        </Space>
      )}

      <EditModal
        promotion={editing}
        onCancel={() => setEditing(null)}
        onOk={(edits, note) => editing && approve(editing, edits, note)}
      />
    </>
  )
}

function rejectWithReason(title: string, action: (note: string) => Promise<unknown>, reload: () => void): void {
  let note = ''
  Modal.confirm({
    title,
    content: <Input.TextArea rows={3} placeholder="说明驳回原因，该内容会展示给提交人" onChange={(event) => { note = event.target.value }} />,
    okText: '驳回',
    okButtonProps: { danger: true },
    onOk: async () => {
      if (!note.trim()) {
        message.error('请填写驳回原因')
        throw new Error('need note')
      }
      await action(note.trim())
      message.success('已驳回')
      reload()
    },
  })
}

async function saveReviewFile(load: () => Promise<Blob>, fileName: string): Promise<void> {
  const blob = await load()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function DocumentSubmissionReview(): JSX.Element {
  const [state, setState] = useState<PromotionState>('pending')
  const [items, setItems] = useState<DocumentSubmission[]>([])
  const [loading, setLoading] = useState(false)
  const load = useCallback(async () => {
    setLoading(true)
    try { setItems(await api.listDocumentSubmissions(state)) } finally { setLoading(false) }
  }, [state])
  useEffect(() => { void load() }, [load])
  return (
    <>
      <Space style={{ marginBottom: 16 }}>
        <Segmented value={state} onChange={(value) => setState(value as PromotionState)} options={[
          { label: '待审核', value: 'pending' }, { label: '已通过', value: 'approved' }, { label: '已驳回', value: 'rejected' },
        ]} />
        <Button onClick={() => void load()}>刷新</Button>
      </Space>
      {loading ? <Spin /> : items.length === 0 ? <Empty description="暂无文档提交" /> : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {items.map((item) => <Card key={item.id} size="small" title={<Space wrap><Tag color="cyan">文档</Tag><strong>{item.title}</strong><span>{item.submitterName} 提交 · {fmtRelative(item.createdAt)}</span><Tag color={item.scopeKind === 'org' ? 'blue' : 'geekblue'}>{item.scopeName}</Tag></Space>} extra={<Space><Button size="small" icon={<DownloadOutlined />} onClick={() => void saveReviewFile(() => api.downloadDocumentSubmission(item.id), item.title)}>下载审阅</Button>{state === 'pending' && <><Button type="primary" size="small" icon={<CheckOutlined />} onClick={async () => { await api.approveDocumentSubmission(item.id); message.success('已通过，文档开始建立索引'); void load() }}>通过</Button><Button danger size="small" icon={<CloseOutlined />} onClick={() => rejectWithReason('驳回文档提交', (note) => api.rejectDocumentSubmission(item.id, note), () => void load())}>驳回</Button></>}</Space>}>
            <Descriptions size="small" column={3}>
              <Descriptions.Item label="类型">{item.sourceType.toUpperCase()}</Descriptions.Item>
              <Descriptions.Item label="大小">{(item.byteSize / 1024).toFixed(1)} KB</Descriptions.Item>
              <Descriptions.Item label="密级">{item.sensitivity}</Descriptions.Item>
              <Descriptions.Item label="技术扫描"><Tag color={item.scanStatus === 'passed' ? 'green' : 'red'}>{item.scanStatus}</Tag></Descriptions.Item>
              <Descriptions.Item label="MIME">{item.scanReport?.detectedMime ?? '-'}</Descriptions.Item>
              <Descriptions.Item label="扫描引擎">{item.scanReport?.engines.map((engine) => `${engine.name}:${engine.status}`).join(' / ') ?? '-'}</Descriptions.Item>
              <Descriptions.Item label="标签" span={3}>{item.tags.length ? item.tags.map((tag) => <Tag key={tag}>{tag}</Tag>) : '无'}</Descriptions.Item>
              {item.scanReport?.findings.length ? <Descriptions.Item label="扫描发现" span={3}>{item.scanReport.findings.map((finding) => <Tag key={`${finding.code}-${finding.path ?? ''}`} color={finding.severity === 'critical' || finding.severity === 'high' ? 'red' : 'orange'}>{finding.code}: {finding.message}</Tag>)}</Descriptions.Item> : null}
            </Descriptions>
          </Card>)}
        </Space>
      )}
    </>
  )
}

function SkillSubmissionReview(): JSX.Element {
  const [state, setState] = useState<'pending' | 'approved' | 'rejected'>('pending')
  const [items, setItems] = useState<SkillSubmission[]>([])
  const [loading, setLoading] = useState(false)
  const isAdmin = loadAuth()?.user.role === 'admin'
  const load = useCallback(async () => {
    setLoading(true)
    try { setItems(await api.listSkillSubmissions(state)) } finally { setLoading(false) }
  }, [state])
  useEffect(() => { void load() }, [load])
  const approve = (item: SkillSubmission): void => {
    let mandatory = false
    let allowPersonalOverride = true
    let note = ''
    Modal.confirm({
      title: `发布 ${item.name} v${item.version}`,
      width: 560,
      content: <Space direction="vertical" style={{ width: '100%' }}>
        <Alert type="warning" showIcon message="Skill 会影响 Agent 行为，请确认来源、权限与包内文件。" />
        {isAdmin && <><Space><Switch onChange={(value) => { mandatory = value }} />强制启用</Space><Space><Switch defaultChecked onChange={(value) => { allowPersonalOverride = value }} />允许个人同名 Skill 覆盖</Space></>}
        <Input placeholder="审核意见（可选）" onChange={(event) => { note = event.target.value }} />
      </Space>,
      okText: '确认发布',
      onOk: async () => {
        await api.approveSkillSubmission(item.submissionId, { note: note || undefined, mandatory, allowPersonalOverride })
        message.success('已发布，客户端下次同步生效')
        void load()
      },
    })
  }
  return (
    <>
      <Space style={{ marginBottom: 16 }}><Segmented value={state} onChange={(value) => setState(value as typeof state)} options={[{ label: '待审核', value: 'pending' }, { label: '已通过', value: 'approved' }, { label: '已驳回', value: 'rejected' }]} /><Button onClick={() => void load()}>刷新</Button></Space>
      {loading ? <Spin /> : items.length === 0 ? <Empty description="暂无 Skill 提交" /> : <Space direction="vertical" size={12} style={{ width: '100%' }}>{items.map((item) => <Card key={item.submissionId} size="small" title={<Space wrap><Tag color="purple">Skill</Tag><strong>{item.name} v{item.version}</strong><span>{item.submitterName} 提交 · {fmtRelative(item.createdAt)}</span><Tag color={item.scopeKind === 'org' ? 'blue' : 'geekblue'}>{item.scopeName}</Tag></Space>} extra={<Space><Button size="small" icon={<DownloadOutlined />} onClick={() => void saveReviewFile(() => api.downloadSkillSubmission(item.submissionId), `${item.name}-${item.version}.zip`)}>下载审阅</Button>{state === 'pending' && <><Button type="primary" size="small" icon={<CheckOutlined />} onClick={() => approve(item)}>审核发布</Button><Button danger size="small" icon={<CloseOutlined />} onClick={() => rejectWithReason('驳回 Skill', (note) => api.rejectSkillSubmission(item.submissionId, note), () => void load())}>驳回</Button></>}{state === 'approved' && <><Button size="small" onClick={async () => { await api.rollbackSkill(item.skillId, item.submissionId); message.success('已切换到该版本'); void load() }}>切换到此版本</Button><Button danger size="small" onClick={() => rejectWithReason('禁用 Skill', (note) => api.disableSkill(item.skillId, note), () => void load())}>立即禁用</Button></>}</Space>}>
        <Descriptions size="small" column={2}>
          <Descriptions.Item label="说明">{item.description}</Descriptions.Item><Descriptions.Item label="包大小">{(item.packageBytes / 1024).toFixed(1)} KB</Descriptions.Item>
          <Descriptions.Item label="技术扫描"><Tag color={item.scanStatus === 'passed' ? 'green' : 'red'}>{item.scanStatus}</Tag></Descriptions.Item><Descriptions.Item label="变更说明">{item.changelog || '-'}</Descriptions.Item>
          <Descriptions.Item label="SHA-256" span={2}><code>{item.hash}</code></Descriptions.Item>
          {item.scanReport?.findings.length ? <Descriptions.Item label="扫描发现" span={2}>{item.scanReport.findings.map((finding) => <Tag key={`${finding.code}-${finding.path ?? ''}`} color={finding.severity === 'critical' || finding.severity === 'high' ? 'red' : 'orange'}>{finding.code}: {finding.message}{finding.path ? ` (${finding.path})` : ''}</Tag>)}</Descriptions.Item> : null}
        </Descriptions>
      </Card>)}</Space>}
    </>
  )
}

function PayloadView({ p }: { p: Promotion }): JSX.Element {
  if (p.payloadType === 'memory') {
    const v = p.payload as MemoryPayload
    return (
      <Descriptions size="small" column={1}>
        <Descriptions.Item label="类型">{memoryKindLabel(v.kind)}</Descriptions.Item>
        <Descriptions.Item label="内容">{v.content}</Descriptions.Item>
        {v.rationale && <Descriptions.Item label="依据">{v.rationale}</Descriptions.Item>}
      </Descriptions>
    )
  }
  const v = p.payload as DocumentPayload
  return (
    <Descriptions size="small" column={1}>
      <Descriptions.Item label="标题">{v.title}</Descriptions.Item>
      <Descriptions.Item label="正文">
        <div style={{ maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{v.text}</div>
      </Descriptions.Item>
    </Descriptions>
  )
}

function EditModal({
  promotion, onCancel, onOk,
}: {
  promotion: Promotion | null
  onCancel: () => void
  onOk: (edits: Record<string, unknown>, note?: string) => void
}): JSX.Element {
  const [form] = Form.useForm()

  useEffect(() => {
    if (!promotion) return
    if (promotion.payloadType === 'memory') {
      const v = promotion.payload as MemoryPayload
      form.setFieldsValue({ content: v.content, rationale: v.rationale })
    } else {
      const v = promotion.payload as DocumentPayload
      form.setFieldsValue({ title: v.title, text: v.text })
    }
  }, [promotion, form])

  const isMemory = promotion?.payloadType === 'memory'

  return (
    <Modal
      open={!!promotion}
      title="修订后通过"
      onCancel={onCancel}
      onOk={async () => {
        const { note, ...edits } = await form.validateFields()
        onOk(edits, note)
      }}
      okText="修订并通过"
      destroyOnClose
      width={640}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="落库的是修订后的版本"
        description="顺手改一句比打回去让人重写更省事,也更能保住组织库的措辞一致。"
      />
      <Form form={form} layout="vertical">
        {isMemory ? (
          <>
            <Form.Item name="content" label="内容" rules={[{ required: true, message: '内容不能为空' }]}>
              <Input.TextArea rows={4} maxLength={2000} showCount />
            </Form.Item>
            <Form.Item name="rationale" label="依据" extra="为什么成立。有依据的条目更容易被后来人信任">
              <Input.TextArea rows={2} maxLength={2000} />
            </Form.Item>
          </>
        ) : (
          <>
            <Form.Item name="title" label="标题" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item name="text" label="正文" rules={[{ required: true }]}>
              <Input.TextArea rows={10} />
            </Form.Item>
          </>
        )}
        <Form.Item name="note" label="审核意见" extra="会展示给提交人">
          <Input placeholder="如:补充了生效时间" />
        </Form.Item>
      </Form>
    </Modal>
  )
}
