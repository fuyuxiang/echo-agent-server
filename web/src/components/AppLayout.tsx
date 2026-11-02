import { useState } from 'react'
import { Layout, Menu, Dropdown, Avatar, Breadcrumb, Button, Drawer, Grid, Tag, Tooltip } from 'antd'
import type { MenuProps } from 'antd'
import {
  FileTextOutlined, BulbOutlined, SearchOutlined,
  DashboardOutlined, UserOutlined, TeamOutlined, SettingOutlined,
  LogoutOutlined, SafetyOutlined, MenuFoldOutlined, MenuUnfoldOutlined,
  MoreOutlined, AppstoreOutlined, ApartmentOutlined, RobotOutlined,
} from '@ant-design/icons'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { loadAuth, clearAuth } from '../store/auth'
import * as api from '../api'
import EchoBrand from './EchoBrand'

const { Header, Sider, Content } = Layout

const ROLE_LABEL: Record<string, string> = {
  admin: '管理员',
  curator: '知识维护',
  member: '成员',
}

const PAGE_META: Record<string, { group: string; title: string; description: string }> = {
  '/workspace': { group: '管理控制台', title: '概览', description: '掌握组织知识、安全检查与模型服务的运行情况。' },
  '/usage': { group: '模型服务', title: '用量与排名', description: '了解模型消耗、调用表现与资源分配情况。' },
  '/credentials': { group: '模型服务', title: '用户密钥', description: '管理分配给用户与设备的模型访问凭证。' },
  '/quotas': { group: '模型服务', title: '用量配额', description: '设置资源使用边界，让模型服务稳定可控。' },
  '/skills': { group: '知识资产', title: '技能库', description: '管理可复用的工作能力、版本与分发策略。' },
  '/jobs': { group: '运行与质量', title: '处理任务', description: '追踪文档解析与索引任务，定位失败原因并重试。' },
  '/clients': { group: '运行与质量', title: '客户端状态', description: '查看设备联系、配置确认与技能安装回执。' },
  '/system': { group: '运行与质量', title: '运行与备份', description: '了解服务器能力，安全备份知识资产与管理数据。' },
  '/security': { group: '管理控制台', title: '安全检查', description: '自动检查文档与技能风险，追踪发布状态和拦截原因。' },
  '/documents': { group: '知识资产', title: '文档', description: '集中管理组织文档，为团队提供可检索、可追溯的知识。' },
  '/memories': { group: '知识资产', title: '组织经验', description: '沉淀团队共识与实践经验，让每一次协作都有据可循。' },
  '/users': { group: '成员与客户端', title: '用户', description: '管理组织成员、角色与知识访问权限。' },
  '/groups': { group: '成员与客户端', title: '部门与分组', description: '按团队组织成员，为知识设置合适的可见范围。' },
  '/model-config': { group: '模型服务', title: '模型配置', description: '统一配置组织的对话、嵌入与精排模型。' },
  '/enterprise-policy': { group: '成员与客户端', title: '客户端策略', description: '管理桌面客户端的知识与技能使用策略。' },
  '/search': { group: '运行与质量', title: '检索自测', description: '从真实问题出发，验证知识召回与检索效果。' },
  '/quality': { group: '运行与质量', title: '知识质量', description: '分析知识使用与回答质量，跟进问题处理和复测结果。' },
  '/audit': { group: '运行与质量', title: '审计日志', description: '追踪组织内的关键操作，保留完整的管理记录。' },
}

export default function AppLayout() {
  const nav = useNavigate()
  const loc = useLocation()
  const auth = loadAuth()
  const role = auth?.user.role
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const screens = Grid.useBreakpoint()
  const isMobile = screens.lg === false
  const compact = collapsed && !isMobile
  const page = PAGE_META[loc.pathname] ?? PAGE_META['/documents']

  const items: MenuProps['items'] = [
    { key: '/workspace', icon: <AppstoreOutlined />, label: '概览' },
    { key: '/security', icon: <SafetyOutlined />, label: '安全检查' },
    { key: 'knowledge', type: 'group', label: '知识资产', children: [
      { key: '/documents', icon: <FileTextOutlined />, label: '文档' },
      { key: '/memories', icon: <BulbOutlined />, label: '组织经验' },
      { key: '/skills', icon: <RobotOutlined />, label: '技能库' },
    ] },
    { key: 'models', type: 'group', label: '模型服务', children: [
      { key: '/model-config', icon: <RobotOutlined />, label: '模型配置' },
      { key: '/usage', icon: <DashboardOutlined />, label: '用量与排名' },
      { key: '/credentials', icon: <SafetyOutlined />, label: '用户密钥' },
      { key: '/quotas', icon: <SettingOutlined />, label: '用量配额' },
    ] },
    { key: 'members', type: 'group', label: '成员与客户端', children: [
      { key: '/users', icon: <UserOutlined />, label: '用户' },
      { key: '/groups', icon: <TeamOutlined />, label: '部门与分组' },
      { key: '/clients', icon: <TeamOutlined />, label: '客户端状态' },
      { key: '/enterprise-policy', icon: <SettingOutlined />, label: '客户端策略' },
    ] },
    { key: 'operations', type: 'group', label: '运行与质量', children: [
      { key: '/quality', icon: <DashboardOutlined />, label: '知识质量' },
      { key: '/jobs', icon: <FileTextOutlined />, label: '处理任务' },
      { key: '/search', icon: <SearchOutlined />, label: '检索自测' },
      { key: '/audit', icon: <SafetyOutlined />, label: '审计日志' },
      { key: '/system', icon: <SettingOutlined />, label: '运行与备份' },
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

  const sidebar = (
    <div className={`echo-sidebar-inner${compact ? ' echo-sidebar-inner--compact' : ''}`}>
      <button
        type="button"
        className="echo-sidebar-brand"
        aria-label="Echo Agent 管理控制台"
        onClick={() => { nav('/workspace'); setMobileOpen(false) }}
      >
        <EchoBrand compact={compact} />
        {!compact && <span className="echo-sidebar-brand__caption">管理控制台</span>}
      </button>
      {!compact && <div className="echo-workspace-label"><ApartmentOutlined />知识管理</div>}
      <nav className="echo-navigation" aria-label="主导航">
        <Menu
          mode="inline"
          inlineCollapsed={compact}
          selectedKeys={[loc.pathname]}
          items={items}
          onClick={(e) => { nav(e.key); setMobileOpen(false) }}
        />
      </nav>
      <div className="echo-sidebar-footer">
        <Dropdown
          trigger={['click']}
          placement="topRight"
          menu={{ items: [{ key: 'logout', icon: <LogoutOutlined />, label: '退出登录', onClick: () => void logout() }] }}
        >
          <button type="button" className="echo-account" aria-label={`${auth?.user.displayName ?? '用户'}，账号菜单`}>
            <Avatar size={32} icon={<UserOutlined />} />
            {!compact && <>
              <span className="echo-account__text">
                <strong>{auth?.user.displayName}</strong>
                <span>{ROLE_LABEL[role ?? ''] ?? role}</span>
              </span>
              <MoreOutlined />
            </>}
          </button>
        </Dropdown>
      </div>
    </div>
  )

  return (
    <Layout className="echo-app">
      <a className="echo-skip-link" href="#main-content">跳转到主要内容</a>
      {isMobile ? (
        <Drawer
          className="echo-mobile-navigation"
          title="导航"
          placement="left"
          width={264}
          open={mobileOpen}
          onClose={() => setMobileOpen(false)}
        >
          {sidebar}
        </Drawer>
      ) : (
        <Sider className="echo-sidebar" width={232} collapsedWidth={72} collapsed={collapsed} trigger={null}>
          {sidebar}
        </Sider>
      )}
      <Layout className="echo-workspace">
        <Header className="echo-header">
          <div className="echo-header__navigation">
            <Tooltip title={isMobile ? '打开导航' : collapsed ? '展开侧边栏' : '收起侧边栏'}>
              <Button
                type="text"
                className="echo-sidebar-toggle"
                aria-label={isMobile ? '打开导航' : collapsed ? '展开侧边栏' : '收起侧边栏'}
                aria-expanded={isMobile ? mobileOpen : !collapsed}
                icon={compact || isMobile ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                onClick={() => isMobile ? setMobileOpen(true) : setCollapsed(!collapsed)}
              />
            </Tooltip>
            <Breadcrumb items={[{ title: page.group }, { title: page.title }]} />
          </div>
          <Tag className="echo-console-tag" icon={<AppstoreOutlined />}>管理控制台</Tag>
        </Header>
        <Content id="main-content" className="echo-content" tabIndex={-1}>
          <div className="echo-page">
            <div className="echo-page-heading">
              <h1>{page.title}</h1>
              <p>{page.description}</p>
            </div>
            <div className="echo-page-body">
              <Outlet />
            </div>
          </div>
        </Content>
      </Layout>
    </Layout>
  )
}
