import * as ops from '../api/operations'
import { useEffect, useState, useCallback } from 'react'
import { Table, Button, Modal, Form, Input, Select, Space, Tag, message, Alert, Popconfirm } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import * as api from '../api'
import type { Group } from '../types'

export default function Groups() {
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(false)
  const [editing,setEditing]=useState<Group|null>(null)
  const [saving,setSaving]=useState(false)
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
    {title:'操作',width:150,render:(_:unknown,g:Group)=><Space><Button type="link" onClick={()=>{setEditing(g);form.setFieldsValue({...g});setOpen(true)}}>编辑</Button><Popconfirm title="删除此分组？" description="仅空分组可删除，有成员、子分组或知识记录时会阻止删除。" onConfirm={async()=>{try{await ops.deleteGroup(g.id);message.success('已删除');void load()}catch{}}}><Button type="link" danger>删除</Button></Popconfirm></Space>},
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

      <Space className="echo-toolbar" wrap>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => {setEditing(null);form.resetFields();setOpen(true)}}>
          新建分组
        </Button>
      </Space>

      <Table scroll={{ x: 720 }} rowKey="id" loading={loading} columns={columns} dataSource={groups} pagination={false} />

      <Modal
        open={open}
        title={editing?'编辑分组':'新建分组'}
        confirmLoading={saving}
        onCancel={() => setOpen(false)}
        destroyOnClose
        onOk={async () => {
          const v = await form.validateFields()
          setSaving(true)
          try {
          if(editing)await ops.patchGroup(editing.id,{...v,parentId:v.parentId??null});else await api.createGroup(v)
          message.success(editing?'已更新':'已创建，并生成可见性单元')
          form.resetFields()
          setOpen(false)
          void load()
          }catch{}finally{setSaving(false)}
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
              options={groups.filter(g=>g.id!==editing?.id).map((g) => ({ value: g.id, label: g.name }))}
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
