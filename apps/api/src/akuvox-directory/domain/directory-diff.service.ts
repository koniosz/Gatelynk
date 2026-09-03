/**
 * Sync Engine — synchronizacja różnicowa (pkt 9) + reguły współistnienia
 * ze SmartPlus (pkt 11). Czysta logika (bez I/O) — testy bez bazy.
 *
 * Twarde zasady:
 *  - NIGDY nie usuwamy automatycznie rekordów spoza GateLynk
 *    (managedBy: local / akuvox-cloud / unknown) — trafiają do preservedForeign;
 *  - w trybie MERGED GateLynk zarządza TYLKO rekordami ze swoim externalId
 *    (prefiks `gl-`); konflikty idą do raportu, nie są auto-rozstrzygane;
 *  - matching: primary po externalId (gdy format go przenosi), fallback po
 *    pierwszym numerze (Phone = unit.id — stabilny int; analiza §7.11).
 */
import { Injectable } from '@nestjs/common'
import {
  ALL_COMPARABLE_FIELDS,
  AkuvoxDirectorySnapshot,
  AkuvoxDirectoryUser,
  AkuvoxSnapshotEntry,
  ComparableField,
  ContactAuthority,
  DirectoryConflict,
  DirectoryDiff,
  FieldChange,
  ManagedBy,
} from './directory.types'
import { DirectoryProjectionService } from './directory-projection.service'

const GATELYNK_PREFIX = 'gl-'

@Injectable()
export class DirectoryDiffService {
  /** Klasyfikacja pochodzenia rekordu ze snapshotu urządzenia. */
  static classifyManagedBy(entry: Pick<AkuvoxSnapshotEntry, 'externalId' | 'managedBy'>): ManagedBy {
    if (entry.managedBy && entry.managedBy !== 'unknown') return entry.managedBy
    if (entry.externalId?.startsWith(GATELYNK_PREFIX)) return 'gatelynk'
    return entry.managedBy ?? 'unknown'
  }

  /**
   * @param comparableFields Etap 2 — checksum świadomy formatu: porównuj
   *   wyłącznie pola przenoszone przez template (checksumy liczone od nowa
   *   z ograniczeniem do tych pól; pre-kalkulowane checksumy snapshotu są
   *   wtedy ignorowane). Brak = porównanie pełne.
   */
  diff(
    desired: AkuvoxDirectoryUser[],
    snapshot: AkuvoxDirectorySnapshot,
    authority: ContactAuthority = 'GATELYNK',
    comparableFields?: ComparableField[],
  ): DirectoryDiff {
    const result: DirectoryDiff = {
      usersToCreate: [],
      usersToUpdate: [],
      usersToDisable: [],
      usersToDelete: [],
      unchangedUsers: [],
      preservedForeign: [],
      conflicts: [],
    }

    // MANUAL: GateLynk nie zarządza katalogiem tego urządzenia — wszystko obce.
    if (authority === 'MANUAL') {
      result.preservedForeign = [...snapshot.entries]
      if (desired.length > 0) {
        result.conflicts.push({
          key: 'authority',
          reason: `Urządzenie w trybie MANUAL — ${desired.length} wpisów GateLynk nie będzie synchronizowanych`,
        })
      }
      return result
    }

    const byExternalId = new Map<string, AkuvoxSnapshotEntry>()
    const byPhone = new Map<string, AkuvoxSnapshotEntry>()
    for (const e of snapshot.entries) {
      const managedBy = DirectoryDiffService.classifyManagedBy(e)
      const entry = { ...e, managedBy }
      if (entry.externalId) byExternalId.set(entry.externalId, entry)
      for (const c of entry.contacts) {
        if (!byPhone.has(c.phone)) byPhone.set(c.phone, entry)
      }
    }

    const matched = new Set<AkuvoxSnapshotEntry>()

    for (const want of desired) {
      // Primary: externalId; fallback: pierwszy numer (Phone = unit.id).
      let current = byExternalId.get(want.externalId)
      if (!current && want.contacts.length > 0) {
        const cand = byPhone.get(want.contacts[0].phone)
        // Fallback matchuje tylko rekordy, które wolno nam przypisać GateLynk-owi:
        // gatelynk (bez externalId w formacie pliku) albo unknown.
        if (cand && (cand.managedBy === 'gatelynk' || cand.managedBy === 'unknown')) {
          current = cand
        } else if (cand) {
          // Ten sam numer w rekordzie obcym = konflikt do raportu.
          result.conflicts.push({
            externalId: want.externalId,
            key: cand.externalId || cand.name,
            reason: `Numer ${want.contacts[0].phone} jest już użyty przez rekord "${cand.name}" (${cand.managedBy})`,
            desired: want,
            current: cand,
          })
        }
      }

      if (!current) {
        result.usersToCreate.push(want)
        continue
      }
      matched.add(current)

      if (authority === 'MERGED' && current.managedBy !== 'gatelynk' && current.managedBy !== 'unknown') {
        // MERGED: rekordy SmartPlus nietknięte; rozbieżność do raportu.
        result.preservedForeign.push(current)
        result.conflicts.push({
          externalId: want.externalId,
          key: current.externalId || current.name,
          reason: `MERGED: rekord "${current.name}" zarządzany przez ${current.managedBy} — GateLynk go nie modyfikuje`,
          desired: want,
          current,
        })
        continue
      }

      // Przejście na disabled wykrywamy PRZED checksumem — flaga `enabled`
      // nie jest przenoszona przez formaty plików, więc restricted checksum
      // mógłby ją przeoczyć.
      if (!want.enabled && current.enabled) {
        result.usersToDisable.push(want)
        continue
      }
      const wantSum = DirectoryProjectionService.userChecksum(want, comparableFields)
      const curSum = comparableFields
        ? DirectoryProjectionService.userChecksum(current, comparableFields)
        : (current.checksum ?? DirectoryProjectionService.userChecksum(current))
      if (wantSum === curSum) {
        result.unchangedUsers.push(want)
      } else {
        result.usersToUpdate.push({ desired: want, current })
      }
    }

    // Rekordy ze snapshotu niedopasowane do żadnego desired:
    for (const e of snapshot.entries) {
      const entry = { ...e, managedBy: DirectoryDiffService.classifyManagedBy(e) }
      const wasMatched = [...matched].some(
        (m) => m.externalId === e.externalId && m.name === e.name,
      )
      if (wasMatched) continue
      if (entry.managedBy === 'gatelynk') {
        // Rekord GateLynk którego już nie ma w źródle → do usunięcia.
        result.usersToDelete.push(entry)
      } else {
        // Obce rekordy domyślnie zachowywane (pkt 9/11).
        result.preservedForeign.push(entry)
      }
    }

    return result
  }

  /**
   * Zmiany per pole (before/after) dla widoku D — ograniczone do pól
   * porównywalnych w danym formacie.
   */
  static fieldChanges(
    current: AkuvoxSnapshotEntry,
    desired: AkuvoxDirectoryUser,
    comparableFields?: ComparableField[],
  ): FieldChange[] {
    const f = new Set<ComparableField>(comparableFields ?? ALL_COMPARABLE_FIELDS)
    const out: FieldChange[] = []
    const norm = (s: string | undefined) => (s ?? '').normalize('NFC').trim().replace(/\s+/g, ' ')
    const push = (field: string, before: string | undefined, after: string | undefined) => {
      if (norm(before) !== norm(after)) out.push({ field, before: before ?? '—', after: after ?? '—' })
    }
    if (f.has('name')) push('Nazwa', current.name, desired.name)
    if (f.has('roomNumber')) push('Lokal', current.roomNumber, desired.roomNumber)
    if (f.has('group')) push('Grupa', current.groupName, desired.groupName)
    if (f.has('phones')) {
      push(
        'Numery',
        current.contacts.map((c) => c.phone).join(', '),
        desired.contacts.map((c) => c.phone).join(', '),
      )
    }
    if (f.has('dialAccount')) {
      push(
        'Dial account',
        current.contacts.map((c) => c.dialAccount).join(', '),
        desired.contacts.map((c) => c.dialAccount).join(', '),
      )
    }
    return out
  }

  /** Diff → podsumowanie i lista zmian dla dry-run (pkt 16) + pola dla widoku D. */
  static summarize(
    diff: DirectoryDiff,
    comparableFields?: ComparableField[],
  ): {
    summary: {
      create: number
      update: number
      disable: number
      delete: number
      unchanged: number
      conflicts: number
    }
    changes: {
      op: 'create' | 'update' | 'disable' | 'delete'
      externalId?: string
      name: string
      detail?: string
      fields?: FieldChange[]
    }[]
  } {
    const changes: {
      op: 'create' | 'update' | 'disable' | 'delete'
      externalId?: string
      name: string
      detail?: string
      fields?: FieldChange[]
    }[] = [
      ...diff.usersToCreate.map((u) => ({ op: 'create' as const, externalId: u.externalId, name: u.name })),
      ...diff.usersToUpdate.map((u) => ({
        op: 'update' as const,
        externalId: u.desired.externalId,
        name: u.desired.name,
        detail: u.current.name !== u.desired.name ? `było: "${u.current.name}"` : 'zmiana danych kontaktu',
        fields: DirectoryDiffService.fieldChanges(u.current, u.desired, comparableFields),
      })),
      ...diff.usersToDisable.map((u) => ({ op: 'disable' as const, externalId: u.externalId, name: u.name })),
      ...diff.usersToDelete.map((u) => ({
        op: 'delete' as const,
        externalId: u.externalId || undefined,
        name: u.name,
        detail: 'rekord GateLynk nieobecny już w źródle',
      })),
    ]
    return {
      summary: {
        create: diff.usersToCreate.length,
        update: diff.usersToUpdate.length,
        disable: diff.usersToDisable.length,
        delete: diff.usersToDelete.length,
        unchanged: diff.unchangedUsers.length,
        conflicts: diff.conflicts.length,
      },
      changes,
    }
  }
}

export type { DirectoryConflict }
