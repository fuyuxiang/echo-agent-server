import { useState } from 'react'
import { Form, Input, Button } from 'antd'
import { UserOutlined, LockOutlined, FileTextOutlined, TeamOutlined, SafetyOutlined, ArrowRightOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import * as api from '../api'
import { saveAuth } from '../store/auth'
import EchoBrand from '../components/EchoBrand'

export default function Login() {
  const nav = useNavigate()
  const [busy, setBusy] = useState(false)

  const submit = async (v: { username: string; password: string }): Promise<void> => {
    setBusy(true)
    try {
      const auth = await api.login(v.username, v.password)
      saveAuth(auth)
      nav('/workspace', { replace: true })
    } catch {
      // 客户端拦截器已经弹了服务端的错误信息(统一为"用户名或密码错误",
      // 不区分账号是否存在),这里不重复提示。
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="echo-login">
      <div className="echo-login-shell">
        <aside className="echo-login-intro">
          <div className="echo-login-brand"><EchoBrand /><span>管理控制台</span></div>
          <div className="echo-login-story">
            <span className="echo-eyebrow">团队的知识，持续生长</span>
            <h2>让经验沉淀，<br />让协作更进一步。</h2>
            <p>连接桌面端与组织知识，让可靠的信息<br className="echo-desktop-break" />在团队中有序流动。</p>
            <div className="echo-login-capabilities">
              <div><FileTextOutlined /><span><strong>知识沉淀</strong><small>集中管理文档与组织记忆</small></span></div>
              <div><TeamOutlined /><span><strong>团队协作</strong><small>安全检查后自动发布共享内容</small></span></div>
              <div><SafetyOutlined /><span><strong>有序管理</strong><small>统一成员权限与客户端策略</small></span></div>
            </div>
          </div>
          <span className="echo-login-intro__footer">Echo Agent · 组织知识与协作</span>
        </aside>
        <section className="echo-login-form" aria-labelledby="login-title">
          <div className="echo-login-form__heading">
            <span className="echo-eyebrow">欢迎回来</span>
            <h1 id="login-title">登录管理控制台</h1>
            <p>使用管理员账号，管理组织知识与模型服务。</p>
          </div>
          <Form onFinish={submit} size="large" layout="vertical" requiredMark={false}>
            <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
              <Input prefix={<UserOutlined />} placeholder="用户名" autoComplete="username" />
            </Form.Item>
            <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
              <Input.Password
                prefix={<LockOutlined />}
                placeholder="密码"
                autoComplete="current-password"
              />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={busy} icon={<ArrowRightOutlined />} iconPosition="end">
              管理员登录
            </Button>
          </Form>
          <p className="echo-login-hint"><LockOutlined />连续 5 次登录失败将临时锁定账号</p>
          <p className="echo-login-access">仅管理员可登录此后台，成员请使用 Echo Agent 桌面端</p>
        </section>
      </div>
    </main>
  )
}
