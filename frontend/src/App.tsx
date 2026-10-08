import { lazy } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { RequireAuth } from './auth/RequireAuth'
import AppLayout from './components/layout/AppLayout'
import { Toaster } from './components/ui'
import Login from './pages/auth/Login'
import Signup from './pages/auth/Signup'
import Connect from './pages/Connect'
import Dashboard from './pages/Dashboard'
import Settings from './pages/Settings'
import Teams from './pages/Teams'

// the sequence builder (React Flow) is the heaviest part of the app – load it on demand
const Campaigns = lazy(() => import('./pages/Campaigns'))
const NewCampaign = lazy(() => import('./pages/campaign/NewCampaign'))
const CampaignDetail = lazy(() => import('./pages/campaign/CampaignDetail'))

export default function App() {
  return (
    <>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route element={<RequireAuth />}>
          <Route path="/connect" element={<Connect />} />
          <Route element={<AppLayout />}>
            <Route index element={<Dashboard />} />
            <Route path="campaigns" element={<Campaigns />} />
            <Route path="campaigns/new" element={<NewCampaign />} />
            <Route path="campaigns/:id" element={<CampaignDetail />} />
            <Route path="teams" element={<Teams />} />
            <Route path="settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Route>
      </Routes>
      <Toaster />
    </>
  )
}
