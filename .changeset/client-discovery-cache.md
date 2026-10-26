---
"@adonis-agora/authkit-client": patch
---

`discoverEndpoints` shares one in-flight fetch per issuer, keeps serving an expired document while a single background refetch replaces it, and aborts the request after 10 s. The `OpaqueResolver` cache (with `cacheTtlMs`) now expires an entry at the token's `exp` when that comes first, and is capped at 10,000 tokens. `lucidMirror` returns an up-to-date row from a plain `findBy` instead of a locking `updateOrCreate` transaction on every request.
