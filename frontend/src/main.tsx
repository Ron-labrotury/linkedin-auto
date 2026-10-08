import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import App from './App'
import { ApiError } from './api/client'
import { AuthProvider } from './auth/AuthProvider'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // one retry for network / server errors; 4xx answers won't change by asking again
      retry: (count, error) => count < 1 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
      staleTime: 10_000,
      refetchOnWindowFocus: true,
    },
  },
})

// A data router (not <BrowserRouter>) so pages can block navigation while they hold unsaved work
// (useBlocker). App keeps declaring its routes with <Routes> below this catch-all route.
const router = createBrowserRouter([
  {
    path: '*',
    element: (
      <AuthProvider>
        <App />
      </AuthProvider>
    ),
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
