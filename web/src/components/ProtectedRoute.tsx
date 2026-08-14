import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { Result, Button } from 'antd'
import { loadAuth } from '../store/auth'

/**
 * 路由守卫。
 *
 * 这只是导航体验:防止用户点进一个必然 403 的页面。真正的鉴权在服务端,
 * 每个接口都会独立校验角色与可见范围 —— 绕过前端守卫拿不到任何数据。
 */
export default function ProtectedRoute({
  adminOnly = false,
  reviewerOnly = false,
}: {
  adminOnly?: boolean
  reviewerOnly?: boolean
}) {
  const loc = useLocation()
  const auth = loadAuth()

  if (!auth) return <Navigate to="/login" replace state={{ from: loc.pathname }} />

  const role = auth.user.role
  const allowed = adminOnly
    ? role === 'admin'
    : reviewerOnly
      ? role === 'admin' || role === 'curator'
      : true

  if (!allowed) {
    return (
      <Result
        status="403"
        title="没有权限"
        subTitle={
          role === 'member'
            ? '普通成员请使用桌面客户端提问与沉淀知识,后台仅供管理与审核使用。'
            : '当前角色无法访问该页面。'
        }
        extra={
          <Button type="primary" href={role === 'member' ? '/login' : '/documents'}>
            返回
          </Button>
        }
      />
    )
  }

  return <Outlet />
}
