---
'@adonis-agora/authkit-server': minor
---

New `mail.onNewLogin` hook for the new-IP login alert, so a host can send that email in its own template the same way `onNewDeviceLogin` already allows for the new-device alert.

It receives `{ account, ip, userAgent, timestamp }` and fires only when the IP was never seen for the account and `notifications.newLoginEmail` is on. Without the hook the bundled email goes out as before. `login.new_ip_notified` is audited either way, and an error thrown by the hook is logged without skipping the new-device alert that follows.
