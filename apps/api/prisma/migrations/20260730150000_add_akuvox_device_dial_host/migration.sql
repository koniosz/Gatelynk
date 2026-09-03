-- Bugfix 2026-07-30 (realny cykl CSV na R29C): lokalne kontakty stacji dzwonią
-- na SUROWY string z kolumny TEL_* (sample dzwonił na goły IP Edge = fallback-all).
-- Dla routingu per-lokal generujemy SIP URI "<unit.id>@<dialHost>".
-- dialHost ustawia integrator w widoku A (podpowiedź: LAN IP Edge; NIE kopiować
-- ślepo edgeDevice.ipAddress — w bazie bywa IP Tailscale, gotcha legacy phonebooka).
-- Migracja addytywna, pisana ręcznie (drift lokalnej bazy — patrz 20260730100000).

ALTER TABLE "akuvox_devices" ADD COLUMN "dialHost" TEXT;
