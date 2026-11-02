import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Form, Input, Modal, Select, Space, Table, Tag, message } from 'antd'
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import { useSearchParams } from 'react-router-dom'
import * as ops from '../api/operations'
import * as api from '../api'
import client from '../api/client'
import AssetPicker from './AssetPicker'
import { fmtTime } from '../utils/format'

export default function MaintenanceList(){
 const [search,setSearch]=useSearchParams(),[items,setItems]=useState<any[]>([]),[users,setUsers]=useState<any[]>([]),[editing,setEditing]=useState<any>(null),[loading,setLoading]=useState(false),[saving,setSaving]=useState(false),[testing,setTesting]=useState(false),[error,setError]=useState(false),[state,setState]=useState<string>(),[form]=Form.useForm()
 const status=Form.useWatch('state',form),assetValue=Form.useWatch('assetValue',form)
 const load=useCallback(async()=>{setLoading(true);setError(false);try{setItems(await ops.getMaintenance())}catch{setError(true)}finally{setLoading(false)}},[])
 useEffect(()=>{void load();void api.listUsers().then(setUsers).catch(()=>{})},[load])
 const open=useCallback((x:any)=>{setEditing(x);form.resetFields();form.setFieldsValue({question:x.question??'',ownerId:x.owner_id??undefined,note:x.note??'',state:x.state??'open',assetValue:x.resultAsset?`${x.resultAsset.kind}:${x.resultAsset.id}`:undefined,verificationNote:''})},[form])
 useEffect(()=>{const id=search.get('taskId');if(id&&!editing){const item=items.find(x=>x.id===id);if(item)open(item)}},[search,items,open])
 const close=()=>{setEditing(null);const next=new URLSearchParams(search);next.delete('taskId');setSearch(next,{replace:true})}
 const parseAsset=(value:string|undefined)=>{if(!value)return{resultAssetId:null,resultAssetKind:null};const pos=value.indexOf(':');return{resultAssetKind:value.slice(0,pos),resultAssetId:value.slice(pos+1)}}
 const hasMatched=editing?.verification?.method==='retrieval'&&editing.verification.matched&&assetValue===`${editing.verification.assetKind}:${editing.verification.assetId}`
 const retest=async()=>{
  const asset=parseAsset(assetValue);if(!asset.resultAssetId){message.warning('请先选择需要验证的知识');return}
  setTesting(true)
  try{const result:any=await client.post(`/api/v1/admin/maintenance/${editing.id}/retest`,{version:editing.version,assetId:asset.resultAssetId,assetKind:asset.resultAssetKind});setEditing({...editing,version:result.version,verification:result,result_asset_id:result.assetId,result_asset_kind:result.assetKind});void load();message.info(result.matched?'已检索到关联知识，请检查内容后保存复测结论':'未检索到关联知识，请调整内容或记录人工复测依据')}catch{}finally{setTesting(false)}
 }
 return <Space direction="vertical" size={16} style={{width:'100%'}}>
  <p className="echo-help">管理员跟进知识盲区和负反馈，关联补充材料，完成复测后关闭。成员通过桌面端反馈问题或补充知识。</p>
  {error&&<Alert type="error" message="维护清单加载失败" action={<Button onClick={()=>void load()}>重试</Button>}/>}
  <div className="echo-section-top"><Space><Button type="primary" icon={<PlusOutlined/>} onClick={()=>open({})}>新建维护事项</Button><Select allowClear placeholder="全部状态" style={{width:150}} value={state} onChange={setState} options={Object.entries({open:'待处理',working:'处理中',verified:'复测通过',closed:'已关闭'}).map(([value,label])=>({value,label}))}/></Space><Button icon={<ReloadOutlined/>} loading={loading} onClick={()=>void load()}>刷新</Button></div>
  <Table scroll={{x:800}} rowKey="id" loading={loading} dataSource={items.filter(x=>!state||x.state===state)} pagination={{pageSize:15}} columns={[
   {title:'需要解决的问题',dataIndex:'question'}, {title:'负责管理员',render:(_:unknown,x:any)=><Space direction="vertical" size={0}><span>{x.ownerName??'待认领'}</span>{x.ownerName&&!x.ownerCanManage&&<Tag color="warning">需重新指派管理员</Tag>}</Space>},
   {title:'关联知识',render:(_:unknown,x:any)=>x.resultAsset?.title??(x.result_asset_id?'原关联内容已不可用':'尚未关联')},
   {title:'状态',dataIndex:'state',render:(s:string,row:any)=><Tag color={s==='verified'?'success':s==='closed'?'default':'processing'}>{row.closure_reason==='no_action'?'无需维护':({open:'待处理',working:'处理中',verified:'复测通过',closed:'已关闭'} as any)[s]}</Tag>},
   {title:'更新时间',dataIndex:'updated_at',render:fmtTime},{title:'',render:(_:unknown,x:any)=><Button type="link" onClick={()=>open(x)}>查看与处理</Button>}
  ]}/>
  <Modal title={editing?.id?'知识维护与复测':'新建维护事项'} open={!!editing} onCancel={close} width={680} confirmLoading={saving} okButtonProps={{disabled:editing?.state==='closed'&&status==='closed'}} okText="保存" onOk={()=>form.submit()}>
   <Form form={form} layout="vertical" onFinish={async values=>{setSaving(true);try{
    const {assetValue,verificationNote,...fields}=values
    if(editing.id)await ops.patchMaintenance(editing.id,{...fields,version:editing.version,ownerId:fields.ownerId??null,...parseAsset(assetValue),verificationNote:verificationNote?.trim()||undefined})
    else await ops.createMaintenance(fields)
    message.success('维护事项已保存');close();await load()
   }catch{}finally{setSaving(false)}}}>
    <Form.Item name="question" label="需要解决的问题" rules={[{required:true}]}><Input.TextArea rows={3} disabled={!!editing?.id}/></Form.Item>
    <Form.Item name="ownerId" label="负责管理员" extra="任务仅在管理端处理；不向普通成员分派后台任务。"><Select allowClear showSearch optionFilterProp="label" options={users.filter(x=>x.role==='admin'&&x.status==='active').map(x=>({value:x.id,label:x.displayName}))}/></Form.Item>
    {editing?.id&&<>
      <Form.Item name="assetValue" label="补充或修正的知识" rules={['verified','closed'].includes(status)?[{required:true,message:'请选择本次维护所关联的已发布知识'}]:[]}><AssetPicker initialAsset={editing.resultAsset}/></Form.Item>
      <Space wrap style={{marginBottom:16}}><Button onClick={()=>void retest()} loading={testing} disabled={!assetValue||assetValue.startsWith('skill:')||editing.state==='closed'}>执行检索复测</Button><span className="echo-muted">按管理员自己的检索权限验证，会产生实际模型用量</span></Space>
      {editing.verification&&<Alert style={{marginBottom:16}} type={hasMatched?'success':'info'} showIcon message={editing.verification.method==='retrieval'?(editing.verification.matched?'检索已命中关联知识':'本次检索未命中关联知识'):'已有人工复测记录'} description={`复测时间：${fmtTime(editing.verification.at)}${editing.verification.note?' · '+editing.verification.note:''}`}/>}
      <Form.Item name="state" label="处理状态"><Select options={[{value:'open',label:'待处理'},{value:'working',label:'处理中'},{value:'verified',label:'复测通过'},{value:'closed',label:'关闭（须先保存复测通过）'}]}/></Form.Item>
      {status==='verified'&&!hasMatched&&<Form.Item name="verificationNote" label="人工复测依据" extra="技能请记录客户端执行步骤与结果；文档或经验请记录实际验证的问题与结论。" rules={[{required:true,min:5,message:'请记录实际复测过程与结果，至少 5 个字符'}]}><Input.TextArea rows={3} maxLength={4000}/></Form.Item>}
    </>}
    {editing?.id&&editing.state!=='closed'&&<Button style={{marginBottom:16}} onClick={()=>{const note=form.getFieldValue('note')?.trim();if(!note||note.length<3){message.warning('请先在处理说明填写无需维护的原因，至少 3 个字符');return}Modal.confirm({title:'标记此事项无需维护？',content:'用于重复问题、误报或不适用问题。记录保留，不会标记为复测通过。',onOk:async()=>{await client.post(`/api/v1/admin/maintenance/${editing.id}/dismiss`,{version:editing.version,note});message.success('已记录为无需维护');close();await load()}})}}>标记无需维护</Button>}
    <Form.Item name="note" label="处理说明" rules={['verified','closed'].includes(status)?[{required:true,message:'请填写维护与复测结论'}]:[]}><Input.TextArea rows={3} maxLength={4000}/></Form.Item>
   </Form>
  </Modal>
 </Space>
}
