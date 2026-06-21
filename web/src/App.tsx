import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import ProtectedRoute from './components/ProtectedRoute'
import AppLayout from './components/AppLayout'
import Login from './pages/Login'
import Users from './pages/Users'
import Groups from './pages/Groups'
import ModelConfig from './pages/ModelConfig'
import Memory from './pages/Memory'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<ProtectedRoute />}>
          <Route element={<AppLayout />}>
            <Route path="/memory" element={<Memory />} />
            <Route element={<ProtectedRoute adminOnly />}>
              <Route path="/users" element={<Users />} />
              <Route path="/groups" element={<Groups />} />
              <Route path="/model-config" element={<ModelConfig />} />
            </Route>
            <Route path="/" element={<Navigate to="/memory" replace />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
