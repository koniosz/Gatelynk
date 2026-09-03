import { IconCheck } from './icons'

interface Props {
  items: string[]
}

/**
 * „Dobrze wiedzieć" — zasady osiedla z zielonymi checkmarkami (orb 18px).
 * Renderowane WARUNKOWO: backend dziś zwraca pustą listę (brak źródła danych
 * w schemacie — patrz TODO `Building.guestRules` w invite.service.ts), więc
 * sekcja jest ukryta do czasu dodania edycji zasad w panelu BA.
 */
export function Rules({ items }: Props) {
  if (items.length === 0) return null
  return (
    <div className="gli-rules">
      <h3>Dobrze wiedzieć</h3>
      <ul>
        {items.map((rule, idx) => (
          <li key={idx}>
            <span className="gli-chk">
              <IconCheck size={11} strokeWidth={3} />
            </span>
            <span>{rule}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
