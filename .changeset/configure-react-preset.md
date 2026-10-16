---
"@adonis-agora/authkit-server": patch
---

`node ace configure @adonis-agora/authkit-server --ui=react` works again (#194). The React pages the preset publishes went through the stub template engine, which broke on the backticks of their template literals, and their `{{{ exports() }}}` frontmatter had been rewritten by the formatter into `{ exports() }`. The pages are now plain TSX copied byte for byte (a small `ui/react/page.stub` only sets the destination), and a new test runs the real `configure` hook against a scratch app for every preset.
