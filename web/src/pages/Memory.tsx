import { useEffect, useState } from 'react'
import { Button, Card, Empty, Input, Popconfirm, Space, Table, Tag, message } from 'antd'
import { listMemories, searchMemories, deleteMemory } from '../api/memory'
import { loadAuth } from '../store/auth'
import type { Memory, MemoryHit } from '../types'

export default function MemoryPage() {
  const hasGroup = !!loadAuth()?.user.groupId
  const [rows, setRows] = useState<MemoryHit[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [searched, setSearched] = useState(false)

  const reload = async () => {
    setLoading(true)
    try { setRows(await listMemories({ limit: 50 })); setSearched(false) }
    finally { setLoading(false) }
  }
  useEffect(() => { if (hasGroup) reload() }, [])

  const onSearch = async () => {
    if (!query.trim()) { reload(); return }
    setLoading(true)
    try { setRows(await searchMemories(query, 10)); setSearched(true) }
    finally { setLoading(false) }
  }

  const onDelete = async (id: string) => {
    await deleteMemory(id)
    message.success('已删除')
    reload()
  }

  if (!hasGroup) {
    return <Card title="记忆查看"><Empty description="当前账号未分配分组，无法查看项目记忆。请联系管理员分配分组。" /></Card>
  }

  const columns = [
    { title: '内容', dataIndex: 'content', ellipsis: true },
    { title: '标签', dataIndex: 'tags', render: (t: string[]) => (t ?? []).map((x) => <Tag key={x}>{x}</Tag>) },
    ...(searched ? [{ title: '相似度', dataIndex: 'score', width: 110, render: (s?: number) => (s == null ? '-' : s.toFixed(4)) }] : []),
    { title: '操作', width: 90, render: (_: unknown, r: Memory) => (
      <Popconfirm title="确认删除这条记忆?" onConfirm={() => onDelete(r.id)}>
        <Button danger size="small">删除</Button>
      </Popconfirm>
    ) },
  ]

  return (
    <Card title="记忆查看与检索">
      <Space style={{ marginBottom: 16 }}>
        <Input.Search style={{ width: 360 }} placeholder="输入关键词进行向量检索" value={query}
          onChange={(e) => setQuery(e.target.value)} onSearch={onSearch} enterButton="检索" />
        <Button onClick={reload}>显示全部</Button>
      </Space>
      <Table rowKey="id" loading={loading} dataSource={rows} columns={columns} />
    </Card>
  )
}
