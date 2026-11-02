import { useEffect, useState } from 'react'
import { Alert, Button, Card, Col, Collapse, Form, Input, InputNumber, Modal, Row, Select, Space, Table, Typography, message } from 'antd'
import * as ops from '../api/operations'
import { fmtTime } from '../utils/format'

export default function GatewaySettings({onSaved}:{onSaved?:()=>Promise<void>}={}){
 const [form]=Form.useForm(),[data,setData]=useState<any>(null),[saving,setSaving]=useState(false),[error,setError]=useState(false),[history,setHistory]=useState<any[]>([]),[open,setOpen]=useState(false)
 const protocols=Form.useWatch('protocols',form)??[]
 const load=async()=>{setError(false);try{const value=await ops.getGatewaySettings();setData(value);form.setFieldsValue(value)}catch{setError(true)}}
 useEffect(()=>{void load()},[])
 return <Space direction="vertical" size={20} style={{width:'100%'}}>
  {error&&<Alert type="error" message="网关配置加载失败" action={<Button onClick={()=>void load()}>重试</Button>}/>}
  <Card title="客户端接入"><Typography.Paragraph copyable>{data?.baseUrl??'正在加载模型连接地址…'}</Typography.Paragraph><p className="echo-help">这是下发给客户端的模型地址。成员在桌面端登录组织后自动获取地址与自己的密钥，无需手工分发上游凭证。</p>
   <Collapse items={[{key:'advanced',label:'高级：网关能力、限额与计价',forceRender:true,children:<Form form={form} layout="vertical" onFinish={async()=>{setSaving(true);try{const v=form.getFieldsValue(true);await ops.putGatewaySettings({...v,publicBaseUrl:v.publicBaseUrl??'',inputPrice:v.inputPrice??null,cachedPrice:v.cachedPrice??null,outputPrice:v.outputPrice??null});message.success('网关配置已保存，客户端下次同步获取新版本');await load();await onSaved?.()}catch{}finally{setSaving(false)}}}>
    <Form.Item name="publicBaseUrl" label="对外模型 Base URL" extra="留空自动使用服务器访问地址；反向代理部署时可显式指定。"><Input placeholder={`${location.origin}/api/v1/llm/v1`}/></Form.Item>
    <Row gutter={16}><Col xs={24} md={12}><Form.Item name="maxOutputTokens" label="单次最大输出 Token" rules={[{required:true}]}><InputNumber min={1} max={262144} style={{width:'100%'}}/></Form.Item></Col><Col xs={24} md={12}><Form.Item name="protocols" label="启用的接口能力" rules={[{required:true}]}><Select mode="multiple" options={[{value:'chat',label:'对话（Chat Completions）'},{value:'responses',label:'Responses'},{value:'anthropic',label:'Anthropic Messages'},{value:'images',label:'图像生成'},{value:'speech',label:'语音合成'},{value:'transcription',label:'音频转写'}]}/></Form.Item></Col></Row>
    <p className="echo-help">只启用供应商实际支持的协议；启用能力不代表上游已经可用。</p>
    {(['images','speech','transcription'] as const).filter(x=>protocols.includes(x)).map(x=><Form.Item key={x} name={['models',x]} label={({images:'图像生成模型',speech:'语音合成模型',transcription:'音频转写模型'})[x]} rules={[{required:true,message:'请填写该能力实际使用的模型'}]}><Input/></Form.Item>)}
    <p className="echo-help">以下单价按每百万 Token 估算费用；留空表示未知。价格变更仅影响之后的调用。</p>
    <Row gutter={16}>{[['inputPrice','输入单价'],['cachedPrice','缓存输入单价'],['outputPrice','输出单价']].map(([name,label])=><Col xs={24} sm={8} key={name}><Form.Item name={name} label={label}><InputNumber min={0} style={{width:'100%'}}/></Form.Item></Col>)}</Row>
    <Form.Item name="currency" label="计价币种"><Select style={{maxWidth:240}} options={[{value:'CNY',label:'人民币'},{value:'USD',label:'美元'}]}/></Form.Item>
    <Button type="primary" htmlType="submit" loading={saving} disabled={!data}>保存网关设置</Button>
   </Form>} ]}/>
  </Card>
  <Collapse items={[{key:'history',label:'配置变更历史与恢复',children:<><p className="echo-help">保留历史模型与计价快照，恢复时生成新配置版本。历史调用的统计口径不变。</p><Button onClick={async()=>{try{setHistory(await ops.getConfigHistory());setOpen(true)}catch{}}}>查看历史版本</Button></>} ]}/>
  <Modal title="配置历史" open={open} onCancel={()=>setOpen(false)} width={800} footer={null}><Table rowKey="id" dataSource={history} pagination={{pageSize:8}} columns={[{title:'保存时间',dataIndex:'createdAt',render:fmtTime},{title:'对话模型',render:(_:unknown,h:any)=>h.config?.chat_model??'初始环境配置'},{title:'上游地址',render:(_:unknown,h:any)=>h.config?.chat_base_url??'—'},{title:'',render:(_:unknown,h:any)=>h.config&&<Button onClick={()=>Modal.confirm({title:'恢复此模型与网关配置？',content:'恢复会发布新版本，请随后执行保存并验证连接。',onOk:async()=>{await ops.rollbackConfig(h.id);message.success('配置已恢复');location.reload()}})}>恢复</Button>} ]}/></Modal>
 </Space>
}
