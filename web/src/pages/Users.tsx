import { useEffect, useState } from 'react'
import { Button, Card, Form, Input, Modal, Select, Switch, Table, Tag, message } from 'antd'
import { listUsers, createUser, updateUser, listGroups } from '../api/admin'
import type { User, Group } from '../types'

export default function Users() {
  const [users, setUsers] = useState<User[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()

  const reload = async () => {
    setLoading(true)
    try {
      const [u, g] = await Promise.all([listUsers(), listGroups()])
      setUsers(u); setGroups(g)
    } finally { setLoading(false) }
  }
  useEffect(() => { reload() }, [])

  const groupName = (id: string | null) => groups.find((g) => g.id === id)?.name ?? '-'

  const onCreate = async (v: { username: string; password: string; role: string; groupId?: string }) => {
    await createUser(v)
    message.success('用户已创建')
    setOpen(false); form.resetFields(); reload()
  }

  const toggleDisabled = async (u: User) => {
    await updateUser(u.id, { disabled: !u.disabled })
    message.success(u.disabled ? '已启用' : '已禁用')
    reload()
  }

  const changeGroup = async (u: User, groupId: string) => {
    await updateUser(u.id, { groupId })
    message.success('分组已更新')
    reload()
  }

  return (
    <Card title="用户管理" extra={<Button type="primary" onClick={() => setOpen(true)}>新建用户</Button>}>
      <Table rowKey="id" loading={loading} dataSource={users} columns={[
        { title: '用户名', dataIndex: 'username' },
        { title: '角色', dataIndex: 'role', render: (r: string) => <Tag color={r === 'admin' ? 'gold' : 'blue'}>{r}</Tag> },
        { title: '分组', dataIndex: 'groupId', render: (_: unknown, u: User) => (
          <Select size="small" style={{ minWidth: 120 }} value={u.groupId ?? undefined}
            placeholder={groupName(u.groupId)} onChange={(v) => changeGroup(u, v)}
            options={groups.map((g) => ({ value: g.id, label: g.name }))} />
        ) },
        { title: '状态', dataIndex: 'disabled', render: (d: boolean) => <Tag color={d ? 'red' : 'green'}>{d ? '禁用' : '正常'}</Tag> },
        { title: '操作', render: (_: unknown, u: User) => (
          <Switch checkedChildren="启用" unCheckedChildren="禁用" checked={!u.disabled} onChange={() => toggleDisabled(u)} />
        ) },
      ]} />
      <Modal title="新建用户" open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()}>
        <Form form={form} layout="vertical" initialValues={{ role: 'member' }} onFinish={onCreate}>
          <Form.Item label="用户名" name="username" rules={[{ required: true, message: '请输入用户名' }]}><Input /></Form.Item>
          <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' }]}><Input.Password /></Form.Item>
          <Form.Item label="角色" name="role"><Select options={[{ value: 'admin', label: 'admin' }, { value: 'member', label: 'member' }]} /></Form.Item>
          <Form.Item label="分组" name="groupId"><Select allowClear options={groups.map((g) => ({ value: g.id, label: g.name }))} /></Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
