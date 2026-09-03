"use client";
// Mt940Tab — import wyciągu bankowego MT940 (wariant „wspólne konto"):
// upload pliku → parser server-side → przegląd transakcji z auto-dopasowaniem
// do lokali → zatwierdzenie (hurtem dopasowane + ręczny wybór niedopasowanych).
//
// Endpointy:
//   POST /building-admin/buildings/:id/payments/mt940/preview  { contentBase64, fileName }
//   POST /building-admin/buildings/:id/payments/mt940/confirm  { fileHash, items[] }
//
// Plik czytany jako ArrayBuffer i wysyłany base64 — konwersję windows-1250 → utf8
// robi backend (banki PL często eksportują w cp1250).
import { useMemo, useRef, useState } from "react";
import { CheckCircle2, FileUp, Landmark, Upload } from "lucide-react";
import { buildingAdminApi } from "@/lib/building-admin-api";

type MatchReason = "UNIT_NUMBER" | "RESIDENT_NAME" | "AMOUNT" | null;

interface PreviewItem {
  index: number;
  valueDate: string;
  amount: number;
  title: string | null;
  senderName: string | null;
  rawDetails: string;
  reference: string | null;
  suggestedUnitId: number | null;
  suggestedUnitNumber: string | null;
  suggestedChargeId: number | null;
  matchReason: MatchReason;
  duplicate: boolean;
}

interface PreviewResponse {
  fileHash: string;
  fileName: string | null;
  accountNumber: string | null;
  statementNumber: string | null;
  alreadyImported: boolean;
  importedAt: string | null;
  creditCount: number;
  totalTransactions: number;
  matchedCount: number;
  items: PreviewItem[];
  units: { id: number; number: string; street: string | null }[];
}

interface ItemState {
  include: boolean;
  unitId: number | null;
}

const REASON_LABEL: Record<Exclude<MatchReason, null>, string> = {
  UNIT_NUMBER: "nr lokalu w tytule",
  RESIDENT_NAME: "nazwisko mieszkańca",
  AMOUNT: "dokładna kwota naliczenia",
};

const fmtPln = (n: number) => `${n.toFixed(2)} PLN`;
const fmtDate = (iso: string) => iso.slice(0, 10);
const unitLabel = (u: { number: string; street: string | null }) =>
  u.street ? `${u.street} ${u.number}` : u.number;

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function Mt940Tab({ buildingId }: { buildingId: number }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [itemState, setItemState] = useState<Record<number, ItemState>>({});
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<{ saved: number; skippedDuplicates: number } | null>(null);

  const onFile = async (file: File) => {
    setError(null);
    setResult(null);
    setPreview(null);
    setUploading(true);
    try {
      const buf = await file.arrayBuffer();
      const res = await buildingAdminApi.post<PreviewResponse>(
        `/building-admin/buildings/${buildingId}/payments/mt940/preview`,
        { contentBase64: bufferToBase64(buf), fileName: file.name },
      );
      setPreview(res.data);
      const st: Record<number, ItemState> = {};
      for (const it of res.data.items) {
        st[it.index] = {
          include: !it.duplicate && it.suggestedUnitId !== null,
          unitId: it.suggestedUnitId,
        };
      }
      setItemState(st);
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } };
      setError(e2.response?.data?.message ?? "Błąd przetwarzania pliku MT940");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const toSave = useMemo(() => {
    if (!preview) return [];
    return preview.items.filter((it) => {
      const st = itemState[it.index];
      return st?.include && st.unitId !== null;
    });
  }, [preview, itemState]);

  const confirm = async () => {
    if (!preview || toSave.length === 0) return;
    setConfirming(true);
    setError(null);
    try {
      const res = await buildingAdminApi.post<{ saved: number; skippedDuplicates: number }>(
        `/building-admin/buildings/${buildingId}/payments/mt940/confirm`,
        {
          fileHash: preview.fileHash,
          fileName: preview.fileName ?? undefined,
          accountNumber: preview.accountNumber,
          statementNumber: preview.statementNumber,
          transactionCount: preview.creditCount,
          items: toSave.map((it) => ({
            unitId: itemState[it.index].unitId as number,
            amount: it.amount,
            valueDate: it.valueDate,
            title: it.title,
            senderName: it.senderName,
            reference: it.reference,
          })),
        },
      );
      setResult(res.data);
      setPreview(null);
      setItemState({});
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } };
      setError(e2.response?.data?.message ?? "Błąd zapisu importu");
    } finally {
      setConfirming(false);
    }
  };

  const setItem = (index: number, patch: Partial<ItemState>) => {
    setItemState((prev) => ({ ...prev, [index]: { ...prev[index], ...patch } }));
  };

  const matchedItems = preview?.items.filter((it) => it.suggestedUnitId !== null) ?? [];
  const unmatchedItems = preview?.items.filter((it) => it.suggestedUnitId === null) ?? [];

  return (
    <>
      {/* Upload */}
      <div className="ba-panel" style={{ marginBottom: 16 }}>
        <div className="ba-panel-head">
          <div className="ba-panel-title">
            <Landmark size={16} />
            Import wyciągu bankowego (MT940)
          </div>
        </div>
        <div style={{ padding: 16, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <input
            ref={fileInput}
            type="file"
            accept=".sta,.mt940,.txt,.940,.mt"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
            }}
          />
          <button
            type="button"
            className="ba-btn primary"
            onClick={() => fileInput.current?.click()}
            disabled={uploading}
          >
            <FileUp size={14} /> {uploading ? "Przetwarzanie…" : "Wybierz plik MT940"}
          </button>
          <span style={{ fontSize: 12.5, color: "var(--muted)" }}>
            Wyciąg pobrany z bankowości (format MT940 / .sta). Zaimportowane zostaną tylko uznania
            (wpłaty). Kodowanie windows-1250 konwertowane automatycznie.
          </span>
        </div>
      </div>

      {error ? (
        <div className="ba-pill red" style={{ display: "block", padding: "10px 14px", marginBottom: 14 }}>
          {error}
        </div>
      ) : null}

      {result ? (
        <div
          className="ba-pill green"
          style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px", marginBottom: 14, fontSize: 13 }}
        >
          <CheckCircle2 size={16} />
          Zapisano {result.saved} wpłat
          {result.skippedDuplicates > 0 ? ` (pominięto ${result.skippedDuplicates} duplikatów)` : ""}.
          Raport miesięczny został zaktualizowany.
        </div>
      ) : null}

      {preview ? (
        <>
          {preview.alreadyImported ? (
            <div className="ba-pill amber" style={{ display: "block", padding: "10px 14px", marginBottom: 14 }}>
              Uwaga: ten plik (identyczna zawartość) został już zaimportowany
              {preview.importedAt ? ` ${fmtDate(preview.importedAt)}` : ""}. Ponowny zapis zostanie
              odrzucony.
            </div>
          ) : null}

          {/* Podsumowanie pliku */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
              gap: 12,
              marginBottom: 16,
            }}
          >
            <FileStat label="Rachunek" value={preview.accountNumber ?? "—"} />
            <FileStat label="Nr wyciągu" value={preview.statementNumber ?? "—"} />
            <FileStat label="Uznania (wpłaty)" value={String(preview.creditCount)} />
            <FileStat
              label="Auto-dopasowane"
              value={`${preview.matchedCount} / ${preview.creditCount}`}
            />
          </div>

          {/* Dopasowane */}
          <TxPanel
            title={`Dopasowane automatycznie (${matchedItems.length})`}
            items={matchedItems}
            preview={preview}
            itemState={itemState}
            setItem={setItem}
          />

          {/* Niedopasowane */}
          <TxPanel
            title={`Wymagają ręcznego przypisania (${unmatchedItems.length})`}
            items={unmatchedItems}
            preview={preview}
            itemState={itemState}
            setItem={setItem}
          />

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 16 }}>
            <button type="button" className="ba-btn" onClick={() => setPreview(null)}>
              Anuluj
            </button>
            <button
              type="button"
              className="ba-btn primary"
              onClick={confirm}
              disabled={confirming || toSave.length === 0 || preview.alreadyImported}
            >
              <Upload size={14} />
              {confirming ? "Zapisywanie…" : `Zapisz wpłaty (${toSave.length})`}
            </button>
          </div>
        </>
      ) : null}
    </>
  );
}

function TxPanel({
  title,
  items,
  preview,
  itemState,
  setItem,
}: {
  title: string;
  items: PreviewItem[];
  preview: PreviewResponse;
  itemState: Record<number, ItemState>;
  setItem: (index: number, patch: Partial<ItemState>) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="ba-panel" style={{ marginBottom: 16 }}>
      <div className="ba-panel-head">
        <div className="ba-panel-title">{title}</div>
      </div>
      <div>
        {items.map((it) => {
          const st = itemState[it.index] ?? { include: false, unitId: null };
          return (
            <div
              key={it.index}
              className="ba-row"
              style={{
                gridTemplateColumns: "auto 0.8fr 2fr 0.9fr 1.2fr",
                borderBottom: "1px solid var(--border)",
                alignItems: "center",
                opacity: it.duplicate && !st.include ? 0.55 : 1,
              }}
            >
              <input
                type="checkbox"
                checked={st.include}
                onChange={(e) => setItem(it.index, { include: e.target.checked })}
              />
              <div>
                <div className="ba-mono" style={{ fontWeight: 700, fontSize: 13.5, color: "var(--green)" }}>
                  +{fmtPln(it.amount)}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--muted)" }}>{fmtDate(it.valueDate)}</div>
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5, color: "var(--ink-2)", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {it.title || it.rawDetails || "—"}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
                  {it.senderName ? `Nadawca: ${it.senderName}` : null}
                  {it.duplicate ? (
                    <span className="ba-pill amber" style={{ marginLeft: 6 }}>
                      możliwy duplikat
                    </span>
                  ) : null}
                </div>
              </div>
              <div>
                {it.matchReason ? (
                  <span className="ba-pill green">{REASON_LABEL[it.matchReason]}</span>
                ) : (
                  <span className="ba-pill amber">niedopasowane</span>
                )}
              </div>
              <div>
                <select
                  className="ba-input"
                  value={st.unitId ?? ""}
                  onChange={(e) =>
                    setItem(it.index, {
                      unitId: e.target.value ? Number(e.target.value) : null,
                      include: e.target.value ? true : st.include,
                    })
                  }
                  style={{ width: "100%" }}
                >
                  <option value="">— wybierz lokal —</option>
                  {preview.units.map((u) => (
                    <option key={u.id} value={u.id}>
                      Lokal {unitLabel(u)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FileStat({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 14,
        padding: 12,
      }}
    >
      <div className="ba-section-label" style={{ marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, wordBreak: "break-all" }}>{value}</div>
    </div>
  );
}
