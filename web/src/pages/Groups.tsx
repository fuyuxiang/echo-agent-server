import { useEffect, useState } from 'react'
import { Button, Card, Form, Input, Modal, Table, message } from 'antd'
import { listGroups, createGroup } from '../api/admin'
import type { Group } from '../types'

export default function Groups() {
  const [data, setData] = useState<Group[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()

  const reload = async () => {
    setLoading(true)
    try { setData(await listGroups()) } finally { setLoading(false) }
  }
  useEffect(() => { reload() }, [])

  const onCreate = async (v: { name: string }) => {
    await createGroup(v.name)
    message.success('分组已创建')
    setOpen(false); form.resetFields(); reload()
  }

  return (
    <Card title="分组管理" extra={<Button type="primary" onClick={() => setOpen(true)}>新建分组</Button>}>
      <Table rowKey="id" loading={loading} dataSource={data} columns={[
        { title: 'ID', dataIndex: 'id' },
        { title: '名称', dataIndex: 'name' },
      ]} />
      <Modal title="新建分组" open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()}>
        <Form form={form} layout="vertical" onFinish={onCreate}>
          <Form.Item label="分组名称" name="name" rules={[{ required: true, message: '请输入分组名称' }]}>
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
