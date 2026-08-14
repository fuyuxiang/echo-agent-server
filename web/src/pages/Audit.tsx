import { useEffect, useState, useCallback } from 'react'
import { Table, Tag, Space, Select, Alert } from 'antd'
import * as api from '../api'
import type { AuditLog } from '../types'
import { fmtTime } from '../utils/format'

const ACTIONS: Record<string, { label: string; color?: string }> = {
  login: { label: '登录' },
  login_failed: { label: '登录失败', color: 'orange' },
  logout: { label: '登出' },
  retrieve: { label: '检索' },
  upload: { label: '上传', color: 'blue' },
  delete: { label: '下线', color: 'red' },
  approve: { label: '审核通过', color: 'green' },
  reject: { label: '审核驳回', color: 'orange' },
  config_change: { label: '配置变更', color: 'purple' },
  user_change: { label: '用户变更', color: 'purple' },
}

export default function Audit() {
  const [items, setItems] = useState<AuditLog[]>([])
  const [action, setAction] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setItems(await api.listAudit({ action, limit: 200 }))
    } finally {
      setLoading(false)
    }
  }, [action])

  useEffect(() => { void load() }, [load])

  return (
    <>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="只记录操作行为,不记录检索到的内容"
        description="否则审计表本身会变成一份绕过权限的知识副本。"
      />

      <Space style={{ marginBottom: 16 }}>
        <Select
          allowClear
          placeholder="按操作类型筛选"
          style={{ width: 180 }}
          value={action}
          onChange={setAction}
          options={Object.entries(ACTIONS).map(([k, v]) => ({ value: k, label: v.label }))}
        />
      </Space>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={items}
        pagination={{ pageSize: 50, showTotal: (n) => `共 ${n} 条` }}
        columns={[
          { title: '时间', dataIndex: 'createdAt', width: 160, render: fmtTime },
          {
            title: '操作人',
            dataIndex: 'actorName',
            width: 120,
            render: (n: string | null) => n ?? <span style={{ color: '#bbb' }}>系统</span>,
          },
          {
            title: '操作',
            dataIndex: 'action',
            width: 120,
            render: (a: string) => {
              const meta = ACTIONS[a]
              return <Tag color={meta?.color}>{meta?.label ?? a}</Tag>
            },
          },
          {
            title: '对象',
            dataIndex: 'target',
            render: (t: string | null) =>
              t ? <span style={{ fontSize: 12, fontFamily: 'monospace' }}>{t}</span> : '—',
          },
          {
            title: '详情',
            dataIndex: 'detail',
            render: (d: string | null) =>
              d ? <span style={{ fontSize: 12, color: '#666' }}>{d}</span> : '—',
          },
          { title: 'IP', dataIndex: 'ip', width: 130, render: (i: string | null) => i ?? '—' },
        ]}
      />
    </>
  )
}
