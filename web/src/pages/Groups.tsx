import { useEffect, useState, useCallback } from 'react'
import { Table, Button, Modal, Form, Input, Select, Space, Tag, message, Alert } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import * as api from '../api'
import type { Group } from '../types'

export default function Groups() {
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setGroups(await api.listGroups())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const nameOf = (id: string | null): string =>
    id ? (groups.find((g) => g.id === id)?.name ?? id) : '—'

  const columns = [
    { title: '分组', dataIndex: 'name' },
    {
      title: '上级分组',
      dataIndex: 'parentId',
      width: 160,
      render: (p: string | null) => nameOf(p),
    },
    { title: '成员数', dataIndex: 'memberCount', width: 90 },
    {
      title: '可见性单元',
      dataIndex: 'scopeId',
      width: 120,
      render: (s: string | null) =>
        s ? <Tag color="geekblue">已配置</Tag> : <Tag color="warning">缺失</Tag>,
    },
    { title: '说明', dataIndex: 'description', render: (d: string | null) => d ?? '—' },
  ]

  return (
    <>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="分组决定知识的可见范围"
        description="子分组成员自动继承上级分组的知识可见性,反之不成立 —— 上级看不到子分组的专属内容。每个分组会自动创建一个同名可见性单元,文档上传时可选。"
      />

      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
          新建分组
        </Button>
      </Space>

      <Table rowKey="id" loading={loading} columns={columns} dataSource={groups} pagination={false} />

      <Modal
        open={open}
        title="新建分组"
        onCancel={() => setOpen(false)}
        destroyOnClose
        onOk={async () => {
          const v = await form.validateFields()
          await api.createGroup(v)
          message.success('已创建,同时生成了对应的可见性单元')
          form.resetFields()
          setOpen(false)
          void load()
        }}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="分组名" rules={[{ required: true, message: '请输入分组名' }]}>
            <Input placeholder="如:财务部" />
          </Form.Item>
          <Form.Item
            name="parentId"
            label="上级分组"
            extra="留空为顶级分组。子分组成员会继承上级的知识可见性"
          >
            <Select
              allowClear
              placeholder="可选"
              options={groups.map((g) => ({ value: g.id, label: g.name }))}
            />
          </Form.Item>
          <Form.Item name="description" label="说明">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}
