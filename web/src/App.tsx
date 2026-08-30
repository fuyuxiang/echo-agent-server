import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'

const ProtectedRoute = lazy(() => import('./components/ProtectedRoute'))
const AppLayout = lazy(() => import('./components/AppLayout'))
const Login = lazy(() => import('./pages/Login'))
const Documents = lazy(() => import('./pages/Documents'))
const Review = lazy(() => import('./pages/Review'))
const Memories = lazy(() => import('./pages/Memories'))
const SearchTest = lazy(() => import('./pages/SearchTest'))
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
      style={{ minHeight: '40vh', display: 'grid', placeItems: 'center', color: '#64748b' }}
    >
      正在加载…
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<RouteLoading />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<ProtectedRoute />}>
            <Route element={<AppLayout />}>
              {/* curator 与 admin 都能进 */}
              <Route element={<ProtectedRoute reviewerOnly />}>
                <Route path="/documents" element={<Documents />} />
                <Route path="/review" element={<Review />} />
                <Route path="/memories" element={<Memories />} />
                <Route path="/search" element={<SearchTest />} />
                <Route path="/quality" element={<Quality />} />
              </Route>
              {/* 仅 admin */}
              <Route element={<ProtectedRoute adminOnly />}>
                <Route path="/users" element={<Users />} />
                <Route path="/groups" element={<Groups />} />
                <Route path="/model-config" element={<ModelConfig />} />
                <Route path="/audit" element={<Audit />} />
                <Route path="/enterprise-policy" element={<EnterprisePolicy />} />
              </Route>
              <Route path="/" element={<Navigate to="/documents" replace />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  )
}
