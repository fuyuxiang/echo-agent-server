import { useEffect, useState } from 'react'
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Result, Button, Spin } from 'antd'
import { clearAuth, loadAuth, saveAuth } from '../store/auth'
import { me } from '../api'

/**
 * 路由守卫。
 *
 * 这只是导航体验:防止用户点进一个必然 403 的页面。真正的鉴权在服务端,
 * 每个接口都会独立校验角色与可见范围 —— 绕过前端守卫拿不到任何数据。
 */
export default function ProtectedRoute() {
  const loc = useLocation()
  const navigate = useNavigate()
  const auth = loadAuth()
  const userId = auth?.user.id
  const role = auth?.user.role
  const [verified, setVerified] = useState(false)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (role !== 'admin') return
    let cancelled = false
    setVerified(false)
    setError(false)
    void me().then(user => {
      if (cancelled) return
      const current = loadAuth()
      if (!current || current.user.id !== userId) return
      if (user.role !== 'admin') {
        clearAuth()
        navigate('/login', { replace: true })
        return
      }
      saveAuth({ ...current, user })
      setVerified(true)
    }).catch((e: { response?: { status?: number } }) => {
      if (cancelled) return
      if (e.response?.status === 401 || e.response?.status === 403) {
        clearAuth()
        navigate('/login', { replace: true })
      } else setError(true)
    })
    return () => { cancelled = true }
  }, [userId, role, attempt, navigate])

  if (!auth) return <Navigate to="/login" replace state={{ from: loc.pathname }} />

  if (role !== 'admin') {
    return (
      <Result
        status="403"
        title="仅管理员可访问"
        subTitle="此页面为服务端管理后台，成员请使用 Echo Agent 桌面端。"
        extra={
          <Button type="primary" onClick={() => { clearAuth(); navigate('/login', { replace: true }) }}>
            返回登录
          </Button>
        }
      />
    )
  }

  if (error) return <Result status="warning" title="无法验证管理员身份" subTitle="请检查网络连接后重试。" extra={<Button onClick={() => setAttempt(n => n + 1)}>重试</Button>} />
  if (!verified) return <div className="echo-route-loading" role="status"><Spin tip="正在验证管理员身份…"><div style={{ padding: 32 }} /></Spin></div>

  return <Outlet />
}
