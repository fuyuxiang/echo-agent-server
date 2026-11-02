import { useEffect, useState } from 'react'
import { Alert, Button, Card, Collapse, Descriptions, Form, Input, InputNumber, Select, Space, Spin, Tag, message } from 'antd'
import GatewaySettings from '../components/GatewaySettings'
import * as api from '../api'
import * as ops from '../api/operations'
import type { ModelConfig as Cfg } from '../types'
import { fmtTime } from '../utils/format'

export default function ModelConfig(){
 const [form]=Form.useForm(),[cfg,setCfg]=useState<Cfg|null>(null),[busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState(false)
 const embed=Form.useWatch('embedModel',form),embedChanged=!!cfg&&!!embed&&embed!==cfg.embedModel
 const load=async()=>{setLoading(true);setError(false);try{const c=await api.getModelConfig();setCfg(c);form.setFieldsValue({chatProvider:c.chatProvider??'openai-compatible',chatModel:c.chatModel??'',chatBaseUrl:c.chatBaseUrl??'',embedModel:c.embedModel??'embed-pro',embedDim:c.embedDim??1024,rerankModel:c.rerankModel??'',vlmModel:c.vlmModel??''})}catch{setError(true)}finally{setLoading(false)}}
 useEffect(()=>{void load()},[])
 if(loading&&!cfg)return <Spin/>
 if(error&&!cfg)return <Alert type="error" message="模型配置加载失败" action={<Button onClick={()=>void load()}>重试</Button>}/>
 const check=(cfg as any)?.connectionCheck
 return <Space direction="vertical" size={20} style={{width:'100%'}}>
  {error&&<Alert type="error" message="刷新失败，请重试" action={<Button onClick={()=>void load()}>刷新</Button>}/>}
  <Card title="上游连接" extra={<Tag color={check?.success?'success':check?'error':'default'}>{check?.success?'最近验证成功':check?'最近验证未通过':'尚未验证当前配置'}</Tag>}>
   <p className="echo-help">配置真实模型服务。成员通过服务器网关使用模型，真实上游密钥保存在服务器。</p>
   {check&&<Alert style={{marginBottom:20}} showIcon type={check.success?'success':'error'} message={check.message} description={`验证于 ${fmtTime(check.checkedAt)} · ${check.latencyMs} ms${check.httpStatus?' · HTTP '+check.httpStatus:''}`} />}
   <Form form={form} layout="vertical" style={{maxWidth:760}} onFinish={async()=>{setBusy(true);let saved=false;try{
    await api.putModelConfig(form.getFieldsValue(true));saved=true;form.setFieldValue('chatKey',undefined)
    const result=await ops.testModel();message[result.success?'success':'warning'](result.success?'配置已保存，实际连接验证成功':'配置已保存，实际连接验证未通过');await load()
   }catch{if(saved)await load()}finally{setBusy(false)}}}>
    <Form.Item name="chatProvider" label="接口类型" rules={[{required:true}]}><Select options={[{value:'openai-compatible',label:'OpenAI 兼容服务（含 MiniMax / 模型网关）'},{value:'openai',label:'OpenAI 官方接口'}]}/></Form.Item>
    <Form.Item name="chatBaseUrl" label="上游 Base URL" extra="填写供应商的兼容 API 地址；OpenAI 官方接口可留空"><Input placeholder="https://供应商地址/v1" autoComplete="off"/></Form.Item>
    <Form.Item name="chatModel" label="对话模型" rules={[{required:true,message:'请填写上游已授权的模型名称'}]}><Input placeholder="填写供应商提供的模型名称"/></Form.Item>
    <Form.Item name="chatKey" label={<Space>上游 API Key{cfg?.hasCredential&&<Tag color="success">已保存</Tag>}</Space>} extra={cfg?.hasCredential?'留空保留现有密钥，填写则更新':'首次配置需要填写真实密钥'} rules={cfg?.hasCredential?[]:[{required:true,message:'请填写上游 API Key'}]}><Input.Password autoComplete="off"/></Form.Item>
    <Collapse style={{marginBottom:20}} items={[{key:'retrieval',label:'知识检索与多模态设置',forceRender:true,children:<>
     <Descriptions size="small" column={1} items={[{key:'embed',label:'语义检索引擎',children:cfg?.runtime?.semantic?'真实语义模型已配置':'尚未配置真实语义模型'},{key:'rerank',label:'精排引擎',children:cfg?.runtime?.crossEncoder?'真实精排模型已配置':'尚未配置真实精排模型'}]}/>
     <Form.Item name="embedModel" label="嵌入模型" rules={[{required:true}]}><Input/></Form.Item>
     <Form.Item name="embedDim" label="当前索引向量维度" extra="维度由现有索引固定；修改维度需要迁移，不能直接热切换。"><InputNumber disabled style={{width:'100%'}}/></Form.Item>
     {embedChanged&&<Alert type="warning" showIcon message="更换嵌入模型后需要重建文档索引" description="保存后可在文档库批量选择并重建；新模型与旧向量不能混用。" style={{marginBottom:16}}/>}
     <Form.Item name="rerankModel" label="精排模型"><Input/></Form.Item><Form.Item name="vlmModel" label="图像理解模型"><Input placeholder="可选"/></Form.Item>
    </>} ]}/>
    <Button type="primary" htmlType="submit" loading={busy} disabled={!cfg}>保存并验证连接</Button><p className="echo-help">验证会产生一次实际模型调用。保存成功与连接成功分别记录，失败原因保留在上方。</p>
   </Form>
  </Card>
  <GatewaySettings onSaved={async()=>setCfg(await api.getModelConfig())}/>
 </Space>
}
