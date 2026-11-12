---
'@adonis-agora/authkit-server': minor
---

Admin console: switch between the `@adonis-agora` consoles. The admin console registers itself in the shared `agora.consoles` registry (title "Identity"); the sidebar brand becomes a menu of the other consoles the viewer may open, the Overview page shows them as a "Consoles" grid, and Ctrl/Cmd-K searches users and organizations plus every other console the viewer may open. New routes `GET {prefix}/api/consoles` and `GET {prefix}/api/consoles/search?q=`. `registerAgoraConsole` is exported for consoles you mount yourself, and `ctx.agoraProbe` is `true` while another console checks access, so an auditing `authorize` can skip it. Nothing to configure.
