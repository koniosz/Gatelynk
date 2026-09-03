import * as os from 'os'
import * as path from 'path'

export default () => ({
  // Production Cloud API to api.gatelynk.com (Fly app `gatelynk-api`).
  // Wcześniej był tu `.pl` — relikt rebrand planów, domena nie istnieje.
  // Po Tahoe upgrade encrypted `edge.cloudUrl` w sqlite się nie odszyfrowuje
  // (MACHINE_ID zmienia się przy upgrade), Edge robi fallback do tej wartości
  // — musi być produkcyjny URL.
  cloudUrl: process.env.CLOUD_URL ?? 'https://api.gatelynk.com',
  port: parseInt(process.env.PORT ?? '4000', 10),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  storePath: process.env.STORE_PATH ?? path.join(os.homedir(), '.gatelynk-edge', 'store.db'),
  version: process.env.npm_package_version ?? '0.1.0',
})
