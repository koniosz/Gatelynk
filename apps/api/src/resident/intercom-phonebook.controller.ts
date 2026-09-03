/**
 * IntercomPhonebookController (Cloud) — Remote Phonebook dla domofonu Akuvox.
 *
 * @deprecated LEGACY (2026-07-30) — stara integracja kontaktów. Następca:
 * Akuvox Directory Sync v2 (`apps/api/src/akuvox-directory/`, analiza:
 * docs/akuvox-directory-v2-analysis.md). Endpoint DZIAŁA DALEJ bez zmian
 * zachowania (produkcyjny R29C @ 29.30.10.128 ma wklejony ten URL) — wyłączenie
 * dopiero po migracji urządzeń na v2 i decyzji właściciela (Etap 2, pkt 20 spec).
 *
 * Akuvox R29 pobiera książkę adresową z URL-a (Phone → Remote Phonebook) i
 * pokazuje listę kontaktów gościowi. Tu generujemy ją z bazy: każdy lokal z
 * aktywnymi mieszkańcami = jeden wpis `<Contact>` z nazwą (numer + nazwiska)
 * i numerem do wybierania `Office = "<unit.number>@<host>"`. Po dotknięciu
 * kontaktu Akuvox dzwoni na ten numer → INVITE z `toExtension = unit.number`
 * → Edge przekazuje `dialedExtension`, Cloud routuje do mieszkańców TEGO lokalu
 * (routing punktowy zamiast „dzwoń do wszystkich").
 *
 * Endpoint PUBLICZNY (Akuvox nie zrobi JWT), zabezpieczony tokenem per-budynek
 * = HMAC(JWT_SECRET, "phonebook:<buildingId>"). Dane (nazwiska) idą po TLS tylko
 * do urządzenia, które i tak je wyświetla gościowi. Format XML wg admin guide
 * Akuvox: `<Directory Name=""><Contact Id Name Office/></Directory>`.
 */
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Logger,
  Query,
  Res,
} from '@nestjs/common'
import type { Response } from 'express'
import { createHmac } from 'node:crypto'
import { PrismaService } from '../prisma/prisma.service'

@Controller('intercom')
export class IntercomPhonebookController {
  private readonly logger = new Logger(IntercomPhonebookController.name)

  constructor(private readonly prisma: PrismaService) {}

  /** Token per-budynek (stabilny, bez DB) — integrator wkleja go w URL Akuvoxa. */
  static tokenFor(buildingId: number): string {
    const secret = process.env.JWT_SECRET ?? 'gatelynk-dev-secret'
    return createHmac('sha256', secret).update(`phonebook:${buildingId}`).digest('hex').slice(0, 24)
  }

  private static escapeXml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  /**
   * GET /api/intercom/phonebook?b=<buildingId>&t=<token>&host=<edge-lan-ip>
   *
   * `host` (opcjonalny) = LAN IP Edge/Janusa (np. 192.168.1.127). Gdy podany,
   * Office = "<numer>@<host>" (direct-IP do Janusa); gdy brak — sam numer
   * (jeśli Akuvox ma skonfigurowany outbound proxy/konto SIP).
   */
  @Get('phonebook')
  async phonebook(
    @Query('b') b: string,
    @Query('t') t: string,
    @Query('host') host: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const buildingId = Number(b)
    if (!Number.isInteger(buildingId) || buildingId <= 0) {
      throw new BadRequestException('bad building id')
    }
    if (!t || t !== IntercomPhonebookController.tokenFor(buildingId)) {
      throw new ForbiddenException('bad token')
    }

    // Lokale z ≥1 aktywnym mieszkańcem (callable). Nazwa = numer + nazwiska.
    // Numer wybierania = `unit.id` (czysty int — `unit.number` bywa "Niewinna 1/1"
    // ze spacją/ukośnikiem, nieprawidłowy jako user-part SIP). Gość dotyka nazwy,
    // więc id jest niewidoczne; Cloud routuje po id (fallback na number).
    //
    // Grupy kontaktowe (2026-07-30): format Remote Phonebook Akuvoxa jest
    // PŁASKI — jedno <Directory> z listą <Contact>, bez elementu grupy (patrz
    // Akuvox SP-R5xP Admin Guide, „Remote XML Phone Book"; admin guide R29 nie
    // dokumentuje nic ponad to). Grupowanie robimy więc prefiksem nazwy
    // („Budynek 1 · Niewinna 4/2 — Kowalscy") + sortowaniem: grupy wg
    // sortOrder/nazwy, lokale bez grupy na końcu, w grupie po numerze lokalu.
    const rows = await this.prisma.$queryRaw<
      {
        id: number
        number: string
        street: string | null
        names: string | null
        groupName: string | null
      }[]
    >`
      SELECT u.id, u.number, u.street,
             string_agg(DISTINCT r."lastName", ' / ') AS names,
             cg.name AS "groupName"
        FROM "units" u
        JOIN "unit_residents" ur ON ur."unitId" = u.id
          AND (ur."untilDate" IS NULL OR ur."untilDate" > NOW())
        JOIN "residents" r ON r.id = ur."residentId"
        LEFT JOIN "contact_groups" cg ON cg.id = u."contactGroupId"
       WHERE u."buildingId" = ${buildingId}
       GROUP BY u.id, u.number, u.street, cg."sortOrder", cg.name
       ORDER BY cg."sortOrder" ASC NULLS LAST, cg.name ASC NULLS LAST, u.number ASC
    `

    const dialHost = host && /^[a-zA-Z0-9.\-]+$/.test(host) ? host : ''
    const contacts = rows.map((u, i) => {
      const base = u.street ? `${u.street} ${u.number}` : u.number
      const withNames = u.names ? `${base} — ${u.names}` : base
      const name = u.groupName ? `${u.groupName} · ${withNames}` : withNames
      const office = dialHost ? `${u.id}@${dialHost}` : String(u.id)
      const E = IntercomPhonebookController.escapeXml
      return `  <Contact Id="${i + 1}" Name="${E(name)}" Office="${E(office)}"/>`
    })

    const xml =
      `<?xml version="1.0" encoding="utf-8" ?>\n<Directory Name="GateLynk">\n` +
      `${contacts.join('\n')}\n</Directory>\n`

    this.logger.log(`phonebook [b#${buildingId}] → ${rows.length} kontakt(ów)`)
    res.setHeader('Content-Type', 'application/xml; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')
    res.send(xml)
  }
}
