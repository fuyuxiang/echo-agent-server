import { useEffect, useState } from 'react'
import { Layout, Menu, Dropdown, Avatar, Badge, Tag, Space } from 'antd'
import {
  FileTextOutlined, AuditOutlined, BulbOutlined, SearchOutlined,
  DashboardOutlined, UserOutlined, TeamOutlined, SettingOutlined,
  LogoutOutlined, SafetyOutlined,
} from '@ant-design/icons'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { loadAuth, clearAuth } from '../store/auth'
import * as api from '../api'

const { Header, Sider, Content } = Layout

const ROLE_LABEL: Record<string, string> = {
  admin: '管理员',
  curator: '知识审核',
  member: '成员',
}

export default function AppLayout() {
  const nav = useNavigate()
  const loc = useLocation()
  const auth = loadAuth()
  const role = auth?.user.role
  const isAdmin = role === 'admin'
  const [pendingCount, setPendingCount] = useState(0)

  // 待审数量放在菜单上:审核队列积压是最容易被忽略的运营问题 ——
  // 没人主动点进去看,提交的人就一直等着。
  useEffect(() => {
    const tick = async (): Promise<void> => {
      try {
        const [promotions, skills] = await Promise.all([
          api.listPromotions('pending'),
          api.listSkillSubmissions('pending'),
        ])
        setPendingCount(promotions.length + skills.length)
      } catch {
        // 静默失败:菜单角标不值得打断使用
      }
    }
    void tick()
    const t = window.setInterval(tick, 60_000)
    return () => clearInterval(t)
  }, [loc.pathname])

  const items = [
    {
      key: '/review',
      icon: <AuditOutlined />,
      label: pendingCount > 0 ? <Badge count={pendingCount} offset={[10, 0]}>待办审核</Badge> : '待办审核',
    },
    { key: 'content', icon: <FileTextOutlined />, label: '知识内容', children: [
      { key: '/documents', label: '文档' },
      { key: '/memories', icon: <BulbOutlined />, label: '组织记忆' },
    ] },
    ...(isAdmin
      ? [
          { key: 'members', icon: <TeamOutlined />, label: '成员与权限', children: [
            { key: '/users', icon: <UserOutlined />, label: '用户' },
            { key: '/groups', label: '分组' },
          ] },
          { key: 'settings', icon: <SettingOutlined />, label: '组织设置', children: [
            { key: '/model-config', label: '模型配置' },
            { key: '/enterprise-policy', label: '客户端策略' },
          ] },
        ]
      : []),
    { key: 'diagnostics', icon: <SearchOutlined />, label: '运行诊断', children: [
      { key: '/search', label: '检索自测' },
      ...(isAdmin ? [
        { key: '/quality', icon: <DashboardOutlined />, label: '质量看板' },
        { key: '/audit', icon: <SafetyOutlined />, label: '审计日志' },
      ] : []),
    ] },
  ]

  const logout = async (): Promise<void> => {
    try {
      await api.logout()
    } catch {
      // 服务端不可达也要能登出,否则用户被困在后台里
    }
    clearAuth()
    nav('/login')
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider theme="dark" collapsible>
        <div
          style={{
            height: 48,
            margin: 16,
            color: '#fff',
            fontWeight: 600,
            textAlign: 'center',
            lineHeight: '48px',
            overflow: 'hidden',
            whiteSpace: 'nowrap',
          }}
        >
          Echo 知识后台
        </div>
        <Menu
          theme="dark"
          mode="inline"
          defaultOpenKeys={['content', 'diagnostics', ...(isAdmin ? ['members', 'settings'] : [])]}
          selectedKeys={[loc.pathname]}
          items={items}
          onClick={(e) => nav(e.key)}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            paddingRight: 24,
          }}
        >
          <Dropdown
            menu={{
              items: [
                { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', onClick: () => void logout() },
              ],
            }}
          >
            <Space style={{ cursor: 'pointer' }}>
              <Avatar size="small" icon={<UserOutlined />} />
              <span>{auth?.user.displayName}</span>
              <Tag color={isAdmin ? 'red' : 'orange'}>{ROLE_LABEL[role ?? ''] ?? role}</Tag>
            </Space>
          </Dropdown>
        </Header>
        <Content style={{ margin: 24 }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
