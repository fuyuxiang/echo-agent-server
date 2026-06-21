import { Layout, Menu, Dropdown, Avatar } from 'antd'
import { UserOutlined, TeamOutlined, SettingOutlined, DatabaseOutlined, LogoutOutlined } from '@ant-design/icons'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { loadAuth, clearAuth } from '../store/auth'

const { Header, Sider, Content } = Layout

export default function AppLayout() {
  const nav = useNavigate()
  const loc = useLocation()
  const auth = loadAuth()
  const isAdmin = auth?.user.role === 'admin'

  const items = [
    ...(isAdmin ? [
      { key: '/users', icon: <UserOutlined />, label: '用户管理' },
      { key: '/groups', icon: <TeamOutlined />, label: '分组管理' },
      { key: '/model-config', icon: <SettingOutlined />, label: '模型配置' },
    ] : []),
    { key: '/memory', icon: <DatabaseOutlined />, label: '记忆查看' },
  ]

  const logout = () => { clearAuth(); nav('/login') }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider theme="dark" collapsible>
        <div style={{ height: 48, margin: 16, color: '#fff', fontWeight: 600, textAlign: 'center', lineHeight: '48px' }}>Echo Admin</div>
        <Menu theme="dark" mode="inline" selectedKeys={[loc.pathname]} items={items} onClick={(e) => nav(e.key)} />
      </Sider>
      <Layout>
        <Header style={{ background: '#fff', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', paddingRight: 24 }}>
          <Dropdown menu={{ items: [{ key: 'logout', icon: <LogoutOutlined />, label: '退出登录', onClick: logout }] }}>
            <span style={{ cursor: 'pointer' }}><Avatar size="small" icon={<UserOutlined />} /> {auth?.user.username}</span>
          </Dropdown>
        </Header>
        <Content style={{ margin: 24 }}><Outlet /></Content>
      </Layout>
    </Layout>
  )
}
