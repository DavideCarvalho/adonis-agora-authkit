---
'@adonis-agora/authkit-server': patch
---

`SettingLockedError`'s message is in English.

The message is not an internal log line: the Admin API's write path turns the
error into a `423 Locked` response and puts the text in the JSON body, where an
operator or an integrator reads it. It was Portuguese, in an otherwise
English-facing API. The `code` (`E_SETTING_LOCKED`) and the `key` property are
unchanged, so anything matching on those is unaffected.
