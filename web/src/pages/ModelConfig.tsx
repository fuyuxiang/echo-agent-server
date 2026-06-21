import { useEffect, useState } from 'react'
import { Button, Card, Form, Input, Switch, Tag, message } from 'antd'
import { getModelConfig, updateModelConfig } from '../api/modelConfig'
import type { ModelConfig } from '../types'

export default function ModelConfigPage() {
  const [cfg, setCfg] = useState<ModelConfig | null>(null)
  const [loading, setLoading] = useState(false)
  const [form] = Form.useForm()

  const reload = async () => {
    setLoading(true)
    try {
      const c = await getModelConfig()
      setCfg(c)
      form.setFieldsValue({ baseUrl: c.baseUrl, modelName: c.modelName, allowLocalOverride: c.allowLocalOverride, credential: '' })
    } finally { setLoading(false) }
  }
  useEffect(() => { reload() }, [])

  const onSave = async (v: { baseUrl?: string; modelName?: string; credential?: string; allowLocalOverride: boolean }) => {
    const payload: Parameters<typeof updateModelConfig>[0] = {
      baseUrl: v.baseUrl || null,
      modelName: v.modelName || null,
      allowLocalOverride: v.allowLocalOverride,
    }
    if (v.credential) payload.credential = v.credential
    await updateModelConfig(payload)
    message.success('模型配置已保存')
    reload()
  }

  return (
    <Card title="模型配置" loading={loading}>
      <Form form={form} layout="vertical" style={{ maxWidth: 520 }} onFinish={onSave}>
        <Form.Item label="Base URL" name="baseUrl"><Input placeholder="https://api.openai.com/v1" /></Form.Item>
        <Form.Item label="模型名称" name="modelName"><Input placeholder="gpt-4o-mini" /></Form.Item>
        <Form.Item label={<span>凭证 API Key {cfg && <Tag color={cfg.hasCredential ? 'green' : 'default'}>{cfg.hasCredential ? '已配置' : '未配置'}</Tag>}</span>}
          name="credential" extra="留空则不修改现有凭证">
          <Input.Password placeholder="输入以更新凭证" autoComplete="new-password" />
        </Form.Item>
        <Form.Item label="允许本地覆盖" name="allowLocalOverride" valuePropName="checked"><Switch /></Form.Item>
        <Button type="primary" htmlType="submit">保存</Button>
      </Form>
    </Card>
  )
}
