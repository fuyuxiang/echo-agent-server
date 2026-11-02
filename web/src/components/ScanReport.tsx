import { Alert, Collapse, List, Space, Tag, Typography } from 'antd'
import { fmtTime } from '../utils/format'

const states:Record<string,string>={clean:'未发现风险',infected:'发现风险',unavailable:'暂不可用',skipped:'未执行',passed:'通过',failed:'未通过'}
const advice:Record<string,string>={ANTIVIRUS_UNAVAILABLE:'检查杀毒服务连接；仅检查服务故障且无其他风险的记录会自动重试。',PUBLICATION_IO_UNAVAILABLE:'检查文件存储与服务状态，恢复后自动重试。',OFFICE_EMBEDDED_OBJECT:'文档包含嵌入对象。请检查对象来源，清理后重新上传，或导出为无主动内容的 PDF。',TEXT_ENCODING_INVALID:'请检查文件是否损坏或编码不受支持，使用 UTF-8 文本或受支持的原始格式重新上传。',SKILL_DANGEROUS_COMMAND:'移除危险命令，确认操作边界后提交新版本。',SKILL_SECRET:'移除疑似凭证并在客户端安全配置中提供，随后提交新版本。'}
export default function ScanReport({report}:{report:any}) {
  if(!report)return <Alert type="info" message="此历史记录未保存独立安全报告"/>
  return <Space direction="vertical" size={16} style={{width:'100%'}}>
    <Typography.Text type="secondary">检查完成：{fmtTime(report.scannedAt)}</Typography.Text>
    <List size="small" dataSource={report.engines??[]} renderItem={(e:any)=><List.Item><span>{e.name==='clamav'?'病毒检查':['static','echo-static'].includes(e.name)?'内容与脚本规则':e.name}</span><Tag color={e.status==='clean'?'success':e.status==='infected'?'error':'warning'}>{states[e.status]??e.status}</Tag></List.Item>}/>
    {(report.findings??[]).length?<div>{report.findings.map((f:any,i:number)=><div className="echo-report-finding" key={i}>
      <Space wrap><Tag color={['critical','high'].includes(f.severity)?'error':'warning'}>{({critical:'高风险',high:'高风险',medium:'需注意',low:'提示'} as any)[f.severity]??'提示'}</Tag><strong>{f.message??f.code}</strong></Space>
      {f.path&&<p>涉及文件：{f.path}</p>}<p className="echo-help">{advice[f.code]??(['critical','high'].includes(f.severity)?'请修正相关内容后重新提交；重新检查不会跳过风险规则。':'请结合实际使用场景检查，技能执行仍受客户端权限控制。')}</p>
    </div>)}</div>:<Alert type="success" showIcon message="本次检查未发现规则覆盖范围内的风险" description="内容可信程度与执行权限仍分别管理。"/>}
    <Collapse size="small" items={[{key:'raw',label:'技术详情',children:<pre className="echo-json">{JSON.stringify(report,null,2)}</pre>}]}/>
  </Space>
}
