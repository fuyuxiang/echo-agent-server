import { useEffect, useRef, useState } from 'react'
import { Button, Select, Space } from 'antd'
import client from '../api/client'

const labels: Record<string,string>={document:'文档',memory:'经验',skill:'技能'}
export default function AssetPicker({value,onChange,initialAsset,kind}:{value?:string,onChange?:(value:string|undefined)=>void,initialAsset?:any,kind?:string}) {
  const [query,setQuery]=useState(''),[items,setItems]=useState<any[]>([]),[loading,setLoading]=useState(false),[error,setError]=useState(false),[retry,setRetry]=useState(0)
  const seq=useRef(0)
  useEffect(()=>{
    const n=++seq.current
    const timer=setTimeout(()=>{setLoading(true);setError(false);void client.get('/api/v1/admin/knowledge-assets',{params:{q:query,kind}}).then((rows:any)=>{if(n===seq.current)setItems(rows)}).catch(()=>{if(n===seq.current)setError(true)}).finally(()=>{if(n===seq.current)setLoading(false)})},200)
    return()=>{clearTimeout(timer);seq.current++}
  },[query,kind,retry])
  const rows=initialAsset&&!items.some(x=>x.id===initialAsset.id&&x.kind===initialAsset.kind)?[initialAsset,...items]:items
  return <Select aria-label="选择关联知识" showSearch allowClear value={value} onChange={onChange} onSearch={setQuery} filterOption={false} loading={loading}
    placeholder="搜索文档、经验或技能名称" style={{width:'100%'}}
    notFoundContent={error?<Space>知识列表加载失败<Button size="small" onClick={()=>setRetry(x=>x+1)}>重试</Button></Space>:loading?'正在搜索…':'没有可关联的已发布共享知识'}
    options={rows.map(x=>({value:`${x.kind}:${x.id}`,label:`${x.title} · ${labels[x.kind]} · ${x.scopeName}`}))}/>
}
