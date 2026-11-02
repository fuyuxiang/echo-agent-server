import { Card, Collapse, Empty, Table } from 'antd'
import { useId } from 'react'

export default function UsageTrend({items}:{items:any[]}) {
  const id=useId()
  if(items.length&&items.every(x=>x.knownCalls===0))return <Empty description="当前调用的用量尚待核对，暂不绘制实际 Token 趋势"/>
  if(!items.length)return <Empty description="当前时间范围内暂无调用记录"/>
  const rows:any[]=[]
  const first=Date.parse(items[0].day+'T00:00:00+08:00'),last=Date.parse(items[items.length-1].day+'T00:00:00+08:00')
  const byDay=new Map(items.map(x=>[x.day,x]))
  for(let day=first;day<=last;day+=86400000){const key=new Date(day+28800000).toISOString().slice(0,10);rows.push(byDay.get(key)??{day:key,totalTokens:0,calls:0})}
  const known=(row:any)=>row.knownCalls!==0||row.calls===0
  const segments:number[][]=[];rows.forEach((row,i)=>{if(!known(row))return;if(i===0||!known(rows[i-1]))segments.push([]);segments[segments.length-1].push(i)})
  const max=Math.max(1,...rows.map(x=>x.totalTokens)),x=(i:number)=>58+i*690/Math.max(1,rows.length-1),y=(v:number)=>190-v/max*150
  return <Card title="每日实际 Token 用量"><div className="echo-chart-key"><span>峰值 {max===1&&rows.every(x=>!x.totalTokens)?0:max.toLocaleString('zh-CN')} Token / 日</span><span className="echo-muted">未返回的 Token 不计为零消耗，待核对数单独展示</span></div>
    <svg className="echo-line-chart" viewBox="0 0 800 230" role="img" aria-labelledby={id}>
      <title id={id}>从 {rows[0].day} 到 {rows[rows.length-1].day} 的每日 Token 用量，详细数值可展开数据表</title>
      {[0,.5,1].map(v=><g key={v}><line x1="58" x2="748" y1={y(v*max)} y2={y(v*max)} stroke="var(--echo-border)"/><text x="48" y={y(v*max)+4} textAnchor="end">{Math.round(v*max).toLocaleString('zh-CN')}</text></g>)}
      {segments.map((segment,index)=><polyline key={index} points={segment.map(i=>`${x(i)},${y(rows[i].totalTokens)}`).join(' ')} fill="none" stroke="var(--echo-brand)" strokeWidth="2.5"/>)}
      {rows.map((r,i)=>known(r)?<circle key={r.day} cx={x(i)} cy={y(r.totalTokens)} r={rows.length<40?3:2} fill="var(--echo-brand)"><title>{r.day}：{r.totalTokens.toLocaleString('zh-CN')} Token，{r.calls} 次调用</title></circle>:null)}
      <text x="58" y="220">{rows[0].day}</text><text x="748" y="220" textAnchor="end">{rows[rows.length-1].day}</text>
    </svg>
    <Collapse size="small" items={[{key:'data',label:'查看每日数据',children:<Table rowKey="day" dataSource={rows} pagination={{pageSize:15}} columns={[{title:'日期',dataIndex:'day'},{title:'实际 Token',dataIndex:'totalTokens',render:(n:number,row:any)=>known(row)?n.toLocaleString('zh-CN'):'待核对'},{title:'调用次数',dataIndex:'calls'}]}/>} ]}/>
  </Card>
}
