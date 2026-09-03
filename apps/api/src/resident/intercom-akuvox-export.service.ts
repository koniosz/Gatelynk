/**
 * IntercomAkuvoxExportService (Cloud) — generuje plik `UserData.tgz` do importu
 * listy mieszkańców na domofonie Akuvox (Directory → User → Import).
 *
 * @deprecated LEGACY (2026-07-30) — stara integracja per-budynek. Następca:
 * Akuvox Directory Sync v2 (`apps/api/src/akuvox-directory/`) — per-urządzenie,
 * template-driven, z dry-run i historią. Ten serwis JEST bazą nowego
 * `AkuvoxLegacyContactsAdapter`: format E18C odwzorowany w
 * `adapters/akuvox-legacy-contacts.adapter.ts` (BUILTIN_E18C_TEMPLATE),
 * a statyki `makeTar`/`buildUserDataXml` są reużywane przez generator v2
 * i fabrykę fixture w testach. Endpointy (Integrator + BA) DZIAŁAJĄ DALEJ
 * bez zmian zachowania — usunięcie dopiero po migracji na v2 (Etap 2).
 *
 * Format odtworzony 1:1 z eksportu E18C (2026-06-22):
 *   UserData.tgz = tar+gzip z dwóch plików:
 *     - userdata.xml     — <UserData><Data ... Phone="<id>"><Pin Code=""/></Data>…
 *     - DoorSchedule.xml — standardowe harmonogramy Always/Never (1001/1002)
 *
 * Mapowanie: każdy lokal z ≥1 aktywnym mieszkańcem = jeden <Data>:
 *   Name  = "<numer lokalu> — <nazwiska>" (to widzi gość na ekranie),
 *   Phone = unit.id (numer wybierania → proxy SIP → routing punktowy),
 *   Group = ulica (grupowanie na ekranie), Pin = puste (PIN-y syncują się osobno).
 *
 * Tar piszemy ręcznie (format ustar) — bez nowej zależności npm (unika
 * rebuildu pnpm-lock/Docker, patrz gotcha sharp). gzip = wbudowane zlib.
 */
import { Injectable, Logger } from '@nestjs/common'
import { gzipSync } from 'node:zlib'
import { PrismaService } from '../prisma/prisma.service'

/** Standardowy DoorSchedule.xml (1:1 z urządzenia) — Schedule-Relay="1001". */
const DOOR_SCHEDULE_XML =
  `<?xml version="1.0" encoding="UTF-8" ?>\n` +
  `<Schedule>\n` +
  `    <Data ID="1" ScheduleID="1001" Name="Always" Type="2" Date="" Weekly="" Daily="00:00-23:59" />\n` +
  `    <Data ID="2" ScheduleID="1002" Name="Never" Type="2" Date="" Weekly="" Daily="00:00-00:00" />\n` +
  `</Schedule>\n`

@Injectable()
export class IntercomAkuvoxExportService {
  private readonly logger = new Logger(IntercomAkuvoxExportService.name)

  constructor(private readonly prisma: PrismaService) {}

  /** Zbuduj `UserData.tgz` (Buffer) dla budynku. */
  async buildUserDataTgz(buildingId: number): Promise<Buffer> {
    // Grupy kontaktowe (2026-07-30): Group = nazwa grupy kontaktowej lokalu
    // (BA panel), fallback ulica jak dotąd, ostatecznie „Mieszkańcy".
    // Sort: grupy wg sortOrder/nazwy (bez grupy na końcu), potem numer lokalu.
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

    const userXml = IntercomAkuvoxExportService.buildUserDataXml(rows)
    const tar = IntercomAkuvoxExportService.makeTar([
      { name: 'userdata.xml', content: Buffer.from(userXml, 'utf8') },
      { name: 'DoorSchedule.xml', content: Buffer.from(DOOR_SCHEDULE_XML, 'utf8') },
    ])
    this.logger.log(`akuvox export [b#${buildingId}]: ${rows.length} lokal(i) → UserData.tgz`)
    return gzipSync(tar)
  }

  /** XML <UserData> — jeden <Data> per lokal (Phone = unit.id). */
  static buildUserDataXml(
    rows: {
      id: number
      number: string
      street: string | null
      names: string | null
      groupName?: string | null
    }[],
  ): string {
    const E = IntercomAkuvoxExportService.escapeXml
    const items = rows.map((u, i) => {
      const idx = i + 1
      const name = u.names ? `${u.number} — ${u.names}` : u.number
      // Grupa na ekranie E18C: grupa kontaktowa (BA) > ulica > „Mieszkańcy".
      const group =
        u.groupName && u.groupName.trim()
          ? u.groupName.trim()
          : u.street && u.street.trim()
            ? u.street.trim()
            : 'Mieszkańcy'
      return (
        `    <Data ID="${idx}" UserID="${idx}" Name="${E(name)}" WebRelay="0" Floor="0" ` +
        `Phone="${u.id}" Group="${E(group)}" PriorityOfCall="0" DialAccount="0" ` +
        `Schedule-Relay="1001-1;" Schedule-SRelay="">\n` +
        `        <Pin Code="" />\n` +
        `    </Data>`
      )
    })
    return (
      `<?xml version="1.0" encoding="UTF-8" ?>\n` +
      `<UserData>\n${items.join('\n')}\n</UserData>\n`
    )
  }

  private static escapeXml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  /** Minimalny writer tar (ustar) dla kilku małych plików. */
  static makeTar(files: { name: string; content: Buffer }[]): Buffer {
    const blocks: Buffer[] = []
    for (const f of files) {
      blocks.push(IntercomAkuvoxExportService.tarHeader(f.name, f.content.length))
      blocks.push(f.content)
      const pad = (512 - (f.content.length % 512)) % 512
      if (pad > 0) blocks.push(Buffer.alloc(pad))
    }
    // Dwa puste bloki 512 = koniec archiwum.
    blocks.push(Buffer.alloc(1024))
    return Buffer.concat(blocks)
  }

  /** Nagłówek ustar (512 B) z poprawnym checksumem. */
  private static tarHeader(name: string, size: number): Buffer {
    const h = Buffer.alloc(512)
    const writeOctal = (val: number, offset: number, len: number) => {
      const s = val.toString(8).padStart(len - 1, '0') + '\0'
      h.write(s, offset, 'ascii')
    }
    h.write(name, 0, 100, 'utf8') // name
    h.write('0000644\0', 100, 'ascii') // mode
    h.write('0000000\0', 108, 'ascii') // uid
    h.write('0000000\0', 116, 'ascii') // gid
    writeOctal(size, 124, 12) // size
    writeOctal(Math.floor(Date.now() / 1000), 136, 12) // mtime
    h.write('        ', 148, 8, 'ascii') // checksum placeholder = spaces
    h.write('0', 156, 1, 'ascii') // typeflag = normal file
    h.write('ustar\0', 257, 6, 'ascii') // magic
    h.write('00', 263, 2, 'ascii') // version
    // checksum = suma wszystkich bajtów nagłówka (z polem checksum jako spacje)
    let sum = 0
    for (let i = 0; i < 512; i++) sum += h[i]
    const chk = sum.toString(8).padStart(6, '0') + '\0 '
    h.write(chk, 148, 8, 'ascii')
    return h
  }
}
