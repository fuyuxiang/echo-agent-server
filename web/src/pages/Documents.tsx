import { useEffect, useState, useCallback, useRef } from 'react'
import {
  Table, Button, Upload, Modal, Form, Select, Input, Tag, Space, Progress,
  Tooltip, Popconfirm, message, Alert,
} from 'antd'
import { UploadOutlined, ReloadOutlined, DeleteOutlined, InboxOutlined } from '@ant-design/icons'
import type { UploadFile } from 'antd/es/upload/interface'
import * as api from '../api'
import type { DocumentItem, DocStatus, Scope } from '../types'
import { fmtBytes, fmtTime } from '../utils/format'

const STATUS_META: Record<DocStatus, { color: string; label: string }> = {
  pending: { color: 'default', label: '排队中' },
  parsing: { color: 'processing', label: '解析中' },
  chunking: { color: 'processing', label: '分块中' },
  embedding: { color: 'processing', label: '索引中' },
  ready: { color: 'success', label: '可检索' },
  failed: { color: 'error', label: '失败' },
  archived: { color: 'default', label: '已归档' },
}

const IN_PROGRESS: DocStatus[] = ['pending', 'parsing', 'chunking', 'embedding']

export default function Documents() {
  const [items, setItems] = useState<DocumentItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [scopes, setScopes] = useState<Scope[]>([])
  const [scopeFilter, setScopeFilter] = useState<string | undefined>()
  const [keyword, setKeyword] = useState('')
  const [loading, setLoading] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const timer = useRef<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.listDocs({ page, size: 20, scopeId: scopeFilter, q: keyword || undefined })
      setItems(res.items)
      setTotal(res.total)
    } finally {
      setLoading(false)
    }
  }, [page, scopeFilter, keyword])

  useEffect(() => { void load() }, [load])
  useEffect(() => { void api.listScopes().then(setScopes) }, [])

  // 摄取是异步的,不轮询的话管理员会以为卡住了。只在确实有进行中的文档时轮询,
  // 空闲页面不该一直打服务端。
  useEffect(() => {
    const busy = items.some((d) => IN_PROGRESS.includes(d.status))
    if (!busy) {
      if (timer.current) { clearInterval(timer.current); timer.current = null }
      return
    }
    if (timer.current) return
    timer.current = window.setInterval(() => void load(), 2000)
    return () => {
      if (timer.current) { clearInterval(timer.current); timer.current = null }
    }
  }, [items, load])

  const columns = [
    {
      title: '标题',
      dataIndex: 'title',
      render: (t: string, r: DocumentItem) => (
        <Space direction="vertical" size={0}>
          <span>{t}</span>
          <span style={{ fontSize: 12, color: '#999' }}>
            {r.sourceType} · {fmtBytes(r.byteSize)} · {r.chunkCount} 个片段
          </span>
        </Space>
      ),
    },
    {
      title: '可见范围',
      dataIndex: 'scopeName',
      width: 130,
      render: (n: string, r: DocumentItem) => (
        <Tag color={r.scopeKind === 'org' ? 'blue' : 'geekblue'}>
          {r.scopeKind === 'org' ? '全公司' : n}
        </Tag>
      ),
    },
    {
      title: '密级',
      dataIndex: 'sensitivity',
      width: 80,
      render: (s: number) =>
        s === 0 ? <Tag>公开</Tag> : s === 1 ? <Tag color="orange">内部</Tag> : <Tag color="red">机密</Tag>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 150,
      render: (s: DocStatus, r: DocumentItem) => {
        const meta = STATUS_META[s]
        if (s === 'failed') {
          // 失败原因必须能看到 —— 扫描件缺文本层是最常见的一种,
          // 不显示原因管理员只会反复重试。
          return (
            <Tooltip title={r.failReason ?? '未知原因'}>
              <Tag color="error" style={{ cursor: 'help' }}>失败 ⓘ</Tag>
            </Tooltip>
          )
        }
        if (IN_PROGRESS.includes(s)) {
          const idx = IN_PROGRESS.indexOf(s)
          return (
            <Space direction="vertical" size={2} style={{ width: 120 }}>
              <Tag color={meta.color}>{meta.label}</Tag>
              <Progress percent={Math.round(((idx + 1) / 5) * 100)} size="small" showInfo={false} />
            </Space>
          )
        }
        return <Tag color={meta.color}>{meta.label}</Tag>
      },
    },
    { title: '维护人', dataIndex: 'ownerName', width: 100, render: (n: string | null) => n ?? '—' },
    { title: '更新时间', dataIndex: 'updatedAt', width: 160, render: fmtTime },
    {
      title: '操作',
      width: 150,
      render: (_: unknown, r: DocumentItem) => (
        <Space size={4}>
          <Tooltip title="重新解析并索引。改了分块策略或换嵌入模型后需要执行">
            <Button
              size="small"
              type="link"
              icon={<ReloadOutlined />}
              onClick={async () => {
                await api.reindexDoc(r.id)
                message.success('已加入重建队列')
                void load()
              }}
            >
              重建
            </Button>
          </Tooltip>
          <Popconfirm
            title="确认下线该文档?"
            description="内容将立即从检索中移除,文档记录保留以便追溯"
            onConfirm={async () => {
              await api.deleteDoc(r.id)
              message.success('已下线')
              void load()
            }}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>下线</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <>
      <Space style={{ marginBottom: 16 }} wrap>
        <Button type="primary" icon={<UploadOutlined />} onClick={() => setUploadOpen(true)}>
          上传文档
        </Button>
        <Select
          allowClear
          placeholder="按可见范围筛选"
          style={{ width: 180 }}
          value={scopeFilter}
          onChange={(v) => { setScopeFilter(v); setPage(1) }}
          options={scopes.map((s) => ({
            value: s.id,
            label: s.kind === 'org' ? '全公司' : s.name,
          }))}
        />
        <Input.Search
          placeholder="搜索标题"
          allowClear
          style={{ width: 220 }}
          onSearch={(v) => { setKeyword(v); setPage(1) }}
        />
      </Space>

      <Table
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={items}
        pagination={{
          current: page,
          total,
          pageSize: 20,
          showTotal: (n) => `共 ${n} 份`,
          onChange: setPage,
        }}
      />

      <UploadModal
        open={uploadOpen}
        scopes={scopes}
        onClose={() => setUploadOpen(false)}
        onDone={() => { setUploadOpen(false); void load() }}
      />
    </>
  )
}

function UploadModal({
  open, scopes, onClose, onDone,
}: {
  open: boolean
  scopes: Scope[]
  onClose: () => void
  onDone: () => void
}) {
  const [form] = Form.useForm()
  const [fileList, setFileList] = useState<UploadFile[]>([])
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    const values = await form.validateFields()
    const file = fileList[0]?.originFileObj
    if (!file) { message.error('请选择文件'); return }
    setBusy(true)
    try {
      const res = await api.uploadDoc(file, values)
      // 去重不是失败,但要让管理员知道为什么没有新记录出现。
      message.success(res.dedup ? '该文件已存在,已复用现有文档' : '上传成功,正在后台索引')
      form.resetFields()
      setFileList([])
      onDone()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      title="上传文档"
      onCancel={onClose}
      onOk={submit}
      confirmLoading={busy}
      okText="上传"
      destroyOnClose
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="当前支持 md / txt / docx / pdf"
        description="扫描件 PDF 若无文本层会被判为失败并提示需要 OCR,不会静默产出空索引。"
      />
      <Form form={form} layout="vertical" initialValues={{ sensitivity: 0, volatility: 'stable' }}>
        <Form.Item name="scopeId" label="可见范围" rules={[{ required: true, message: '请选择可见范围' }]}>
          <Select
            placeholder="谁能检索到这份文档"
            options={scopes.map((s) => ({
              value: s.id,
              label: s.kind === 'org' ? '全公司' : `${s.name}(团队）`,
            }))}
          />
        </Form.Item>
        <Form.Item name="title" label="标题" extra="留空则用文件名">
          <Input placeholder="可选" />
        </Form.Item>
        <Form.Item name="sensitivity" label="密级" extra="用户只能检索到不高于自身权限的文档">
          <Select
            options={[
              { value: 0, label: '公开' },
              { value: 1, label: '内部' },
              { value: 2, label: '机密' },
            ]}
          />
        </Form.Item>
        <Form.Item
          name="volatility"
          label="时效性"
          extra="易变内容超过 90 天未更新时,答案里会附「可能过时」提示"
        >
          <Select
            options={[
              { value: 'stable', label: '稳定(制度、规范)' },
              { value: 'volatile', label: '易变(临时通知、当期政策)' },
            ]}
          />
        </Form.Item>
        <Form.Item name="tags" label="标签" extra="逗号分隔,便于按主题筛选">
          <Input placeholder="如:财务,报销" />
        </Form.Item>
        <Upload.Dragger
          maxCount={1}
          fileList={fileList}
          beforeUpload={() => false}
          onChange={({ fileList: fl }) => setFileList(fl.slice(-1))}
          accept=".md,.markdown,.txt,.text,.docx,.pdf"
        >
          <p className="ant-upload-drag-icon"><InboxOutlined /></p>
          <p className="ant-upload-text">点击或拖拽文件到此处</p>
        </Upload.Dragger>
      </Form>
    </Modal>
  )
}
