# Principles INTERCOM.Caster keeps

Ecosystem rules live in the root: [Doctrine](../../../../../Documentation/%F0%9F%8F%9BPhilosophy/Doctrine/readme.Doctrine.md),
[Dockers](../../../../../Documentation/%F0%9F%8F%9BPhilosophy/Dockers/readme.Dockers.md).

← [Philosophy](INDEX.md) · [Repo README](../../README.md)

| Principle | Kept by |
|---|---|
| **The reference stays verbatim.** `SRC/` is the source as imported; the rewrite reads it and does not patch it in place. | `SRC/` |
| **Speak by protocol, not by brand.** Every switch is one Ward-Beck line. | `SRC/TRUNK-CASTER-SDK/src/wardbeck.rs` |
| **Nothing runs on the bench until it is on the SDK.** The source's own compose claims 8080 and 1883, which belong to Storage-Portal and Broker-Mosquitto. | no `Docker/` stack here yet |
