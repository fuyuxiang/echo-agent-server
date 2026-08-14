import { useState } from 'react'
import { Card, Form, Input, Button, Typography } from 'antd'
import { UserOutlined, LockOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import * as api from '../api'
import { saveAuth } from '../store/auth'

export default function Login() {
  const nav = useNavigate()
  const [busy, setBusy] = useState(false)

  const submit = async (v: { username: string; password: string }): Promise<void> => {
    setBusy(true)
    try {
      const auth = await api.login(v.username, v.password)
      saveAuth(auth)
      // curator 没有用户管理权限,落到审核队列;其余人进文档管理。
      nav(auth.user.role === 'curator' ? '/review' : '/documents', { replace: true })
    } catch {
      // 客户端拦截器已经弹了服务端的错误信息(统一为"用户名或密码错误",
      // 不区分账号是否存在),这里不重复提示。
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#f0f2f5',
      }}
    >
      <Card style={{ width: 380 }}>
        <Typography.Title level={4} style={{ textAlign: 'center', marginBottom: 4 }}>
          Echo 知识管理后台
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ textAlign: 'center' }}>
          组织记忆平台
        </Typography.Paragraph>
        <Form onFinish={submit} size="large">
          <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input prefix={<UserOutlined />} placeholder="用户名" autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password
              prefix={<LockOutlined />}
              placeholder="密码"
              autoComplete="current-password"
            />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={busy}>
            登录
          </Button>
        </Form>
        <Typography.Paragraph
          type="secondary"
          style={{ fontSize: 12, marginTop: 12, marginBottom: 0, textAlign: 'center' }}
        >
          连续 5 次失败会临时锁定,请稍后再试
        </Typography.Paragraph>
      </Card>
    </div>
  )
}
