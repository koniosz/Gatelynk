/**
 * Cienka warstwa nad `@gatelynk/device-drivers` dla SPA.
 *
 * Driver-katalog importujemy bezpośrednio z `packages/device-drivers/src/`
 * (alias w `vite.config.ts` + path w `tsconfig.json`) — bez build-stepu, bez
 * `node_modules/@gatelynk/...`. Edge SPA i Edge backend zawsze mają
 * identyczny katalog driverów (one source of truth).
 */

import {
  DRIVERS,
  findDriver,
  guessDriverId,
  type DeviceDriver,
  type DriverField,
  type DriverEndpoints,
  type Capability,
  type FieldGroup,
  type DeviceType,
} from '@gatelynk/device-drivers'

export {
  DRIVERS, findDriver, guessDriverId,
}

export type {
  DeviceDriver, DriverField, DriverEndpoints,
  Capability, FieldGroup, DeviceType,
}

/**
 * Zwraca driver dla danego configu — najpierw po `config.driverId`, jeśli brak
 * lub niezarejestrowany, fallback po `manufacturer + model`. Zwraca `null` gdy
 * legacy config nieznanego producenta.
 *
 * Edge backend ma podobną funkcję (`resolveDriver` w `driver-engine.ts`), ale
 * tu rozluźniamy zewnętrzny typ `type` na string — bo z `DeviceEntry.type`
 * przychodzi po prostu string z bazy. Validujemy do `DeviceType` lokalnie.
 */
export function resolveDriverForUI(
  type: string,
  config: Record<string, any>,
): DeviceDriver | null {
  if (config.driverId) {
    const direct = findDriver(config.driverId)
    if (direct) return direct
  }
  if (!isDeviceType(type)) return null
  const guessedId = guessDriverId(type, {
    manufacturer: config.manufacturer,
    model: config.model,
  })
  return findDriver(guessedId)
}

function isDeviceType(t: string): t is DeviceType {
  return [
    'INTERCOM','CAMERA','LPR_CAMERA','ELEVATOR','LIGHTING',
    'SWITCH','LOCK','KNX_BRIDGE','KNX_OBJECT',
  ].includes(t)
}
