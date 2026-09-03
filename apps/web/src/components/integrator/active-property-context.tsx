'use client'
/**
 * ActivePropertyContext — w pamięci sesji trzyma id+nazwę aktualnie wybranego
 * obiektu integrator-a. Sidebar pokazuje dynamiczną sekcję „Aktywny obiekt"
 * gdy istnieje. PropertyPage przy mount ustawia, lista obiektów czyści.
 *
 * Wybrałem context (nie zustand) — proste, brak external deps, w Next.js
 * z React 19 server components context działa tylko w client wrappers, więc
 * dokleimy go wewnątrz layout-u który już jest `use client`.
 */
import { createContext, useContext, useState, useCallback } from 'react'
import type { ReactNode } from 'react'

export interface ActiveProperty {
  id: number
  name: string
  address?: string
}

interface ActivePropertyContextValue {
  active: ActiveProperty | null
  setActive: (p: ActiveProperty | null) => void
  clear: () => void
}

const ActivePropertyContext = createContext<ActivePropertyContextValue | null>(null)

export function ActivePropertyProvider({ children }: { children: ReactNode }) {
  const [active, setActiveState] = useState<ActiveProperty | null>(null)
  const setActive = useCallback((p: ActiveProperty | null) => setActiveState(p), [])
  const clear = useCallback(() => setActiveState(null), [])
  return (
    <ActivePropertyContext.Provider value={{ active, setActive, clear }}>
      {children}
    </ActivePropertyContext.Provider>
  )
}

export function useActiveProperty() {
  const ctx = useContext(ActivePropertyContext)
  if (!ctx) throw new Error('useActiveProperty must be used inside <ActivePropertyProvider>')
  return ctx
}
