---
'@adonis-agora/authkit-server': minor
'@adonis-agora/authkit-sdk': patch
---

Organization invitations send an email even without a `mail.onOrgInvitation` hook.

`onOrgInvitation` was the only hook in `MailHooks` with no default-mailer
fallback. Every other one degrades to a branded, translated email the host kit
sends itself; this one was guarded by a bare `if (cfg.mail?.onOrgInvitation)`
with no `else`, so a host that had not written the hook created the invitation
row and sent nothing. The invited person was never told they had been invited,
and nothing anywhere reported a problem.

`sendOrgInvitationEmail` now exists alongside the other `send*Email` functions,
with `mail.org_invitation.*` messages in both the English and pt-BR tables, and
both HTTP call sites — the account-facing controller and the admin service — use
the host hook when present and the library default otherwise. Delivery stays
best-effort: a mail failure never breaks invitation creation.

The SDK's embedded driver reached the same service through a third door and had
to be fixed with it. Its out-of-band context now carries the container resolver
and a logger, which is all the default mailer reads, so an invitation created
through `authkit.organizations.invitations.create()` reaches an inbox too rather
than reproducing the original silent failure one layer down.

One latent bug fell out of the rework: the account controller resolved the
organization and the issuer origin *outside* its `try`, so a config with an
unresolvable issuer would have thrown out of a path that must never break
invitation creation. Both are inside the guarded block now.
