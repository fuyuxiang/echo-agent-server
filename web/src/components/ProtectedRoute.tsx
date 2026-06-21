import { Navigate, Outlet } from 'react-router-dom'
import { loadAuth } from '../store/auth'

export default function ProtectedRoute({ adminOnly }: { adminOnly?: boolean }) {
  const auth = loadAuth()
  if (!auth) return <Navigate to="/login" replace />
  if (adminOnly && auth.user.role !== 'admin') return <Navigate to="/memory" replace />
  return <Outlet />
}
