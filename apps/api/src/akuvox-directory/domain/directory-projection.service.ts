/**
 * Contact Projection (pkt 1/2/4/10/12/13/15 spec) — czysta logika:
 * wiersze źródłowe (DB) → DirectoryPerson[] → AkuvoxDirectoryUser[] + checksumy
 * + walidacja. Wszystkie metody są czyste (deterministyczne, bez I/O) —
 * testowalne bez bazy. Ładowanie z DB robi AkuvoxDirectoryService.
 *
 * Prywatność (pkt 13): na ekran domofonu NIGDY nie trafia numer komórki,
 * e-mail, wewnętrzne ID GateLynk ani informacje o uprawnieniach — kontekst
 * szablonów zawiera WYŁĄCZNIE bezpieczne pola (nazwiska/numery lokali/grupy).
 */
import { Injectable } from '@nestjs/common'
import { createHash } from 'node:crypto'
import {
  ALL_COMPARABLE_FIELDS,
  AkuvoxCapabilities,
  AkuvoxContactDetail,
  AkuvoxDirectoryMapping,
  AkuvoxDirectoryUser,
  CallTarget,
  ComparableField,
  DEFAULT_MAPPING,
  DirectoryPerson,
  ValidationIssue,
  ValidationResult,
} from './directory.types'

/** Wiersz źródłowy: lokal + aktywni mieszkańcy (z DB lub fixture w testach). */
export interface SourceUnitRow {
  unitId: number
  unitNumber: string
  street: string | null
  floor: number | null
  stairwellName: string | null
  contactGroupName: string | null
  contactGroupSortOrder: number | null
  residents: {
    id: number
    firstName: string
    lastName: string
    /** Miękkie usunięcie / koniec zamieszkania — osoba pomijana w projekcji. */
    deletedAt?: string | null
    /** Ukrycie pojedynczego mieszkańca (prywatność, pkt 13). */
    visibleOnIntercom?: boolean
  }[]
  /** Wyłączenie całego lokalu z katalogu (prywatność, pkt 13). */
  visibleOnIntercom?: boolean
  sourceUpdatedAt?: string
}

/** Limity pól Akuvox — zachowawcze (weryfikowalne realnym template'em). */
export const MAX_NAME_LENGTH = 63
export const MAX_ROOM_LENGTH = 31
export const MAX_GROUP_LENGTH = 63
export const MAX_DIRECTORY_USERS = 3000
/** Znaki łamiące XML/CSV importu — usuwane z pól wyświetlanych. */
const FORBIDDEN_CHARS = /[<>"\r\n\t]/g

@Injectable()
export class DirectoryProjectionService {
  // ── Contact Domain ──────────────────────────────────────────────────────────

  /**
   * Wiersze DB → kanoniczne DirectoryPerson (1 osoba = 1 rekord).
   *
   * `opts.dialHost` (bugfix 2026-07-30): gdy ustawiony, numer wybierania to
   * SIP URI `<unit.id>@<dialHost>` (routing per-lokal dla formatów kontaktów,
   * które dzwonią na surowy string — np. lokalne kontakty CSV R29C). Puste =
   * goły unit.id jak dotąd (urządzenie z kontem SIP / legacy tgz).
   */
  toDirectoryPersons(
    rows: SourceUnitRow[],
    buildingId: number,
    opts?: { dialHost?: string | null },
  ): DirectoryPerson[] {
    const dialHost = opts?.dialHost?.trim() || undefined
    const persons: DirectoryPerson[] = []
    for (const row of rows) {
      const unitVisible = row.visibleOnIntercom !== false
      for (const r of row.residents) {
        const deleted = r.deletedAt != null
        persons.push({
          id: `gl-p${r.id}`,
          propertyId: String(buildingId),
          buildingId: String(buildingId),
          unitId: String(row.unitId),
          displayName: `${r.lastName} ${r.firstName}`.trim(),
          firstName: r.firstName,
          lastName: r.lastName,
          buildingNumber: row.street ?? undefined,
          staircase: row.stairwellName ?? undefined,
          floor: row.floor != null ? String(row.floor) : undefined,
          unitNumber: DirectoryProjectionService.normalizeUnitNumber(row.unitNumber),
          enabled: !deleted,
          visibleOnIntercom: unitVisible && r.visibleOnIntercom !== false && !deleted,
          // Fallback grup (decyzja Konrada 2026-07-30): grupa kontaktowa →
          // ulica → „Pozostali". Lokal bez grupy nie ląduje z pustą grupą
          // na ekranie domofonu (spec zostawiał undefined — nieczytelne).
          contactGroup: row.contactGroupName ?? row.street ?? 'Pozostali',
          // Routing punktowy (NIE ruszamy): dialedExtension = unit.id.
          // Z dialHost → pełny SIP URI (stacja dzwoni na surowy string).
          callTargets: [
            {
              id: `gl-ct-u${row.unitId}`,
              type: dialHost ? 'sip' : 'extension',
              value: dialHost ? `${row.unitId}@${dialHost}` : String(row.unitId),
              priority: 1,
              dialAccount: 1,
              enabled: true,
            },
          ],
          sourceUpdatedAt: row.sourceUpdatedAt ?? new Date(0).toISOString(),
          deletedAt: r.deletedAt ?? undefined,
        })
      }
    }
    return persons
  }

  // ── Contact Projection ──────────────────────────────────────────────────────

  /**
   * DirectoryPerson[] → AkuvoxDirectoryUser[] wg mappingu (pkt 4 + 12).
   * displayMode 'unit'/'unit_group_call' = 1 wpis per lokal (wpis zbiorczy);
   * 'person' = 1 wpis per osoba. Sortowanie jak legacy: grupa (sortOrder→nazwa,
   * bez grupy na końcu) → numer lokalu.
   */
  projectToAkuvoxUsers(
    persons: DirectoryPerson[],
    mapping: Partial<AkuvoxDirectoryMapping> | null | undefined,
    rows?: SourceUnitRow[],
  ): AkuvoxDirectoryUser[] {
    const m: AkuvoxDirectoryMapping = { ...DEFAULT_MAPPING, ...(mapping ?? {}) }
    const visible = persons.filter((p) => p.visibleOnIntercom && p.enabled && !p.deletedAt)

    const groupSort = new Map<string, number>()
    for (const row of rows ?? []) {
      if (row.contactGroupName) {
        groupSort.set(row.contactGroupName, row.contactGroupSortOrder ?? 0)
      }
    }

    let users: AkuvoxDirectoryUser[]
    if (m.displayMode === 'person') {
      users = visible.map((p) => this.personToUser(p, m))
    } else {
      // 'unit' i 'unit_group_call' — wpis zbiorczy per lokal.
      const byUnit = new Map<string, DirectoryPerson[]>()
      for (const p of visible) {
        const key = p.unitId ?? p.id
        const list = byUnit.get(key) ?? []
        list.push(p)
        byUnit.set(key, list)
      }
      users = [...byUnit.entries()].map(([unitId, members]) => this.unitToUser(unitId, members, m))
    }

    users.sort((a, b) => {
      const ga = a.groupName ?? ''
      const gb = b.groupName ?? ''
      if (ga !== gb) {
        if (ga === '') return 1
        if (gb === '') return -1
        const sa = groupSort.get(ga)
        const sb = groupSort.get(gb)
        if (sa !== undefined && sb !== undefined && sa !== sb) return sa - sb
        return ga.localeCompare(gb, 'pl')
      }
      return (a.roomNumber ?? '').localeCompare(b.roomNumber ?? '', 'pl', { numeric: true })
    })
    // userId = pozycja na liście (stabilny w ramach jednego eksportu).
    return users.map((u, i) => ({ ...u, userId: String(i + 1) }))
  }

  private personToUser(p: DirectoryPerson, m: AkuvoxDirectoryMapping): AkuvoxDirectoryUser {
    const ctx = this.templateContext(p, [p], m)
    return {
      externalId: p.id,
      userId: '0',
      name: this.renderName(m, ctx),
      roomNumber: DirectoryProjectionService.sanitize(
        DirectoryProjectionService.renderTemplate(m.roomNumberTemplate, ctx),
        MAX_ROOM_LENGTH,
      ),
      groupName: this.resolveGroup(p, m),
      enabled: p.enabled,
      contacts: this.toContacts(p.callTargets, this.resolveGroup(p, m)),
    }
  }

  private unitToUser(
    unitId: string,
    members: DirectoryPerson[],
    m: AkuvoxDirectoryMapping,
  ): AkuvoxDirectoryUser {
    const first = members[0]
    const ctx = this.templateContext(first, members, m)
    // Targety lokalu: unikalne po (type,value), maks. 3 priorytety.
    const seen = new Set<string>()
    const targets: CallTarget[] = []
    for (const p of members) {
      for (const t of p.callTargets) {
        const key = `${t.type}:${t.value}`
        if (t.enabled && !seen.has(key)) {
          seen.add(key)
          targets.push(t)
        }
      }
    }
    const group = this.resolveGroup(first, m)
    return {
      externalId: `gl-u${unitId}`,
      userId: '0',
      name: this.renderName(m, ctx),
      roomNumber: DirectoryProjectionService.sanitize(
        DirectoryProjectionService.renderTemplate(m.roomNumberTemplate, ctx),
        MAX_ROOM_LENGTH,
      ),
      groupName: group,
      enabled: members.some((p) => p.enabled),
      contacts: this.toContacts(targets, group),
    }
  }

  private renderName(m: AkuvoxDirectoryMapping, ctx: Record<string, string>): string {
    if (m.anonymizeDirectory) {
      // Wpis anonimowy: wyłącznie numer lokalu (pkt 13).
      return DirectoryProjectionService.sanitize(`Lokal ${ctx.unitNumber ?? ''}`.trim(), MAX_NAME_LENGTH)
    }
    return DirectoryProjectionService.sanitize(
      DirectoryProjectionService.renderTemplate(m.displayNameTemplate, ctx),
      MAX_NAME_LENGTH,
    )
  }

  /**
   * Kontekst szablonów — WYŁĄCZNIE bezpieczne pola (pkt 13). Celowo brak:
   * phone, email, id GateLynk, uprawnień.
   */
  private templateContext(
    p: DirectoryPerson,
    members: DirectoryPerson[],
    m: AkuvoxDirectoryMapping,
  ): Record<string, string> {
    const lastNames = [...new Set(members.map((x) => x.lastName ?? '').filter(Boolean))].join(' / ')
    return {
      firstName: m.hideLastName ? (p.firstName ?? '') : (p.firstName ?? ''),
      lastName: m.hideLastName ? '' : (p.lastName ?? ''),
      lastNames: m.hideLastName ? '' : lastNames,
      unitNumber: p.unitNumber ?? '',
      unitId: p.unitId ?? '',
      buildingNumber: p.buildingNumber ?? '',
      staircase: p.staircase ?? '',
      floor: p.floor ?? '',
      contactGroup: p.contactGroup ?? '',
    }
  }

  private resolveGroup(p: DirectoryPerson, m: AkuvoxDirectoryMapping): string | undefined {
    let g: string | undefined
    switch (m.groupBy) {
      case 'building':
        g = p.buildingNumber
        break
      case 'staircase':
        g = p.staircase
        break
      case 'floor':
        g = p.floor != null && p.floor !== '' ? `Piętro ${p.floor}` : undefined
        break
      default:
        g = p.contactGroup
    }
    const s = g ? DirectoryProjectionService.sanitize(g, MAX_GROUP_LENGTH) : undefined
    return s && s.length > 0 ? s : undefined
  }

  private toContacts(targets: CallTarget[], group: string | undefined): AkuvoxContactDetail[] {
    const priorityLabel: Record<1 | 2 | 3, AkuvoxContactDetail['priority']> = {
      1: 'Primary',
      2: 'Secondary',
      3: 'Tertiary',
    }
    return targets
      .filter((t) => t.enabled)
      .sort((a, b) => a.priority - b.priority)
      .slice(0, 3)
      .map((t) => ({
        phone: t.value,
        group,
        priority: priorityLabel[t.priority],
        dialAccount: t.dialAccount === 2 ? 'Account2' : 'Account1',
      }))
  }

  // ── Idempotencja / checksumy (pkt 10) ───────────────────────────────────────

  /**
   * SHA256 znormalizowanych pól: name + roomNumber + group + callTargets.
   * Etap 2: opcjonalny `fields` ogranicza checksum do pól realnie
   * przenoszonych przez format pliku (checksum świadomy formatu) — inaczej
   * pierwsze porównanie z eksportem urządzenia dawałoby fałszywe „update"
   * (np. E18C nie przenosi roomNumber).
   */
  static userChecksum(u: AkuvoxDirectoryUser, fields?: ComparableField[]): string {
    const f = new Set<ComparableField>(fields ?? ALL_COMPARABLE_FIELDS)
    const norm = (s: string | undefined) => (s ?? '').normalize('NFC').trim().replace(/\s+/g, ' ')
    const contacts = [...u.contacts]
      .map((c) =>
        [
          f.has('phones') ? norm(c.phone) : '',
          f.has('phones') ? c.priority : '',
          f.has('dialAccount') ? c.dialAccount : '',
        ].join('|'),
      )
      .sort()
      .join(';')
    const payload = [
      f.has('name') ? norm(u.name) : '',
      f.has('roomNumber') ? norm(u.roomNumber) : '',
      f.has('group') ? norm(u.groupName) : '',
      contacts,
      u.enabled ? '1' : '0',
    ].join('\n')
    return createHash('sha256').update(payload, 'utf8').digest('hex')
  }

  /** Checksum całego katalogu — niezależny od kolejności wpisów. */
  static directoryChecksum(users: AkuvoxDirectoryUser[]): string {
    const parts = users
      .map((u) => `${u.externalId}:${DirectoryProjectionService.userChecksum(u)}`)
      .sort()
      .join('\n')
    return createHash('sha256').update(parts, 'utf8').digest('hex')
  }

  // ── Walidacja przed generacją (pkt 15) ──────────────────────────────────────

  validateUsers(users: AkuvoxDirectoryUser[], caps?: AkuvoxCapabilities | null): ValidationResult {
    const issues: ValidationIssue[] = []
    const valid: AkuvoxDirectoryUser[] = []
    const seenExternal = new Map<string, number>()
    const seenRoom = new Map<string, string[]>()

    if (users.length > MAX_DIRECTORY_USERS) {
      issues.push({
        level: 'error',
        code: 'DIRECTORY_LIMIT',
        message: `Katalog ma ${users.length} wpisów — limit ${MAX_DIRECTORY_USERS}`,
      })
    }

    for (const u of users) {
      seenExternal.set(u.externalId, (seenExternal.get(u.externalId) ?? 0) + 1)
      if (u.roomNumber) {
        const list = seenRoom.get(u.roomNumber) ?? []
        list.push(u.externalId)
        seenRoom.set(u.roomNumber, list)
      }
    }
    for (const [ext, count] of seenExternal) {
      if (count > 1) {
        issues.push({
          level: 'error',
          code: 'DUPLICATE_EXTERNAL_ID',
          externalId: ext,
          message: `Zduplikowany externalId: ${ext} (${count}×)`,
        })
      }
    }
    for (const [room, exts] of seenRoom) {
      if (exts.length > 1) {
        issues.push({
          level: 'warning',
          code: 'DUPLICATE_ROOM',
          message: `Numer lokalu "${room}" występuje ${exts.length}× (${exts.join(', ')})`,
        })
      }
    }

    for (const u of users) {
      const errs: ValidationIssue[] = []
      if (!u.name || u.name.trim() === '') {
        errs.push({
          level: 'error',
          code: 'MISSING_NAME',
          externalId: u.externalId,
          message: `Wpis ${u.externalId}: brak nazwy wyświetlanej`,
        })
      }
      if (u.contacts.length === 0) {
        errs.push({
          level: 'error',
          code: 'MISSING_CALL_TARGET',
          externalId: u.externalId,
          message: `Wpis ${u.externalId} („${u.name}"): brak numeru SIP/IP/extension`,
        })
      }
      if (u.contacts.length > 3) {
        errs.push({
          level: 'error',
          code: 'TOO_MANY_PRIORITIES',
          externalId: u.externalId,
          message: `Wpis ${u.externalId}: więcej niż 3 numery (priorytety)`,
        })
      }
      for (const c of u.contacts) {
        if (!c.dialAccount) {
          errs.push({
            level: 'error',
            code: 'MISSING_DIAL_ACCOUNT',
            externalId: u.externalId,
            message: `Wpis ${u.externalId}: brak dial account dla numeru ${c.phone}`,
          })
        }
        if (!/^[A-Za-z0-9@._\-:]+$/.test(c.phone)) {
          errs.push({
            level: 'error',
            code: 'INVALID_PHONE_CHARS',
            externalId: u.externalId,
            message: `Wpis ${u.externalId}: numer "${c.phone}" zawiera niedozwolone znaki`,
          })
        }
      }
      if (u.name.length > MAX_NAME_LENGTH) {
        errs.push({
          level: 'warning',
          code: 'NAME_TOO_LONG',
          externalId: u.externalId,
          message: `Wpis ${u.externalId}: nazwa dłuższa niż ${MAX_NAME_LENGTH} znaków (zostanie przycięta)`,
        })
      }
      issues.push(...errs)
      // Błąd jednego kontaktu NIE blokuje całości (pkt 15) — wpis z errorem
      // jest pomijany, reszta idzie do pliku.
      if (!errs.some((e) => e.level === 'error') && seenExternal.get(u.externalId) === 1) {
        valid.push(u)
      }
    }

    if (caps && !caps.supportsDirectoryUsers && users.some((u) => u.contacts.length > 1)) {
      issues.push({
        level: 'warning',
        code: 'MULTI_CONTACT_UNSUPPORTED',
        message: `Firmware ${caps.firmwareVersion} nie obsługuje wielu numerów per użytkownik — użyty zostanie pierwszy`,
      })
    }

    return { validUsers: valid, issues }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /** Prosty renderer szablonów {{pole}} — nieznane pola → pusty string. */
  static renderTemplate(template: string, ctx: Record<string, string>): string {
    return template
      .replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => ctx[key] ?? '')
      .replace(/\s+/g, ' ')
      .replace(/\s*—\s*$/, '')
      .replace(/^\s*—\s*/, '')
      .trim()
  }

  /** Normalizacja numeru lokalu: trim + pojedyncze spacje. */
  static normalizeUnitNumber(n: string): string {
    return n.normalize('NFC').trim().replace(/\s+/g, ' ')
  }

  /** Usunięcie znaków łamiących XML/CSV + przycięcie do limitu. */
  static sanitize(s: string, maxLen: number): string {
    const clean = s.replace(FORBIDDEN_CHARS, ' ').replace(/\s+/g, ' ').trim()
    return clean.length > maxLen ? clean.slice(0, maxLen).trimEnd() : clean
  }
}
