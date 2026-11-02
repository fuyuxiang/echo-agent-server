import { useSearchParams } from 'react-router-dom'
import DocumentDetail from '../components/DocumentDetail'
import client from '../api/client'
import { useEffect, useState, useCallback, useRef } from 'react'
import {
  Table, Button, Upload, Modal, Form, Select, Input, Tag, Space, Progress,
  Tooltip, Popconfirm, message, Alert, Tabs, Dropdown,
} from 'antd'
import { MoreOutlined, UploadOutlined, InboxOutlined, DownloadOutlined } from '@ant-design/icons'
import type { UploadFile } from 'antd/es/upload/interface'
import * as api from '../api'
import type { DocumentItem, DocStatus, Scope } from '../types'
import { fmtBytes, fmtTime } from '../utils/format'
import SecurityChecks from './SecurityChecks'

const STATUS_META: Record<DocStatus, { color: string; label: string }> = {
  pending: { color: 'default', label: '排队中' },
  parsing: { color: 'processing', label: '解析中' },
  chunking: { color: 'processing', label: '分块中' },
  embedding: { color: 'processing', label: '索引中' },
  ready: { color: 'success', label: '可检索' },
  failed: { color: 'error', label: '失败' },
  archived: { color: 'default', label: '已归档' },
}

const IN_PROGRESS: DocStatus[] = ['pending', 'parsing', 'chunking', 'embedding']

export default function Documents() {
  const [search,setSearch]=useSearchParams()
  useEffect(()=>{const id=search.get('docId');if(id)void api.getDoc(id).then(setDetail).catch(()=>{})},[search.get('docId')])
  const [detail,setDetail]=useState<DocumentItem|null>(null)
  const [statusFilter,setStatusFilter]=useState<string|undefined>(search.get('status')??undefined)
  const [selected,setSelected]=useState<React.Key[]>([])
  const sequence=useRef(0)
  const [items, setItems] = useState<DocumentItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [scopes, setScopes] = useState<Scope[]>([])
  const [scopeFilter, setScopeFilter] = useState<string | undefined>()
  const [keyword, setKeyword] = useState('')
  const [tagFilter, setTagFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [section, setSection] = useState('library')
  const [preview, setPreview] = useState<{ id: string; title: string; text: string; nextSeq: number | null; hasMore: boolean } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const timer = useRef<number | null>(null)

  const load = useCallback(async () => {
    const request=++sequence.current
    setLoading(true)
    try {
      const res = await api.listDocs({
        page,
        size: 20,
        scopeId: scopeFilter,
        q: keyword || undefined,
        tag: tagFilter || undefined,
        view: 'manage',
        status: statusFilter,
      })
      if(request===sequence.current){setItems(res.items);setTotal(res.total)}
    } catch {
      // Shared client presents the error. Filters and selection stay available for retry.
    } finally {
      if(request===sequence.current)setLoading(false)
    }
  }, [page, scopeFilter, keyword, tagFilter,statusFilter])

  useEffect(()=>{setSelected([])},[page,scopeFilter,keyword,tagFilter,statusFilter])
  useEffect(() => { void load() }, [load])
  useEffect(() => { void api.listScopes().then(items => setScopes(items.filter(s => s.kind !== 'personal'))) }, [])

  // 摄取是异步的,不轮询的话管理员会以为卡住了。只在确实有进行中的文档时轮询,
  // 空闲页面不该一直打服务端。
  useEffect(() => {
    const busy = items.some((d) => IN_PROGRESS.includes(d.status))
    if (!busy) {
      if (timer.current) { clearInterval(timer.current); timer.current = null }
      return
    }
    if (timer.current) return
    timer.current = window.setInterval(() => void load(), 2000)
    return () => {
      if (timer.current) { clearInterval(timer.current); timer.current = null }
    }
  }, [items, load])

  const openPreview = async (doc: DocumentItem): Promise<void> => {
    setPreviewLoading(true)
    try {
      const page = await api.getDocumentContent(doc.id)
      setPreview({ id: doc.id, title: doc.title, text: page.text, nextSeq: page.nextSeq, hasMore: page.hasMore })
    } finally { setPreviewLoading(false) }
  }

  const morePreview = async (): Promise<void> => {
    if (!preview?.hasMore || preview.nextSeq == null) return
    setPreviewLoading(true)
    try {
      const page = await api.getDocumentContent(preview.id, preview.nextSeq)
      setPreview((old) => old ? {
        ...old,
        text: `${old.text}\n\n${page.text}`,
        nextSeq: page.nextSeq,
        hasMore: page.hasMore,
      } : old)
    } finally { setPreviewLoading(false) }
  }

  const download = async (doc: DocumentItem | { id: string; title: string }): Promise<void> => {
    const blob = await api.downloadDocRaw(doc.id)
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = doc.title
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
  }

  const columns = [
    {
      title: '标题',
      dataIndex: 'title',
      render: (t: string, r: DocumentItem) => (
        <Space direction="vertical" size={4}>
          <Button type="link" style={{padding:0,height:'auto',whiteSpace:'normal',textAlign:'left'}} onClick={()=>setDetail(r)}>{t}</Button>
          <span style={{ fontSize: 12, color: 'var(--echo-text-muted)' }}>
            {r.sourceType} · {fmtBytes(r.byteSize)} · {r.chunkCount} 个片段
          </span>
          {r.tags.length > 0 && (
            <Space size={4} wrap>
              {r.tags.map((t) => (
                // 标签本身不敏感,但它们会让"看见存在"成为间接泄露
                // (如"董事会"标签出现就知道有相关文档) —— 与标题同权限,
                // 列表的 scope 过滤已经守住。
                <Tag
                  key={t}
                  style={{ cursor: 'pointer' }}
                  onClick={() => { setTagFilter(t); setPage(1) }}
                >{t}</Tag>
              ))}
            </Space>
          )}
        </Space>
      ),
    },
    {
      title: '可见范围',
      dataIndex: 'scopeName',
      width: 130,
      render: (n: string, r: DocumentItem) => (
        <Tag color={r.scopeKind === 'org' ? 'blue' : 'geekblue'}>
          {r.scopeKind === 'org' ? '全公司' : n}
        </Tag>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 150,
      render: (s: DocStatus, r: DocumentItem) => {
        const meta = STATUS_META[s]
        if (s === 'failed') {
          // 失败原因必须能看到 —— 扫描件缺文本层是最常见的一种,
          // 不显示原因管理员只会反复重试。
          return (
            <Tooltip title={r.failReason ?? '未知原因'}>
              <Tag color="error" style={{ cursor: 'help' }}>失败 ⓘ</Tag>
            </Tooltip>
          )
        }
        if (IN_PROGRESS.includes(s)) {
          const idx = IN_PROGRESS.indexOf(s)
          return (
            <Space direction="vertical" size={2} style={{ width: 120 }}>
              <Tag color={meta.color}>{meta.label}</Tag>
              <Progress percent={Math.round(((idx + 1) / 5) * 100)} size="small" showInfo={false} />
            </Space>
          )
        }
        return <Tag color={meta.color}>{meta.label}</Tag>
      },
    },
    { title: '更新时间', dataIndex: 'updatedAt', width: 160, render: fmtTime },
    {
      title: '操作',
      width: 110,
      fixed: 'right' as const,
      render: (_:unknown,r:DocumentItem)=>(
        <Space size={4}>
          <Button size="small" type="link" onClick={()=>setDetail(r)}>详情</Button>
          <Dropdown trigger={['click']} menu={{items:[
            {key:'reindex',label:'重新处理文档',onClick:()=>{void api.reindexDoc(r.id).then(()=>{message.success('已加入处理队列');void load()}).catch(()=>{})}},
            {key:'archive',label:'下线文档',danger:true,onClick:()=>Modal.confirm({title:'确认下线该文档？',content:'立即从检索中移除，保留记录与历史版本。',okButtonProps:{danger:true},onOk:async()=>{await api.deleteDoc(r.id);message.success('已下线');void load()}})},
          ]}}><Button size="small" type="text" aria-label={`更多操作 ${r.title}`} icon={<MoreOutlined/>}/></Dropdown>
        </Space>
      ),
    },
  ]

  return (
    <>
      <Tabs activeKey={section} onChange={setSection} items={[
        { key: 'library', label: '在库文档' },
        { key: 'history', label: '安全检查记录' },
      ]} />
      {section === 'history' ? <SecurityChecks defaultKind="document" /> : <>
      <Space className="echo-toolbar" wrap>
        <Button type="primary" icon={<UploadOutlined />} onClick={() => setUploadOpen(true)}>
          上传文档
        </Button>
        <Select
          allowClear
          placeholder="按可见范围筛选"
          style={{ width: 180 }}
          value={scopeFilter}
          onChange={(v) => { setScopeFilter(v); setPage(1) }}
          options={scopes.filter(s=>(s as Scope & {canPublishDocuments?:boolean}).canPublishDocuments!==false).map((s) => ({
            value: s.id,
            label: s.kind === 'org' ? '全公司' : s.name,
          }))}
        />
        <Input.Search
          placeholder="搜索标题"
          allowClear
          style={{ width: 220 }}
          onSearch={(v) => { setKeyword(v); setPage(1) }}
        />
        <Select allowClear placeholder="全部状态" style={{width:140}} value={statusFilter} onChange={v=>{setStatusFilter(v);setPage(1);setSelected([])}} options={Object.entries(STATUS_META).map(([value,m])=>({value,label:m.label}))}/>
        <Button onClick={()=>void load()}>刷新</Button>
        {tagFilter && (
          <Tag closable onClose={() => { setTagFilter(''); setPage(1) }}>
            标签：{tagFilter}
          </Tag>
        )}
      </Space>

      {selected.length>0&&<Space style={{marginBottom:16}}><span>已选 {selected.length} 份</span><Button onClick={async()=>{const results=await Promise.allSettled(selected.map(id=>api.reindexDoc(String(id))));const failed=results.filter(x=>x.status==='rejected').length;Modal.info({title:'批量操作结果',content:`成功 ${results.length-failed} 份，失败 ${failed} 份。失败项请单独查看原因后重试。`});setSelected([]);void load()}}>批量重建</Button><Popconfirm title="批量下线所选文档？" onConfirm={async()=>{const results=await Promise.allSettled(selected.map(id=>api.deleteDoc(String(id))));const failed=results.filter(x=>x.status==='rejected').length;Modal.info({title:'批量操作结果',content:`成功 ${results.length-failed} 份，失败 ${failed} 份`});setSelected([]);void load()}}><Button danger>批量下线</Button></Popconfirm></Space>}
      <Table
        scroll={{ x: 820 }}
        rowKey="id"
        loading={loading}
        columns={columns}
        rowSelection={{selectedRowKeys:selected,onChange:setSelected,preserveSelectedRowKeys:false}}
        dataSource={items}
        pagination={{
          current: page,
          total,
          pageSize: 20,
          showTotal: (n) => `共 ${n} 份`,
          onChange: setPage,
        }}
      />

      <UploadModal
        open={uploadOpen}
        scopes={scopes}
        onClose={() => setUploadOpen(false)}
        onDone={() => { setUploadOpen(false); void load() }}
      />
      </>}
      <DocumentDetail doc={detail} onClose={()=>{setDetail(null);const next=new URLSearchParams(search);next.delete('docId');setSearch(next,{replace:true})}} onChanged={()=>{void load()}} onPreview={doc=>{void openPreview(doc)}}/>
      <Modal open={!!preview} title={preview?.title} onCancel={() => setPreview(null)} footer={
        <Space>
          {preview?.hasMore && <Button loading={previewLoading} onClick={() => void morePreview()}>加载后续内容</Button>}
          {preview && <Button icon={<DownloadOutlined />} onClick={() => void download(preview)}>下载原件</Button>}
          <Button onClick={() => setPreview(null)}>关闭</Button>
        </Space>
      } width={800}>
        <Alert type="info" showIcon message="预览内容来自知识索引；原件排版可下载查看" style={{ marginBottom: 12 }} />
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '55vh', overflow: 'auto', fontFamily: 'inherit' }}>
          {preview?.text || '暂无可预览的解析内容'}
        </pre>
      </Modal>
    </>
  )
}

function UploadModal({
  open, scopes, onClose, onDone,
}: {
  open: boolean
  scopes: Scope[]
  onClose: () => void
  onDone: () => void
}) {
  const [form] = Form.useForm()
  const [caps,setCaps]=useState<any>(null)
  useEffect(()=>{if(open)void client.get('/api/v1/docs/capabilities').then(setCaps).catch(()=>{})},[open])
  const [outcomes,setOutcomes]=useState<{name:string;state:string}[]>([])
  const [fileList, setFileList] = useState<UploadFile[]>([])
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    const values = await form.validateFields()
    const files=fileList.map(x=>x.originFileObj).filter(Boolean) as File[]
    if(!files.length){message.error('请选择文件');return}
    setBusy(true)
    const results:{name:string;state:string}[]=[]
    try {
      for(const file of files){try{const res=await api.uploadDoc(file,values);results.push({name:file.name,state:res.dedup?'已存在':'已上传'})}catch{results.push({name:file.name,state:'失败，请重试'})}setOutcomes([...results])}
      if(results.every(x=>!x.state.startsWith('失败'))){message.success(`已上传 ${results.length} 份文档`);form.resetFields();setFileList([]);setOutcomes([]);onDone()}
      else setFileList(fileList.filter(x=>results.find(r=>r.name===x.name)?.state.startsWith('失败')))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      title="上传文档"
      onCancel={onClose}
      onOk={submit}
      confirmLoading={busy}
      okText="上传"
      destroyOnClose
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={caps?`可上传：${caps.types.filter((t:any)=>t.available).map((t:any)=>t.extension).join(' / ')}`:'正在读取服务器能力'}
        description={caps?`单文件上限 ${fmtBytes(caps.maxUploadBytes)}；可批量选择。不可用类型：${caps.types.filter((t:any)=>!t.available).map((t:any)=>`${t.extension}（${t.reason}）`).join('；')||'无'}`:undefined}
      />
      <Form form={form} layout="vertical" initialValues={{ sensitivity: 0, volatility: 'stable' }}>
        <Form.Item name="scopeId" label="可见范围" rules={[{ required: true, message: '请选择可见范围' }]}>
          <Select
            placeholder="谁能检索到这份文档"
            options={scopes.filter(s=>(s as Scope & {canPublishDocuments?:boolean}).canPublishDocuments!==false).map((s) => ({
              value: s.id,
              label: s.kind === 'org' ? '全公司' : `${s.name}(团队）`,
            }))}
          />
        </Form.Item>
        <Form.Item name="title" label="标题" extra="留空则用文件名">
          <Input placeholder="可选" />
        </Form.Item>
        <Form.Item name="sensitivity" label="密级" extra="用户只能检索到不高于自身权限的文档">
          <Select
            options={[
              { value: 0, label: '组织内公开' },
              { value: 1, label: '内部' },
              { value: 2, label: '机密' },
            ]}
          />
        </Form.Item>
        <Form.Item
          name="volatility"
          label="时效性"
          extra="易变内容超过 90 天未更新时,答案里会附「可能过时」提示"
        >
          <Select
            options={[
              { value: 'stable', label: '稳定(制度、规范)' },
              { value: 'volatile', label: '易变(临时通知、当期政策)' },
            ]}
          />
        </Form.Item>
        <Form.Item name="tags" label="标签" extra="逗号分隔,便于按主题筛选">
          <Input placeholder="如:财务,报销" />
        </Form.Item>
        <Upload.Dragger
          multiple
          maxCount={30}
          fileList={fileList}
          beforeUpload={file=>{if(caps&&file.size>caps.maxUploadBytes){message.error(`${file.name} 超过上限`);return Upload.LIST_IGNORE}return false}}
          onChange={({fileList:fl})=>setFileList(fl)}
          accept={caps?.types.filter((t:any)=>t.available).map((t:any)=>t.extension.startsWith('.')?t.extension:'.'+t.extension).join(',')}
        >
          <p className="ant-upload-drag-icon"><InboxOutlined /></p>
          <p className="ant-upload-text">点击或拖拽文件到此处</p>
        </Upload.Dragger>
        {outcomes.map(x=><p key={x.name}>{x.name}：{x.state}</p>)}
      </Form>
    </Modal>
  )
}
