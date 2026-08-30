import { useEffect, useState } from 'react'
import { Alert, Button, Card, Form, InputNumber, Space, Spin, Switch, Typography, message } from 'antd'
import * as api from '../api'
import type { EnterprisePolicy as Policy } from '../types'

export default function EnterprisePolicy(): JSX.Element {
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => { void api.getEnterprisePolicy().then(setPolicy) }, [])
  if (!policy) return <Spin />
  const update = <K extends keyof Policy>(key: K, value: Policy[K]): void => {
    setPolicy((current) => current ? { ...current, [key]: value } : current)
  }
  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const next = await api.updateEnterprisePolicy({
        allowLocalKnowledge: policy.allowLocalKnowledge,
        allowPersonalCloud: policy.allowPersonalCloud,
        allowSkillSubmission: policy.allowSkillSubmission,
        offlineEnterpriseContent: policy.offlineEnterpriseContent,
        managedSkillLeaseHours: policy.managedSkillLeaseHours,
      })
      setPolicy(next)
      message.success('策略已签名发布，客户端下次启动/轮询生效')
    } finally { setSaving(false) }
  }
  return <Space direction="vertical" size={16} style={{ width: '100%' }}>
    <Typography.Title level={3} style={{ margin: 0 }}>托管客户端策略</Typography.Title>
    <Alert showIcon type="info" message={`当前签名策略版本：v${policy.version}`} description="客户端只接受服务端签名且未过期的策略，并拒绝版本回退。" />
    <Card>
      <Form labelCol={{ span: 8 }} wrapperCol={{ span: 12 }}>
        <Form.Item label="允许本地知识"><Switch checked={policy.allowLocalKnowledge} onChange={(value) => update('allowLocalKnowledge', value)} /></Form.Item>
        <Form.Item label="允许个人云知识"><Switch checked={policy.allowPersonalCloud} onChange={(value) => update('allowPersonalCloud', value)} /></Form.Item>
        <Form.Item label="允许提交 Skill"><Switch checked={policy.allowSkillSubmission} onChange={(value) => update('allowSkillSubmission', value)} /></Form.Item>
        <Form.Item label="允许企业内容离线"><Switch checked={policy.offlineEnterpriseContent} onChange={(value) => update('offlineEnterpriseContent', value)} /></Form.Item>
        <Form.Item label="Skill 租约（小时）"><InputNumber min={1} max={168} value={policy.managedSkillLeaseHours} onChange={(value) => update('managedSkillLeaseHours', value ?? 24)} /></Form.Item>
        <Form.Item wrapperCol={{ offset: 8 }}><Button type="primary" loading={saving} onClick={() => void save()}>签名发布</Button></Form.Item>
      </Form>
    </Card>
  </Space>
}
