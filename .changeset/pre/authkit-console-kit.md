---
"@adonis-agora/authkit-server": minor
---

The admin console is rebuilt on the Agora console kit: Tailwind 4, the kit's tokens and vendored shadcn components, with the same look as before. Sora and JetBrains Mono now ship inside the bundle (no Google Fonts request), the sidebar collapses to a drawer on phones, every page and data region has its own skeleton and error boundary, and the console switcher, Ctrl/Cmd-K search and sidebar footer are the kit's, shared with the other consoles.

The admin shell's data block gains `viewer` (the signed-in admin) and `signOut` (`POST` to the account logout route with the CSRF token). When it mounts the account login screen, authkit also announces that sign-out on the `agora.consoles` registry (`account.signOut`), so durable, telescope and the other consoles show a working sign-out in their footer. Apps that sign out elsewhere can announce their own route first with the new `announceAgoraSignOut(app, '/logout')`.
