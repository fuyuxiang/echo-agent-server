import { useEffect, useState, useCallback } from 'react'
import {
  Table, Tag, Space, Input, Select, Button, Modal, Form, message, Popconfirm,
  Alert, InputNumber, Tooltip,
} from 'antd'
import * as api from '../api'
import type { OrgMemory } from '../types'
import { fmtTime, memoryKindLabel } from '../utils/format'
import { canReview } from '../store/auth'

const KINDS = ['fact', 'decision', 'convention', 'pitfall', 'howto']

/**
 * 组织记忆 = 被提炼过的短陈述,区别于原始文档。
 *
 * 它比文档更直接:一条"报销单需直属上级先签"能直接注入提示词,而让模型从
 * 十页制度里自己找出这句话既慢又不可靠。
 */
export default function Memories() {
  const [items, setItems] = useState<OrgMemory[]>([])
  const [loading, setLoading] = useState(false)
  const [kind, setKind] = useState<string | undefined>()
  const [keyword, setKeyword] = useState('')
  const [editing, setEditing] = useState<OrgMemory | null>(null)
  const editable = canReview()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setItems(await api.listMemories({ kind, q: keyword || undefined }))
    } finally {
      setLoading(false)
    }
  }, [kind, keyword])

  useEffect(() => { void load() }, [load])

  const columns = [
    {
      title: '类型',
      dataIndex: 'kind',
      width: 90,
      render: (k: string) => <Tag>{memoryKindLabel(k)}</Tag>,
    },
    {
      title: '内容',
      dataIndex: 'content',
      render: (c: string, r: OrgMemory) => (
        <Space direction="vertical" size={0}>
          <span>{c}</span>
          {r.rationale && (
            <span style={{ fontSize: 12, color: '#999' }}>依据:{r.rationale}</span>
          )}
        </Space>
      ),
    },
    {
      title: '可见范围',
      dataIndex: 'scopeName',
      width: 110,
      render: (n: string, r: OrgMemory) => (
        <Tag color={r.scopeKind === 'org' ? 'blue' : 'geekblue'}>
          {r.scopeKind === 'org' ? '全公司' : n}
        </Tag>
      ),
    },
    {
      title: '命中次数',
      dataIndex: 'hitCount',
      width: 100,
      sorter: (a: OrgMemory, b: OrgMemory) => a.hitCount - b.hitCount,
      render: (n: number) => (
        <Tooltip title="被答案实际引用的次数。长期为 0 说明这条可能没什么用">
          {n}
        </Tooltip>
      ),
    },
    {
      title: '有效期',
      dataIndex: 'validUntil',
      width: 130,
      render: (v: number | null) => {
        if (!v) return <span style={{ color: '#bbb' }}>长期</span>
        return v < Date.now() ? <Tag color="warning">已过期</Tag> : fmtTime(v)
      },
    },
    { title: '提交人', dataIndex: 'authorName', width: 100, render: (n: string | null) => n ?? '—' },
    ...(editable
      ? [
          {
            title: '操作',
            width: 130,
            render: (_: unknown, r: OrgMemory) => (
              <Space size={4}>
                <Button size="small" type="link" onClick={() => setEditing(r)}>编辑</Button>
                <Popconfirm
                  title="退休这条记忆?"
                  description="将不再参与检索,但记录保留以便追溯历史答案"
                  onConfirm={async () => {
                    await api.retireMemory(r.id)
                    message.success('已退休')
                    void load()
                  }}
                >
                  <Button size="small" type="link" danger>退休</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]
      : []),
  ]

  return (
    <>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="组织记忆来自员工提交并经审核的知识"
        description="它是被提炼过的短陈述,会直接参与问答。要新增请走「知识审核」——员工在客户端沉淀后提交。"
      />

      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          allowClear
          placeholder="按类型筛选"
          style={{ width: 150 }}
          value={kind}
          onChange={setKind}
          options={KINDS.map((k) => ({ value: k, label: memoryKindLabel(k) }))}
        />
        <Input.Search
          placeholder="搜索内容"
          allowClear
          style={{ width: 260 }}
          onSearch={setKeyword}
        />
      </Space>

      <Table rowKey="id" loading={loading} columns={columns} dataSource={items} pagination={false} />

      <EditModal
        memory={editing}
        onClose={() => setEditing(null)}
        onDone={() => { setEditing(null); void load() }}
      />
    </>
  )
}

function EditModal({
  memory, onClose, onDone,
}: {
  memory: OrgMemory | null
  onClose: () => void
  onDone: () => void
}): JSX.Element {
  const [form] = Form.useForm()

  useEffect(() => {
    if (!memory) return
    form.setFieldsValue({
      content: memory.content,
      rationale: memory.rationale,
      confidence: memory.confidence,
    })
  }, [memory, form])

  return (
    <Modal
      open={!!memory}
      title="编辑组织记忆"
      onCancel={onClose}
      destroyOnClose
      onOk={async () => {
        const v = await form.validateFields()
        await api.patchMemory(memory!.id, v)
        message.success('已保存')
        onDone()
      }}
    >
      <Form form={form} layout="vertical">
        <Form.Item name="content" label="内容" rules={[{ required: true }]}>
          <Input.TextArea rows={3} maxLength={2000} showCount />
        </Form.Item>
        <Form.Item name="rationale" label="依据">
          <Input.TextArea rows={2} maxLength={2000} />
        </Form.Item>
        <Form.Item
          name="confidence"
          label="置信度"
          extra="影响检索排序。不确定的内容调低,避免它压过更可靠的条目"
        >
          <InputNumber min={0} max={1} step={0.05} style={{ width: '100%' }} />
        </Form.Item>
      </Form>
    </Modal>
  )
}
