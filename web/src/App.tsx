import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import ProtectedRoute from './components/ProtectedRoute'
import AppLayout from './components/AppLayout'
import Login from './pages/Login'
import Documents from './pages/Documents'
import Review from './pages/Review'
import Memories from './pages/Memories'
import SearchTest from './pages/SearchTest'
import Users from './pages/Users'
import Groups from './pages/Groups'
import ModelConfig from './pages/ModelConfig'
import Quality from './pages/Quality'
import Audit from './pages/Audit'
import EnterprisePolicy from './pages/EnterprisePolicy'

export default function App() {
  return (
    <BrowserRouter>
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
    </BrowserRouter>
  )
}
