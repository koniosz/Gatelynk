"use client";
// TabBar — pasek zakładek z licznikami obok labelek. Active state przez
// usePathname — porównujemy ostatni segment (`/overview`, `/residents` …).
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  Bell,
  BookOpen,
  Camera,
  CarFront,
  CreditCard,
  Cpu,
  Home,
  ShieldCheck,
  Sparkles,
  Truck,
  UserPlus,
  Users,
} from "lucide-react";
import { useBaLang } from "./LangProvider";
import { useBuildingFeatures } from "./BuildingFeaturesContext";

interface TabCounts {
  residents?: number;
  units?: number;
  vehicles?: number;
  guests?: number;
  issues?: number;
  payments?: number;
  notifications?: number;
  security?: number;
  devices?: number;
  courierVisits?: number;
  lprReads?: number;
}

export function TabBar({ buildingId, counts }: { buildingId: number; counts?: TabCounts }) {
  const pathname = usePathname();
  const { t } = useBaLang();
  // FAZA e — conditional rendering tabów based na permissions BA.
  const { hasBaFeature } = useBuildingFeatures();

  const allTabs: {
    id: keyof TabCounts | "overview" | "knowledge" | "situations";
    href: string;
    icon: typeof Users;
    label: string;
    count?: number;
    feature?: string; // FAZA e — `feat_<key>`; brak = zawsze widoczny
  }[] = [
    { id: "overview", href: `/building-admin/v2/buildings/${buildingId}/overview`, icon: Sparkles, label: t.tabs.overview },
    { id: "residents", href: `/building-admin/v2/buildings/${buildingId}/residents`, icon: Users, label: t.tabs.residents, count: counts?.residents },
    { id: "units", href: `/building-admin/v2/buildings/${buildingId}/units`, icon: Home, label: t.tabs.units, count: counts?.units },
    { id: "vehicles", href: `/building-admin/v2/buildings/${buildingId}/vehicles`, icon: CarFront, label: t.tabs.vehicles, count: counts?.vehicles, feature: "vehicles" },
    { id: "guests", href: `/building-admin/v2/buildings/${buildingId}/guests`, icon: UserPlus, label: t.tabs.guests, count: counts?.guests, feature: "guests" },
    { id: "issues", href: `/building-admin/v2/buildings/${buildingId}/issues`, icon: AlertTriangle, label: t.tabs.issues, count: counts?.issues, feature: "tickets" },
    { id: "payments", href: `/building-admin/v2/buildings/${buildingId}/payments`, icon: CreditCard, label: t.tabs.payments, count: counts?.payments, feature: "payments" },
    { id: "notifications", href: `/building-admin/v2/buildings/${buildingId}/notifications`, icon: Bell, label: t.tabs.notifications, count: counts?.notifications, feature: "notifications" },
    { id: "security", href: `/building-admin/v2/buildings/${buildingId}/security`, icon: ShieldCheck, label: t.tabs.security, count: counts?.security, feature: "lpr_audit" },
    // Sprint 2026-06-12 — odczyty LPR przeniesione do v2 (legacy strona zostaje).
    { id: "lprReads", href: `/building-admin/v2/buildings/${buildingId}/lpr-reads`, icon: Camera, label: t.tabs.lprReads, count: counts?.lprReads, feature: "lpr_audit" },
    // 2026-08-26 — zdarzenia sytuacyjne z korelatora Edge + Kronika dnia.
    { id: "situations", href: `/building-admin/v2/buildings/${buildingId}/situations`, icon: Activity, label: t.tabs.situations, feature: "vision_dashboard" },
    { id: "courierVisits", href: `/building-admin/v2/buildings/${buildingId}/courier-visits`, icon: Truck, label: t.tabs.courierVisits, count: counts?.courierVisits, feature: "courier_visits" },
    { id: "devices", href: `/building-admin/v2/buildings/${buildingId}/devices`, icon: Cpu, label: t.tabs.devices, count: counts?.devices },
    // Baza wiedzy AI — dokumenty/kontakty czytane przez asystenta (GateLynk AI).
    // Strona v2 opakowuje istniejący legacy widok (patrz knowledge/page.tsx).
    { id: "knowledge", href: `/building-admin/v2/buildings/${buildingId}/knowledge`, icon: BookOpen, label: t.tabs.knowledge },
  ];
  const tabs = allTabs.filter((tab) => !tab.feature || hasBaFeature(tab.feature));

  return (
    <div className="ba-tabs" role="tablist">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        // Active match z href (ostatni segment URL). Dla `courier-visits`
        // tab.id="courierVisits" nie pasuje do path-a — bierzemy hash z href.
        const lastSeg = tab.href.split("/").pop() ?? "";
        const active = pathname?.endsWith(`/${lastSeg}`) ?? false;
        return (
          <Link key={tab.id} href={tab.href} className={"ba-tab" + (active ? " active" : "")} role="tab" aria-selected={active}>
            <Icon size={14} />
            <span>{tab.label}</span>
            {tab.count != null ? <span className="count">{tab.count}</span> : null}
          </Link>
        );
      })}
    </div>
  );
}
