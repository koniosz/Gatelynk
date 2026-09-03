"use client";
// `/building-admin/v2/buildings/[id]` → redirect do /overview.
import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";

export default function BaV2BuildingRoot() {
  const params = useParams();
  const router = useRouter();
  const id = Array.isArray(params?.id) ? params.id[0] : params?.id;

  useEffect(() => {
    if (id) router.replace(`/building-admin/v2/buildings/${id}/overview`);
  }, [id, router]);

  return null;
}
