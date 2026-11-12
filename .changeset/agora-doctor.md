---
'@adonis-agora/authkit-server': minor
---

`node ace agora:doctor`: one health check for every installed `@adonis-agora` lib. authkit registers its checks (every `authkit:doctor` finding under a stable id such as `authkit.issuer`, plus `authkit.signing-key-age`, `authkit.console-gate`, `authkit.peers` and `authkit.agora-siblings`). Flags: `--json`, `--strict`, `--deep`, `--lib`, `--only`, `--verbose`, `--no-boot`; exit `0` / `1` (error, or warning with `--strict`) / `2` (the doctor could not run). New `@adonis-agora/authkit-server/doctor` entry exports the checks for `--no-boot`. `authkit:doctor` is unchanged.
