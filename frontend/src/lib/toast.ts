import { create } from 'zustand'
import { uid } from './utils'

export interface Toast {
  id: string
  message: string
  tone: 'info' | 'success' | 'error'
}

interface ToastState {
  toasts: Toast[]
  push: (message: string, tone?: Toast['tone']) => void
  dismiss: (id: string) => void
}

export const useToasts = create<ToastState>()((set, get) => ({
  toasts: [],
  push: (message, tone = 'info') => {
    const id = uid('toast')
    set((s) => ({ toasts: [...s.toasts, { id, message, tone }] }))
    setTimeout(() => get().dismiss(id), 4500)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

export const toast = (message: string, tone?: Toast['tone']) => useToasts.getState().push(message, tone)
