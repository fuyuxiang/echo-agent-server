import client from '../api/client'
import { Modal, Table } from 'antd'
import { fmtTime } from '../utils/format'
import { useEffect, useState } from 'react'
import { Alert, Button, Card, Form, InputNumber, Space, Spin, Switch, message } from 'antd'
import * as api from '../api'
import type { EnterprisePolicy as Policy } from '../types'

export default function EnterprisePolicy(): JSX.Element {
  const [history,setHistory]=useState<any[]|null>(null)
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
      message.success('策略已发布，客户端下次同步应用；可在设备与同步中查看回执')
    } finally { setSaving(false) }
  }
  return <Space direction="vertical" size={16} style={{ width: '100%' }}>
    <Alert showIcon type="info" message={`当前客户端策略 v${policy.version}`} description="客户端同步后应用；设备离线时，撤销在重新连接或租约到期后生效。应用进度可在设备与同步查看。" />
    <Card extra={<Button onClick={()=>void client.get('/api/v1/admin/enterprise-policy/history').then(x=>setHistory(x as unknown as any[])).catch(()=>{})}>历史版本</Button>}>
      <Form layout="vertical" style={{ maxWidth: 560 }}>
        <Form.Item label="允许本地知识"><Switch checked={policy.allowLocalKnowledge} onChange={(value) => update('allowLocalKnowledge', value)} /></Form.Item>
        <Form.Item label="允许个人云知识"><Switch checked={policy.allowPersonalCloud} onChange={(value) => update('allowPersonalCloud', value)} /></Form.Item>
        <Form.Item label="允许提交 Skill"><Switch checked={policy.allowSkillSubmission} onChange={(value) => update('allowSkillSubmission', value)} /></Form.Item>
        <Form.Item label="允许企业内容离线缓存" extra="关闭后将停止离线同步；离线设备在重新连接或租约到期后应用撤销。"><Switch checked={policy.offlineEnterpriseContent} onChange={(value) => update('offlineEnterpriseContent', value)} /></Form.Item>
        <Form.Item label="组织技能离线使用时限（小时）"><InputNumber min={1} max={168} value={policy.managedSkillLeaseHours} onChange={(value) => update('managedSkillLeaseHours', value ?? 24)} /></Form.Item>
        <Form.Item><Button type="primary" loading={saving} onClick={() => void save()}>发布策略</Button></Form.Item>
      </Form>
    </Card>
    <Modal title="策略历史" open={!!history} onCancel={()=>setHistory(null)} footer={null}><Table rowKey="version" dataSource={history??[]} columns={[{title:'版本',dataIndex:'version',render:(v:number)=>`v${v}`},{title:'发布时间',dataIndex:'createdAt',render:fmtTime},{title:'',render:(_:unknown,h:any)=><Button onClick={()=>Modal.confirm({title:`恢复 v${h.version} 的策略内容？`,content:'会发布一个更高版本，客户端仍执行版本防回退校验。',onOk:async()=>{const p:any=await client.post(`/api/v1/admin/enterprise-policy/history/${h.version}/restore`);setPolicy(p);setHistory(null);message.success('已重新签名发布')}})}>恢复</Button>}]} /></Modal>
  </Space>
}
