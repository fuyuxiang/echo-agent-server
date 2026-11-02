import RouteErrorBoundary from './components/RouteErrorBoundary'
import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'

const Workspace = lazy(() => import('./pages/Operations').then(m => ({default:m.Workspace})))
const Usage = lazy(() => import('./pages/Operations').then(m => ({default:m.Usage})))
const Credentials = lazy(() => import('./pages/Operations').then(m => ({default:m.Credentials})))
const Quotas = lazy(() => import('./pages/Operations').then(m => ({default:m.Quotas})))
const Jobs = lazy(() => import('./pages/Operations').then(m => ({default:m.Jobs})))
const Clients = lazy(() => import('./pages/Operations').then(m => ({default:m.Clients})))
const Skills = lazy(() => import('./pages/Operations').then(m => ({default:m.Skills})))
const System = lazy(() => import('./pages/Operations').then(m => ({default:m.System})))
const ProtectedRoute = lazy(() => import('./components/ProtectedRoute'))
const AppLayout = lazy(() => import('./components/AppLayout'))
const Login = lazy(() => import('./pages/Login'))
const Documents = lazy(() => import('./pages/Documents'))
const SecurityChecks = lazy(() => import('./pages/SecurityChecks'))
const Memories = lazy(() => import('./pages/Memories'))
const MemberDetail = lazy(() => import('./pages/MemberDetail'))
const Users = lazy(() => import('./pages/Users'))
const Groups = lazy(() => import('./pages/Groups'))
const ModelConfig = lazy(() => import('./pages/ModelConfig'))
const Quality = lazy(() => import('./pages/Quality'))
const Audit = lazy(() => import('./pages/Audit'))
const EnterprisePolicy = lazy(() => import('./pages/EnterprisePolicy'))

function RouteLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="echo-route-loading"
    >
      正在加载…
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <RouteErrorBoundary><Suspense fallback={<RouteLoading />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<ProtectedRoute />}>
            <Route element={<AppLayout />}>
              <Route path="/workspace" element={<Workspace />} />
              <Route path="/security" element={<SecurityChecks />} />
              <Route path="/review" element={<Navigate to="/security" replace />} />
              <Route path="/documents" element={<Documents />} />
              <Route path="/memories" element={<Memories />} />
              <Route path="/skills" element={<Skills />} />
              <Route path="/model-config" element={<ModelConfig />} />
              <Route path="/usage" element={<Usage />} />
              <Route path="/credentials" element={<Credentials />} />
              <Route path="/quotas" element={<Quotas />} />
              <Route path="/users" element={<Users />} />
              <Route path="/users/:id" element={<MemberDetail />} />
              <Route path="/groups" element={<Groups />} />
              <Route path="/clients" element={<Clients />} />
              <Route path="/enterprise-policy" element={<EnterprisePolicy />} />
              <Route path="/quality" element={<Quality />} />
              <Route path="/jobs" element={<Jobs />} />
              <Route path="/search" element={<Navigate to="/quality?tab=test" replace />} />
              <Route path="/audit" element={<Audit />} />
              <Route path="/system" element={<System />} />
              <Route path="/submissions" element={<Navigate to="/workspace" replace />} />
              <Route path="/notifications" element={<Navigate to="/workspace" replace />} />
              <Route path="/maintenance" element={<Navigate to="/quality?tab=maintenance" replace />} />
              <Route path="/" element={<Navigate to="/workspace" replace />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense></RouteErrorBoundary>
    </BrowserRouter>
  )
}
