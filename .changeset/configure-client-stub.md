---
"@adonis-agora/authkit-client": patch
---

`node ace configure @adonis-agora/authkit-client` works again: a backtick in a comment of the `oidc_session_controller` stub broke the stub template engine. The stub compile test never failed because `assert.doesNotThrow(fn, message)` treats the string as an error-message matcher; it now collects compile errors explicitly, and a new test runs the real `configure` hook against a scratch app. `configure` also points to `registerOidcClient(router)` as the way to register the session routes, and the getting-started guide and the agent skill teach it first, keeping the ejected controller for apps that customise the flow (#202).
