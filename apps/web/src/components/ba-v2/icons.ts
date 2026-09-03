// Mapping nazw używanych przez handoff-suggestions (string „AlertTriangle" etc.)
// na komponenty lucide-react. Trzymamy je w jednym miejscu, żeby ConciergePanel
// dostawał ikonę po nazwie z `t.concierge.suggestions[i].icon`.
import {
  AlertTriangle,
  CarFront,
  Clock,
  CreditCard,
  Home,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";

export const CONCIERGE_ICONS = {
  AlertTriangle,
  CarFront,
  Clock,
  CreditCard,
  Home,
  Sparkles,
  Users,
} satisfies Record<string, LucideIcon>;

export type ConciergeIconName = keyof typeof CONCIERGE_ICONS;
