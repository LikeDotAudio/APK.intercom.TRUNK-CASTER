# Principles INTERCOM.Caster keeps

Ecosystem rules live in the root: [Doctrine](../../../../../Documentation/%F0%9F%8F%9BPhilosophy/Doctrine/readme.Doctrine.md),
[Dockers](../../../../../Documentation/%F0%9F%8F%9BPhilosophy/Dockers/readme.Dockers.md).

← [Philosophy](INDEX.md) · [Repo README](../../README.md)

| Principle | Kept by |
|---|---|
| **One copy runs.** The runtime retired here once each piece had its replacement (ROAD-3453); what remains is read, not run. Where each module went is the ARCHITECTURE page. | `PLUGIN.TRUNK_CASTER`, `PLUGIN.TRUNK_SIM`, the soft app `INTERCOM.TRUNK-CASTER` |
| **Speak by protocol, not by brand.** Every switch is one Ward-Beck line. | `contracts/` `trunk` (`renderWardBeckLine`, `parseWardBeckLine`) |
| **Nothing here claims a port.** The imported compose claimed 8080 and 1883, which belong to Storage-Portal and Broker-Mosquitto; the plugins use the APK broker and only Ward-Beck 7879. | no `Docker/` stack here |
