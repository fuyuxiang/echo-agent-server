import { useEffect, useState, useCallback } from 'react'
import {
  Table, Button, Modal, Form, Input, Select, Tag, Space, Switch, message,
  Popconfirm, Tooltip,
} from 'antd'
import { PlusOutlined, KeyOutlined, DisconnectOutlined } from '@ant-design/icons'
import * as api from '../api'
import type { User, Group, Role } from '../types'
import { fmtRelative } from '../utils/format'
import { getUser } from '../store/auth'

const ROLE_META: Record<Role, { color: string; label: string; hint: string }> = {
  admin: { color: 'red', label: '管理员', hint: '全部权限,含用户与模型配置' },
  curator: { color: 'orange', label: '知识审核', hint: '可审核提升、管理文档,不能改用户' },
  member: { color: 'default', label: '成员', hint: '只能检索与提交候选知识' },
}

const CLEARANCE = [
  { value: 0, label: '公开' },
  { value: 1, label: '内部' },
  { value: 2, label: '机密' },
]

export default function Users() {
  const [users, setUsers] = useState<User[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<User | null>(null)
  const me = getUser()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [u, g] = await Promise.all([api.listUsers(), api.listGroups()])
      setUsers(u)
      setGroups(g)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const resetPassword = (u: User): void => {
    let pw = ''
    Modal.confirm({
      title: `重置 ${u.displayName} 的密码`,
      content: (
        <>
          <p style={{ color: '#888', fontSize: 13 }}>
            重置后该用户的所有登录会话立即失效,需用新密码重新登录。
          </p>
          <Input.Password placeholder="新密码,至少 8 位" onChange={(e) => { pw = e.target.value }} />
        </>
      ),
      onOk: async () => {
        if (pw.length < 8) {
          message.error('密码至少 8 位')
          return Promise.reject(new Error('too short'))
        }
        await api.resetPassword(u.id, pw)
        message.success('已重置,该用户需重新登录')
      },
    })
  }

  const columns = [
    {
      title: '用户',
      render: (_: unknown, r: User) => (
        <Space direction="vertical" size={0}>
          <span>
            {r.displayName}
            {r.id === me?.id && <Tag style={{ marginLeft: 6 }}>我</Tag>}
          </span>
          <span style={{ fontSize: 12, color: '#999' }}>{r.username}</span>
        </Space>
      ),
    },
    {
      title: '角色',
      dataIndex: 'role',
      width: 110,
      render: (r: Role) => (
        <Tooltip title={ROLE_META[r].hint}>
          <Tag color={ROLE_META[r].color}>{ROLE_META[r].label}</Tag>
        </Tooltip>
      ),
    },
    {
      title: '密级权限',
      dataIndex: 'clearance',
      width: 100,
      render: (c: number) => CLEARANCE.find((x) => x.value === c)?.label ?? c,
    },
    {
      title: '所属分组',
      dataIndex: 'groups',
      render: (gs: { id: string; name: string }[]) =>
        gs?.length ? gs.map((g) => <Tag key={g.id}>{g.name}</Tag>) : <span style={{ color: '#bbb' }}>未分组</span>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s: string) =>
        s === 'active' ? <Tag color="success">正常</Tag> : <Tag>已禁用</Tag>,
    },
    { title: '最近活动', dataIndex: 'lastSeenAt', width: 120, render: fmtRelative },
    {
      title: '操作',
      width: 210,
      render: (_: unknown, r: User) => (
        <Space size={4}>
          <Button size="small" type="link" onClick={() => setEditing(r)}>编辑</Button>
          <Button size="small" type="link" icon={<KeyOutlined />} onClick={() => resetPassword(r)}>
            重置密码
          </Button>
          <Tooltip title="强制该用户全部设备下线。离职或凭证泄露时用">
            <Popconfirm
              title="强制下线?"
              onConfirm={async () => {
                await api.revokeSessions(r.id)
                message.success('已强制下线')
                void load()
              }}
            >
              <Button size="small" type="link" danger icon={<DisconnectOutlined />} />
            </Popconfirm>
          </Tooltip>
        </Space>
      ),
    },
  ]

  return (
    <>
      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          新建用户
        </Button>
      </Space>

      <Table rowKey="id" loading={loading} columns={columns} dataSource={users} pagination={false} />

      <CreateModal
        open={createOpen}
        groups={groups}
        onClose={() => setCreateOpen(false)}
        onDone={() => { setCreateOpen(false); void load() }}
      />
      <EditModal
        user={editing}
        groups={groups}
        isSelf={editing?.id === me?.id}
        onClose={() => setEditing(null)}
        onDone={() => { setEditing(null); void load() }}
      />
    </>
  )
}

function CreateModal({
  open, groups, onClose, onDone,
}: {
  open: boolean
  groups: Group[]
  onClose: () => void
  onDone: () => void
}): JSX.Element {
  const [form] = Form.useForm()
  const [busy, setBusy] = useState(false)

  return (
    <Modal
      open={open}
      title="新建用户"
      onCancel={onClose}
      confirmLoading={busy}
      destroyOnClose
      onOk={async () => {
        const v = await form.validateFields()
        setBusy(true)
        try {
          await api.createUser(v)
          message.success('已创建')
          form.resetFields()
          onDone()
        } finally {
          setBusy(false)
        }
      }}
    >
      <Form form={form} layout="vertical" initialValues={{ role: 'member', clearance: 0 }}>
        <Form.Item
          name="username"
          label="用户名"
          rules={[{ required: true, min: 2, message: '至少 2 个字符' }]}
        >
          <Input autoComplete="off" />
        </Form.Item>
        <Form.Item name="displayName" label="显示名" extra="留空则用用户名">
          <Input />
        </Form.Item>
        <Form.Item
          name="password"
          label="初始密码"
          rules={[{ required: true, min: 8, message: '至少 8 位' }]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item name="role" label="角色">
          <Select
            options={(Object.keys(ROLE_META) as Role[]).map((r) => ({
              value: r,
              label: `${ROLE_META[r].label} — ${ROLE_META[r].hint}`,
            }))}
          />
        </Form.Item>
        <Form.Item
          name="clearance"
          label="密级权限"
          extra="只能检索到不高于此级别的文档"
        >
          <Select options={CLEARANCE} />
        </Form.Item>
        <Form.Item name="groupIds" label="所属分组" extra="决定能看到哪些团队的知识">
          <Select
            mode="multiple"
            allowClear
            options={groups.map((g) => ({ value: g.id, label: g.name }))}
          />
        </Form.Item>
      </Form>
    </Modal>
  )
}

function EditModal({
  user, groups, isSelf, onClose, onDone,
}: {
  user: User | null
  groups: Group[]
  isSelf: boolean
  onClose: () => void
  onDone: () => void
}): JSX.Element {
  const [form] = Form.useForm()

  useEffect(() => {
    if (!user) return
    form.setFieldsValue({
      displayName: user.displayName,
      email: user.email,
      role: user.role,
      clearance: user.clearance,
      status: user.status === 'active',
      groupIds: user.groups?.map((g) => g.id) ?? [],
    })
  }, [user, form])

  return (
    <Modal
      open={!!user}
      title={`编辑 ${user?.displayName ?? ''}`}
      onCancel={onClose}
      destroyOnClose
      onOk={async () => {
        const v = await form.validateFields()
        await api.updateUser(user!.id, {
          displayName: v.displayName,
          email: v.email || null,
          role: v.role,
          clearance: v.clearance,
          status: v.status ? 'active' : 'disabled',
          groupIds: v.groupIds,
        })
        message.success('已保存。权限变更会让该用户当前会话立即失效')
        onDone()
      }}
    >
      <Form form={form} layout="vertical">
        <Form.Item name="displayName" label="显示名" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item name="email" label="邮箱">
          <Input />
        </Form.Item>
        <Form.Item
          name="role"
          label="角色"
          extra={isSelf ? '不能修改自己的角色,避免把最后一个管理员锁在外面' : undefined}
        >
          <Select
            disabled={isSelf}
            options={(Object.keys(ROLE_META) as Role[]).map((r) => ({
              value: r,
              label: ROLE_META[r].label,
            }))}
          />
        </Form.Item>
        <Form.Item name="clearance" label="密级权限">
          <Select options={CLEARANCE} />
        </Form.Item>
        <Form.Item name="groupIds" label="所属分组">
          <Select
            mode="multiple"
            allowClear
            options={groups.map((g) => ({ value: g.id, label: g.name }))}
          />
        </Form.Item>
        <Form.Item
          name="status"
          label="账号状态"
          valuePropName="checked"
          extra={isSelf ? '不能禁用自己' : '禁用后该用户立即失去全部可见性'}
        >
          <Switch checkedChildren="正常" unCheckedChildren="禁用" disabled={isSelf} />
        </Form.Item>
      </Form>
    </Modal>
  )
}
