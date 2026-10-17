---
"@adonis-agora/authkit-client": patch
---

`bindValue('authkit.client', fake)` replaces the manager again. Since 0.19 the manager is bound by class and the string key was an `alias`, and the container follows an alias before it checks bound values: a fake bound under the string key was silently ignored, and the real manager came back. This is how apps replaced it in tests before 0.19, and the changelog promised the key was kept. The key is now a binding that resolves the class: the same singleton, overridable under either name, and a `swap` of the class reaches it even after its first use.
