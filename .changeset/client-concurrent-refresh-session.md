---
'@adonis-agora/authkit-client': patch
---

`maybeRefresh`: concurrent requests of the same session no longer get a 401 when the access token
expires. The refresh is still deduplicated per session id, but requests that wait for the in-flight
refresh now also write the renewed TokenSet (new access token and rotated refresh token) into their
own session — before, only the request that started the refresh got it, and the others kept the
expired access token and the already-rotated refresh token. The in-flight entry is now always
cleared, even when the refresh fails.
