import { BadRequestException } from '@nestjs/common'
import type { PrismaService } from '../prisma/prisma.service'

/**
 * Blokada anty-stalkingowa (zgłoszenie 2026-08-12): tablica ZAREJESTROWANEGO
 * pojazdu osiedla nie może zostać tablicą „gościa".
 *
 * Wektor ataku: dowolny mieszkaniec wpisuje sąsiada jako gościa z jego
 * tablicą i od tej chwili dostaje push przy każdym wjeździe i wyjeździe
 * sąsiada (z odczytów LPR) — gotowy tracker. Zaproszenie gościa ma dotyczyć
 * osób SPOZA osiedla; auta mieszkańców żyją w rejestrze pojazdów, nie
 * w gościach.
 *
 * Porównujemy po NORMALIZACJI (upper + tylko A-Z0-9) — rejestr potrafi
 * trzymać tablice ze spacjami („WD 5005P"), a Edge i LPR normalizują.
 * Blokujemy każdy status pojazdu (PENDING/APPROVED/BLOCKED/…): wpis
 * w rejestrze oznacza, że tablica należy do kogoś związanego z osiedlem,
 * a właśnie takich osób nie wolno śledzić przez mechanizm gości.
 */
export async function assertGuestPlateAllowed(
  prisma: PrismaService,
  buildingId: number,
  plate: string | null | undefined,
): Promise<void> {
  if (!plate) return
  const normalized = plate.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (!normalized) return

  const rows = await prisma.$queryRaw<{ id: number }[]>`
    SELECT id FROM "vehicles"
     WHERE "buildingId" = ${buildingId}
       AND regexp_replace(upper("licensePlate"), '[^A-Z0-9]', '', 'g') = ${normalized}
     LIMIT 1
  `
  if (rows.length) {
    throw new BadRequestException(
      'Ta tablica jest już zarejestrowana w bazie pojazdów osiedla — należy do mieszkańca ' +
        'lub pojazdu z białej listy i nie może być dodana jako gość.',
    )
  }
}

/**
 * Wariant "sprawdź bez wyjątku" — dla ścieżki powiadomień (matchPlate):
 * wpisy gości sprzed tej blokady (albo dodane inną drogą) NIE mogą
 * generować pushy o ruchu zarejestrowanego pojazdu.
 */
export async function isRegisteredVehiclePlate(
  prisma: PrismaService,
  buildingId: number,
  normalizedPlate: string,
): Promise<boolean> {
  if (!normalizedPlate) return false
  const rows = await prisma.$queryRaw<{ id: number }[]>`
    SELECT id FROM "vehicles"
     WHERE "buildingId" = ${buildingId}
       AND regexp_replace(upper("licensePlate"), '[^A-Z0-9]', '', 'g') = ${normalizedPlate}
     LIMIT 1
  `
  return rows.length > 0
}
