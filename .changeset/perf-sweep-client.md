---
"@adonis-agora/authkit-client": patch
---

Performance: `lucidRevocationStore` imports the Lucid `db` service module once per process instead of running a dynamic `import()` on every `isRevoked` call (every authenticated request when back-channel logout is on). It still reads the service's live binding on each call, and a failed import is retried.
