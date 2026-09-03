import { IconLock } from './icons'

export function Brand() {
  return (
    <div className="gli-brand">
      <div className="gli-brand-mark">
        <div className="gli-brand-dot">G</div>
        <span>Gatelynk</span>
      </div>
      <div className="gli-secure-chip">
        <IconLock />
        Bezpieczne zaproszenie
      </div>
    </div>
  )
}
