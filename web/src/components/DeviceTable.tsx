import { useState } from 'react'
import { Alert, Button, Descriptions, Drawer, Empty, Popconfirm, Space, Table, Tag, message } from 'antd'
import { Link } from 'react-router-dom'
import * as ops from '../api/operations'
import { fmtTime } from '../utils/format'

function receiptItems(value:string|null){try{const rows=JSON.parse(value??'null');return Array.isArray(rows)?rows:[]}catch{return []}}
export default function DeviceTable({items,loading,reload,policyVersion,configRevision,showUser=true}:{items:any[],loading:boolean,reload:()=>Promise<void>,policyVersion?:number,configRevision?:number,showUser?:boolean}){
 const [detail,setDetail]=useState<any>(null)
 const reported=items.filter(x=>x.heartbeatAt).length,receipts=items.filter(x=>x.receiptJson!=null).length
 const version=(actual:number|null,current:number|undefined)=>actual==null?'未确认':`${actual}${current!=null&&actual<current?' · 待同步':''}`
 return <Space direction="vertical" size={16} style={{width:'100%'}}>
  <Alert type="info" showIcon message={`心跳覆盖 ${reported}/${items.length} 台 · 安装回执覆盖 ${receipts}/${items.length} 台`} description="未上报表示尚无应用回执，无法据此判断离线。更新后的客户端会定期上报；旧版需更新并重新连接。"/>
  <div className="echo-help">当前客户端策略 v{policyVersion??'—'} · 模型配置 v{configRevision??'—'}</div>
  <Table scroll={{x:850}} rowKey={x=>`${x.userId}-${x.deviceId}`} loading={loading} dataSource={items} pagination={{pageSize:15}} columns={[
   ...(showUser?[{title:'成员',render:(_:unknown,x:any)=><Link to={`/users/${x.userId}`}>{x.displayName}</Link>}]:[]),
   {title:'设备',render:(_:unknown,x:any)=><Space direction="vertical" size={0}><strong>{x.name??'设备名称未上报'}</strong><small className="echo-muted">{x.platform??'平台未上报'} · {x.version??'版本未上报'}</small></Space>},
   {title:'最近联系',dataIndex:'lastContact',render:fmtTime},
   {title:'连接状态',render:(_:unknown,x:any)=><Tag color={!x.heartbeatAt?'default':Date.now()-x.heartbeatAt<180000?'success':'warning'}>{!x.heartbeatAt?'未上报':Date.now()-x.heartbeatAt<180000?'近期在线':'心跳已过期'}</Tag>},
   {title:'策略 / 模型回执',render:(_:unknown,x:any)=><Space direction="vertical" size={0}><small>策略：{version(x.policyVersion,policyVersion)}</small><small>模型：{version(x.configRevision,configRevision)}</small></Space>},
   {title:'操作',render:(_:unknown,x:any)=><Space><Button type="link" onClick={()=>setDetail(x)}>详情</Button><Popconfirm title="撤销此设备的会话和模型密钥？" description="该设备需要重新登录；历史记录保留。" onConfirm={async()=>{try{await ops.revokeDevice(x.userId,x.deviceId);message.success('已撤销设备凭证');await reload()}catch{}}}><Button type="link" danger>撤销</Button></Popconfirm></Space>}
  ]}/>
  <Drawer title="设备与应用回执" open={!!detail} onClose={()=>setDetail(null)} width={640}>{detail&&<Space direction="vertical" size={20} style={{width:'100%'}}>
    <Descriptions column={1} bordered items={[{key:'name',label:'设备',children:detail.name??'未上报'},{key:'id',label:'设备标识',children:detail.deviceId},{key:'heart',label:'最近心跳',children:fmtTime(detail.heartbeatAt)}]}/>
    <h3>技能应用回执</h3><p className="echo-help">最近回执：{fmtTime(detail.skillReceiptAt)}；这是客户端上报的应用结果。</p>{detail.skillReceiptsComplete===0&&<Alert type="warning" showIcon message="本次技能同步未完整完成，下列为已确认的部分回执"/>}{detail.receiptJson==null?<Empty description="尚未上报技能安装回执"/>:<Table rowKey={(x:any)=>`${x.skillId}-${x.versionId}`} dataSource={receiptItems(detail.receiptJson)} pagination={{pageSize:10}} locale={{emptyText:'已上报：当前没有已安装的组织技能'}} columns={[{title:'技能',render:(_:unknown,x:any)=>x.name??x.skillId},{title:'版本',render:(_:unknown,x:any)=>x.version??x.versionId},{title:'结果',dataIndex:'state',render:(s:string)=><Tag color={s==='installed'?'success':s==='failed'?'error':'default'}>{({installed:'已安装',removed:'已移除',failed:'安装失败'} as any)[s]??s}</Tag>},{title:'原因',dataIndex:'error',render:(s:string)=>s??'—'}]}/>}
  </Space>}</Drawer>
 </Space>
}
