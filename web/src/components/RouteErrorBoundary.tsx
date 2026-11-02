import { Component, type ReactNode } from 'react'

/** A stale lazy chunk or rendering error must leave a recoverable page. */
export default class RouteErrorBoundary extends Component<{children:ReactNode},{failed:boolean}> {
  state={failed:false}
  static getDerivedStateFromError(){return {failed:true}}
  render(){
    if(this.state.failed)return <main className="echo-error-card" role="alert"><h1>页面暂时无法显示</h1><p>界面可能已更新，或本次加载出现异常。请刷新后重试。</p><p className="echo-help">未保存的表单内容可能需要重新填写。</p><button onClick={()=>location.reload()}>刷新页面</button></main>
    return this.props.children
  }
}
