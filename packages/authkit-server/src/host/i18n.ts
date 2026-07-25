/**
 * Internacionalização (i18n) das telas do host-kit.
 *
 * Todas as strings visíveis ao usuário das views Edge (e as mensagens de
 * flash/erro produzidas pelos controllers) vivem num catálogo achatado de
 * chaves pontilhadas. O default embutido é inglês (`en`) — os apps continuam
 * funcionando SEM nenhuma configuração. O pt-BR é um locale embutido: basta
 * `i18n: { locale: 'pt-BR' }`. O host também pode sobrescrever chaves pontuais
 * ou fornecer locales inteiros (ex.: `fr`) via `I18nConfig`.
 */

/** Catálogo achatado de chaves de mensagem → strings. */
export type AuthMessages = Record<string, string>;

export interface I18nConfig {
  /** Locale ativo. Default: 'en'. Locale embutido extra: 'pt-BR'. */
  locale?: string;
  /**
   * Locales adicionais e/ou overrides pontuais. As chaves do locale ativo são
   * mescladas SOBRE o catálogo embutido do locale (ou sobre o default `en`
   * quando o locale não é embutido) — então o host pode trocar só algumas
   * chaves, complementar um locale embutido, ou trazer um locale novo por
   * completo.
   */
  messages?: Record<string, Partial<AuthMessages>>;
}

/** Locale default do host-kit. */
export const DEFAULT_LOCALE = 'en';

/**
 * Catálogo default (inglês) — cobre TODAS as strings visíveis ao usuário das
 * views e as mensagens de flash/erro dos controllers. Chaves agrupadas por tela.
 */
export const DEFAULT_MESSAGES = {
  // Comum / fallback de marca.
  'common.app_fallback': 'Auth',
  'common.brand_eyebrow': 'Auth',

  // Tela de login (interaction OIDC: identifier + password).
  'login.page_title': 'Login',
  'login.title': 'Login',
  'login.identifier_intro': 'Enter your email to continue.',
  'login.email_label': 'Email',
  'login.identifier_submit': 'Continue',
  'login.create_account': 'Create account',
  'login.forgot_password': 'Forgot password',
  'login.divider_or': 'or',
  'login.google': 'Sign in with Google',
  'login.greeting': 'Hi, {name}',
  'login.switch_account': 'Switch account',
  'login.password_label': 'Password',
  'login.submit': 'Log in',
  // Remember-me (session_policy).
  'login.remember_me': 'Keep me signed in',
  // Idle timeout redirect reason.
  'account.login.idle_timeout': 'Your session expired due to inactivity. Please sign in again.',
  // Passwordless (login).
  'login.magic_link_button': 'Email me a login link',
  'login.magic_link_sent': 'If the account exists, we sent you a login link.',
  'signup.magic_link_sent':
    'Check your email — we sent you a link to finish creating your account.',
  'login.passkey_button': 'Sign in with a passkey',
  // Login por OTP (código digitável).
  'login.otp_label': 'Enter the login code from the email',
  'login.otp_placeholder': '000000',
  'login.otp_submit': 'Sign in with the code',
  'login.otp_invalid': 'Invalid code. Please try again.',
  'login.otp_expired': 'This code has expired. Use the login link or request a new one.',
  'login.otp_locked': 'Too many attempts. The code was disabled — use the login link instead.',

  // Tela de cadastro (signup).
  'signup.page_title': 'Create account',
  'signup.title': 'Create account',
  'signup.intro': 'Fill in your details to get started.',
  'signup.name_label': 'Name',
  'signup.email_label': 'Email',
  'signup.password_label': 'Password',
  'signup.submit': 'Create account',
  'signup.have_account': 'I already have an account',

  // Recuperação de senha (forgot).
  'forgot.page_title': 'Reset password',
  'forgot.sent_title': 'Email sent',
  'forgot.sent_body': 'If the email exists, we will send reset instructions.',
  'forgot.title': 'Reset password',
  'forgot.intro': 'We will send you a link to reset your password.',
  'forgot.email_label': 'Email',
  'forgot.submit': 'Send link',

  // Redefinição de senha (reset).
  'reset.page_title': 'Reset password',
  'reset.done_title': 'Password reset',
  'reset.done_body': 'You can now log in with your new password.',
  'reset.title': 'New password',
  'reset.intro': 'Choose a new password for your account.',
  'reset.password_label': 'Password',
  'reset.submit': 'Reset',

  // Verificação de e-mail (verify-email).
  'verify_email.page_title': 'Verify email',
  'verify_email.verified_title': 'Email verified',
  'verify_email.verified_body': 'Your email was confirmed successfully.',
  'verify_email.invalid_title': 'Invalid link',
  'verify_email.invalid_body': 'The verification link is invalid or has already been used.',

  // Desafio de MFA no fluxo de login (mfa-challenge).
  'mfa_challenge.page_title': 'Two-factor verification',
  'mfa_challenge.title': 'Two-factor verification',
  'mfa_challenge.intro': 'Open your authenticator app and enter the 6-digit code.',
  'mfa_challenge.code_label': 'Code',
  'mfa_challenge.submit': 'Verify',
  'mfa_challenge.recovery_summary': 'Use a recovery code',
  'mfa_challenge.recovery_submit': 'Log in with a recovery code',
  'mfa_challenge.passkey_button': 'Use passkey',
  'mfa_challenge.passkey_error': 'Could not authenticate with the passkey. Please try again.',
  'mfa_challenge.trust_device': 'Trust this device for {days} days',

  // Consent (autorização de cliente OIDC).
  'consent.page_title': 'Authorize',
  'consent.title': 'Authorize access',
  // `{app}` é interpolado com o nome do app já envolto em <strong> (renderizado
  // raw na view). O nome vem do branding (config-trusted).
  'consent.body': 'The app <strong>{app}</strong> wants to access your account.',
  'consent.submit': 'Authorize',

  // Console de conta — login (account/login).
  'account.login.page_title': 'My account',
  'account.login.title': 'My account',
  'account.login.intro': 'Manage your access tokens.',
  'account.login.email_label': 'Email',
  'account.login.password_label': 'Password',
  'account.login.submit': 'Log in',

  // Console de conta — tokens (account/tokens).
  'account.tokens.page_title': 'Access tokens',
  'account.tokens.title': 'Access tokens',
  'account.tokens.logout': 'Log out',
  'account.tokens.security': 'Security',
  'account.tokens.created_notice': 'Token created — copy it now, it will not be shown again:',
  'account.tokens.name_placeholder': 'Token name (e.g. CI deploy)',
  'account.tokens.create': 'Create',
  'account.tokens.empty': 'No tokens yet.',
  'account.tokens.created_at': 'Created on {date}',
  'account.tokens.last_used': '· last used {date}',
  'account.tokens.never_used': '· never used',
  'account.tokens.scopes': 'Scopes: {scopes}',
  'account.tokens.audience': 'Audience: {audience}',
  'account.tokens.revoke': 'Revoke',

  // Console de conta — segurança (account/security): senha + e-mail.
  'account.security.page_title': 'Account security',
  'account.security.title': 'Account security',
  'account.security.logout': 'Log out',
  'account.security.current_email': 'Current email: {email}',
  'account.security.not_supported':
    'Changing password and email is not available in this installation.',
  'account.security.password_section': 'Change password',
  'account.security.current_password_label': 'Current password',
  'account.security.new_password_label': 'New password',
  'account.security.change_password_submit': 'Change password',
  'account.security.password_changed': 'Password changed successfully.',
  'account.security.email_section': 'Change email',
  'account.security.email_intro':
    'We will send a confirmation link to the new address. The change only takes effect after confirmation.',
  'account.security.new_email_label': 'New email',
  'account.security.email_password_label': 'Current password',
  'account.security.change_email_submit': 'Request email change',
  'account.security.email_change_requested':
    'We sent a confirmation link to {email}. Click it to complete the change.',
  'account.security.email_changed': 'Email changed successfully.',
  'account.security.email_change_disabled': 'Email change is currently disabled.',
  'account.security.email_change_cancelled': 'Email change request cancelled.',
  // Trusted devices (account/security).
  'account.security.trusted_devices_section': 'Trusted devices',
  'account.security.trusted_devices_intro':
    'You can stop trusting this browser so two-factor is required here again. To revoke trust on all devices, re-enroll your authenticator.',
  'account.security.trusted_devices_revoke': 'Stop trusting this device',
  'account.security.trusted_devices_revoked':
    'This device is no longer trusted. Two-factor will be required here again.',
  'account.security.sessions_section': 'Active sessions',
  'account.security.sessions_intro':
    'Devices and locations where your account is currently signed in.',
  'account.security.sessions_empty': 'No active sessions.',

  // Console de conta — perfil (seção em account/security).
  'account.profile.section': 'Profile',
  'account.profile.intro': 'Update your display name and avatar.',
  'account.profile.name_label': 'Name',
  'account.profile.avatar_label': 'Avatar URL',
  'account.profile.avatar_upload_label': 'Upload avatar',
  'account.profile.avatar_upload_hint': 'JPG, PNG or WebP, up to 5MB.',
  'account.profile.avatar_invalid_type': 'Invalid image type. Use JPG, PNG or WebP.',
  'account.profile.avatar_too_large': 'Image is too large.',
  'account.profile.submit': 'Save profile',
  'account.profile.updated': 'Profile updated successfully.',
  'account.profile.not_supported': 'Profile editing is not available in this installation.',

  // Console de conta — exportar dados (portabilidade, LGPD/GDPR).
  'account.export.section': 'Export your data',
  'account.export.intro':
    'Download a copy of your data: profile, linked identities, authorized apps, active sessions, passkeys and your audit history. No secrets or tokens are included.',
  'account.export.submit': 'Download my data (JSON)',
  'account.export.requested': 'Your data export is being prepared and will be delivered shortly.',

  // Console de conta — deletar conta (danger zone, LGPD/GDPR).
  'account.delete.section': 'Delete account',
  'account.delete.intro':
    'Permanently delete your account and all associated data: sessions, authorized apps, personal access tokens, passkeys, linked identities and two-factor secrets. This cannot be undone.',
  'account.delete.confirm_password_label': 'Confirm with your current password',
  'account.delete.confirm_email_label': 'Type your email to confirm',
  'account.delete.submit': 'Delete my account',
  'account.delete.deleted': 'Your account has been permanently deleted.',
  'account.delete.invalid_confirmation': 'Confirmation failed. Your account was not deleted.',
  'account.delete.not_supported': 'Account deletion is not available in this installation.',

  // Console de conta — apps com acesso (account/apps).
  'account.apps.page_title': 'Apps with access',
  'account.apps.title': 'Apps with access',
  'account.apps.intro': 'Apps you have authorized to access your account.',
  'account.apps.logout': 'Log out',
  'account.apps.empty': 'No apps have access to your account.',
  'account.apps.tokens': '{accessTokens} access · {refreshTokens} refresh',
  'account.apps.revoke': 'Revoke access',
  'account.apps.revoke_confirm':
    'Revoke this app’s access? It will need to be authorized again and its tokens will stop working.',
  'account.apps.revoked': 'Access revoked.',
  'account.apps.not_supported':
    'The configured OIDC adapter does not support enumeration — listing apps is unavailable.',

  // Console de conta — organizations (account/orgs).
  'account.orgs.page_title': 'My Organizations',
  'account.orgs.title': 'My Organizations',
  'account.orgs.logout': 'Log out',
  'account.orgs.empty': 'You are not a member of any organization.',
  'account.orgs.active_badge': 'Active',
  'account.orgs.activate': 'Set as active',
  'account.orgs.deactivate': 'Deactivate',
  'account.orgs.leave': 'Leave',
  'account.orgs.leave_last_owner': 'Cannot leave — you are the only owner.',
  'account.orgs.create_section': 'Create organization',
  'account.orgs.create_name_label': 'Name',
  'account.orgs.create_slug_label': 'Slug (URL-friendly identifier)',
  'account.orgs.create_submit': 'Create organization',
  'account.orgs.created': 'Organization created.',
  'account.orgs.activated': 'Organization activated.',
  'account.orgs.deactivated': 'Organization deactivated.',
  'account.orgs.left': 'You left the organization.',
  'account.orgs.not_supported': 'Organizations are not available in this installation.',
  'account.orgs.not_member': 'You are not a member of this organization.',
  // Invitations section
  'account.orgs.invitations_section': 'Pending invitations',
  'account.orgs.invitations_empty': 'No pending invitations.',
  'account.orgs.invitation_from': 'Invited to {orgName} as {role}',
  'account.orgs.invitation_accept': 'Accept',
  'account.orgs.invitation_accepted': 'Invitation accepted.',
  'account.orgs.invitation_error': 'Could not accept invitation.',
  // Members (for owners/admins)
  'account.orgs.members_section': 'Members',
  'account.orgs.invite_section': 'Invite by email',
  'account.orgs.invite_email_label': 'Email',
  'account.orgs.invite_role_label': 'Role',
  'account.orgs.invite_submit': 'Send invitation',
  'account.orgs.invited': 'Invitation sent.',
  'account.orgs.remove_member': 'Remove',
  'account.orgs.member_removed': 'Member removed.',
  'account.orgs.change_role': 'Change role',
  'account.orgs.role_updated': 'Role updated.',

  // Confirmação de troca de e-mail (account/email-confirmed).
  'account.email_confirmed.page_title': 'Email confirmation',
  'account.email_confirmed.ok_title': 'Email changed',
  'account.email_confirmed.ok_body': 'Your new email has been confirmed and is now active.',
  'account.email_confirmed.invalid_title': 'Invalid link',
  'account.email_confirmed.invalid_body':
    'The confirmation link is invalid or has already been used.',

  // Console de conta — MFA (account/mfa).
  'account.mfa.page_title': 'Two-factor verification',
  'account.mfa.title': 'Two-factor verification',
  'account.mfa.logout': 'Log out',
  'account.mfa.recovery_codes_notice': 'Save your recovery codes — they will not be shown again:',
  'account.mfa.enroll_intro':
    'Scan the QR code with your authenticator app (Google Authenticator, 1Password, etc.).',
  'account.mfa.qr_alt': 'TOTP QR code',
  'account.mfa.manual_intro': 'Or enter it manually:',
  'account.mfa.confirm_code_label': 'Confirmation code',
  'account.mfa.activate': 'Enable two-factor verification',
  'account.mfa.enabled_html':
    'Two-factor verification is <span class="font-semibold text-emerald-700">enabled</span> on this account.',
  'account.mfa.disable': 'Disable',
  'account.mfa.disabled_intro':
    'Two-factor verification is disabled. Enable it to protect your account with an authenticator app.',
  'account.mfa.enable': 'Enable two-factor verification',

  // Console de conta — passkeys (WebAuthn) na tela de MFA.
  'mfa.passkey.section_title': 'Passkeys',
  'mfa.passkey.section_intro':
    'Use a passkey (biometrics, device PIN, or security key) as a second factor, without typing codes.',
  'mfa.passkey.add': 'Add passkey',
  'mfa.passkey.remove': 'Remove',
  'mfa.passkey.empty': 'No passkeys registered.',
  'mfa.passkey.unnamed': 'Passkey',
  'mfa.passkey.created_at': 'Created on {date}',
  'mfa.passkey.register_error': 'Could not register the passkey. Please try again.',
  'mfa.passkey.unsupported': 'Your browser does not support passkeys.',

  // Console admin (B6) — navegação compartilhada.
  'admin.nav.roles': 'Roles',
  'admin.nav.dashboard': 'Dashboard',
  'admin.nav.users': 'Users',
  'admin.nav.orgs': 'Organizations',
  'admin.nav.clients': 'Clients',
  'admin.nav.audit': 'Audit',
  'admin.nav.settings': 'Settings',
  'admin.nav.logout': 'Log out',

  // Console admin — dashboard.
  'admin.dashboard.page_title': 'Admin dashboard',
  'admin.dashboard.title': 'Admin dashboard',
  'admin.dashboard.users_count': 'Users',
  'admin.dashboard.clients_count': 'Clients',
  'admin.dashboard.audit_count': 'Audit events',
  'admin.dashboard.recent_title': 'Recent events',
  'admin.dashboard.mau': 'Active users (30d)',
  'admin.dashboard.active_sessions': 'Active sessions',
  'admin.dashboard.signins_title': 'Sign-ins (last {days}d)',
  'admin.dashboard.signups_title': 'Sign-ups (last {days}d)',

  // Console admin — usuários.
  'admin.users.page_title': 'Users',
  'admin.users.title': 'Users',
  'admin.users.search_placeholder': 'Search by email',
  'admin.users.search': 'Search',
  'admin.users.empty': 'No users found.',
  'admin.users.roles_placeholder': 'Roles (comma-separated)',
  'admin.users.save_roles': 'Save roles',
  'admin.users.sessions': 'Sessions',
  'admin.users.create_section': 'Create user',
  'admin.users.create_name_placeholder': 'Name (optional)',
  'admin.users.create_email_placeholder': 'Email',
  'admin.users.create_password_placeholder': 'Password (leave blank to send invite)',
  'admin.users.create_submit': 'Create user',
  'admin.users.created': 'User created.',
  'admin.users.reset_password': 'Send password reset',
  'admin.users.reset_sent': 'Password reset email sent.',
  'admin.users.disable': 'Disable',
  'admin.users.enable': 'Enable',
  'admin.users.disabled': 'Account disabled.',
  'admin.users.enabled': 'Account enabled.',
  'admin.users.deleted': 'Account permanently deleted.',
  'admin.users.delete_unsupported': 'The account store does not support deleting users.',
  'admin.users.delete': 'Delete',
  'admin.users.delete_confirm':
    'Permanently delete this account and all its data? This cannot be undone.',
  'admin.users.disabled_badge': 'Disabled',
  'admin.users.disable_confirm': 'Disable this account? The user will not be able to log in.',

  // Console admin — sessões/grants ativos de uma conta.
  'admin.sessions.page_title': 'Active sessions',
  'admin.sessions.title': 'Active sessions',
  'admin.sessions.account': 'Account: {email}',
  'admin.sessions.back': 'Back to users',
  'admin.sessions.not_supported':
    'The configured OIDC adapter does not support enumeration — session inspection is unavailable.',
  'admin.sessions.revoked_notice':
    'Revoked: {sessions} session(s), {grants} grant(s), {accessTokens} access token(s), {refreshTokens} refresh token(s).',
  'admin.sessions.sessions_section': 'Sessions (IdP login)',
  'admin.sessions.sessions_empty': 'No active sessions.',
  'admin.sessions.session_login_ts': 'Login: {date}',
  'admin.sessions.session_amr': 'Methods: {amr}',
  'admin.sessions.session_device': '{browser} on {os}',
  'admin.sessions.session_ip': 'IP: {ip}',
  'admin.sessions.session_ip_geo': 'IP: {ip} · {location}',
  'admin.sessions.grants_section': 'Grants (per-client authorizations)',
  'admin.sessions.grants_empty': 'No active grants.',
  'admin.sessions.grant_client': 'Client: {clientId}',
  'admin.sessions.grant_tokens': '{accessTokens} access · {refreshTokens} refresh',
  'admin.sessions.revoke_all': 'Revoke all sessions and grants',
  'admin.sessions.revoke_confirm':
    'Revoke all sessions and grants for this account? The user will need to log in again and issued tokens will stop working.',

  // Console admin — impersonation (RFC 8693 token exchange).
  'admin.impersonation.title': 'Impersonate this user',
  'admin.impersonation.help':
    'Token Exchange (RFC 8693) lets an admin act as this user. There is no auth bypass: you exchange YOUR OWN admin access token for one scoped to the target.',
  'admin.impersonation.curl_label': 'Ready-to-run request',
  'admin.impersonation.note':
    'Replace <ADMIN_ACCESS_TOKEN> with a current admin access token. The resulting id_token carries act={sub: admin}; the event is audited as impersonation.started.',
  'admin.impersonation.no_client':
    'No client has the token-exchange grant enabled. Add "urn:ietf:params:oauth:grant-type:token-exchange" to a client to enable impersonation.',

  // Console admin — clients.
  'admin.clients.page_title': 'OAuth clients',
  'admin.clients.title': 'OAuth clients',
  'admin.clients.empty': 'No clients configured.',
  'admin.clients.confidential': 'Confidential',
  'admin.clients.public': 'Public',
  'admin.clients.grants': 'Grants: {grants}',
  'admin.clients.redirect_uris': 'Redirects: {uris}',
  'admin.clients.dynamic_notice':
    'Dynamic client registration (RFC 7591) is on — clients registered via /reg are persisted in the adapter and appear in the dynamic section below.',
  'admin.clients.static_section': 'Static clients (config)',
  'admin.clients.dynamic_section': 'Dynamic clients (adapter)',
  'admin.clients.dynamic_empty': 'No dynamic clients persisted.',
  'admin.clients.dynamic_not_supported':
    'The configured OIDC adapter does not support client enumeration — dynamic management is unavailable.',
  'admin.clients.new': 'New client',
  'admin.clients.new_title': 'New OIDC client',
  'admin.clients.edit_title': 'Edit OIDC client',
  'admin.clients.edit': 'Edit',
  'admin.clients.delete': 'Delete',
  'admin.clients.delete_confirm': 'Delete this client? This action cannot be undone.',
  'admin.clients.regenerate_secret': 'Regenerate secret',
  'admin.clients.regenerate_confirm':
    'Regenerate the secret? The current secret will stop working immediately.',
  'admin.clients.back': 'Back',
  'admin.clients.cancel': 'Cancel',
  'admin.clients.save': 'Save',
  'admin.clients.create': 'Create client',
  'admin.clients.secret_once_title': 'Save the client_secret now',
  'admin.clients.secret_once_notice':
    'This is the only time the secret is shown. Copy it now — it cannot be retrieved later.',
  'admin.clients.field_client_id': 'Client ID',
  'admin.clients.field_client_id_placeholder': 'leave blank to generate automatically',
  'admin.clients.field_client_id_help':
    'Optional. If empty, a random identifier will be generated.',
  'admin.clients.field_redirect_uris': 'Redirect URIs',
  'admin.clients.field_redirect_uris_help': 'One URI per line.',
  'admin.clients.field_post_logout_uris': 'Post-logout redirect URIs',
  'admin.clients.field_post_logout_uris_help': 'One URI per line (optional).',
  'admin.clients.field_grant_types': 'Grant types',
  'admin.clients.field_auth_method': 'Token endpoint auth method',
  'admin.clients.field_backchannel_uri': 'Back-Channel Logout URI (optional)',
  'admin.clients.field_backchannel_uri_help':
    'OIDC Back-Channel Logout endpoint of the RP. Leave blank if not needed.',
  'admin.clients.field_backchannel_session_required': 'Require sid in logout_token',
  'admin.clients.field_backchannel_session_required_help':
    'When checked, the IdP includes the session ID (sid) in every logout_token sent to this client.',
  'admin.clients.static_deprecated_notice':
    'These clients are defined statically in config and are deprecated. ' +
    'Migrate them to the adapter/DB with:',

  // Console admin — organizations.
  'admin.orgs.page_title': 'Organizations',
  'admin.orgs.title': 'Organizations',
  'admin.orgs.detail_title': 'Organization',
  'admin.orgs.not_supported': 'Organizations are not available in this installation.',
  'admin.orgs.empty': 'No organizations found.',
  'admin.orgs.create_section': 'Create organization',
  'admin.orgs.create_name_placeholder': 'Name',
  'admin.orgs.create_slug_placeholder': 'Slug (URL-friendly)',
  'admin.orgs.create_submit': 'Create organization',
  'admin.orgs.created': 'Organization created.',
  'admin.orgs.deleted': 'Organization deleted.',
  'admin.orgs.slug_taken': 'An organization with this slug already exists.',
  'admin.orgs.invalid_input': 'Name, slug and owner account are required.',
  'admin.orgs.view': 'View',
  'admin.orgs.delete': 'Delete',
  'admin.orgs.delete_confirm':
    'Permanently delete this organization and all its members/invitations? This cannot be undone.',
  'admin.orgs.back': 'Back to organizations',
  'admin.orgs.members_section': 'Members',
  'admin.orgs.members_count': 'members',
  'admin.orgs.members_empty': 'No members.',
  'admin.orgs.add_member_section': 'Add member',
  'admin.orgs.select_account': '— Select account —',
  'admin.orgs.add_member_submit': 'Add member',
  'admin.orgs.member_added': 'Member added.',
  'admin.orgs.member_removed': 'Member removed.',
  'admin.orgs.member_add_error': 'Could not add member.',
  'admin.orgs.member_remove_error': 'Could not remove member.',
  'admin.orgs.member_remove_confirm': 'Remove this member?',
  'admin.orgs.remove_member': 'Remove',
  'admin.orgs.last_owner': 'Cannot remove the last owner.',
  'admin.orgs.invitations_section': 'Pending invitations',
  'admin.orgs.expires': 'Expires',
  'admin.orgs.revoke_invitation': 'Revoke',
  'admin.orgs.invitation_revoked': 'Invitation revoked.',
  'admin.orgs.danger_zone': 'Danger zone',

  // Console admin — auditoria.
  'admin.audit.page_title': 'Audit',
  'admin.audit.title': 'Audit log',
  'admin.audit.type_placeholder': 'Filter by type',
  'admin.audit.subject_placeholder': 'Filter by subject (accountId)',
  'admin.audit.filter': 'Filter',
  'admin.audit.empty': 'No events found.',
  'admin.audit.not_supported': 'The configured audit sink does not support querying.',

  // Console admin — settings (runtime configuration).
  'admin.settings.page_title': 'Settings',
  'admin.settings.title': 'Settings',
  'admin.settings.bot_protection_section': 'Bot protection',
  'admin.settings.bot_protection_intro':
    'Override the static config at runtime. The `verify` function always comes from config — only on/off and which actions are affected can be changed here.',
  'admin.settings.bot_protection_no_verify':
    'Bot protection is not configured — add `botProtection.verify` to config/authkit.ts to enable this feature.',
  'admin.settings.no_settings_table':
    'The `auth_settings` table is not present. To enable runtime settings, create it: `key TEXT PK, value TEXT NOT NULL, updated_at TIMESTAMP, updated_by TEXT`.',
  'admin.settings.enabled_label': 'Enabled',
  'admin.settings.actions_label': 'Active on',
  'admin.settings.action_login': 'Login',
  'admin.settings.action_signup': 'Signup',
  'admin.settings.action_reset': 'Password reset',
  'admin.settings.save': 'Save',
  'admin.settings.saved': 'Settings saved.',
  'admin.settings.reset_to_config': 'Reset to config',
  'admin.settings.reset_done': 'Runtime setting cleared — config is now the source of truth.',
  // Registration setting card.
  'admin.settings.registration_section': 'Open registration',
  'admin.settings.registration_intro':
    'Controls whether new users can self-register (public signup). Admin-created accounts and org invitations are never affected.',
  'admin.settings.registration_from_config': 'Source: static config',
  'admin.settings.registration_from_setting': 'Source: runtime setting',
  // require_verified_email setting card.
  'admin.settings.require_verified_email_section': 'Require verified email',
  'admin.settings.require_verified_email_intro':
    'When enabled, login is blocked for accounts whose email has not been verified (applies to password, magic link and passkey-first flows). Overrides the static `login.requireVerifiedEmail` config.',
  'admin.settings.require_verified_email_config_note':
    'Note: overrides `login.requireVerifiedEmail` in config/authkit.ts at runtime.',
  'admin.settings.require_verified_email_from_config': 'Source: static config',
  'admin.settings.require_verified_email_from_setting': 'Source: runtime setting',
  // Maintenance mode setting card.
  'admin.settings.maintenance_section': 'Maintenance mode',
  'admin.settings.maintenance_intro':
    'When on, login/signup/forgot/interaction screens show a maintenance page and reject POSTs. Existing OIDC tokens (refresh, userinfo, introspection) continue to work. The Admin API and admin console remain accessible.',
  'admin.settings.maintenance_message_label': 'Custom message (optional)',
  'admin.settings.maintenance_message_placeholder':
    'We are performing scheduled maintenance. Please try again later.',
  'admin.settings.maintenance_warning':
    'LOCKOUT WARNING: If you enable maintenance mode and lose access to the Admin API, you will not be able to disable it remotely. Accounts with an admin role can still log in — but if you are locked out, use the Admin REST API (PUT /api/authkit/v1/settings/maintenance_mode with {"value":{"enabled":false}}) to disable it without a browser login.',
  'admin.settings.maintenance_from_setting': 'Source: runtime setting',

  // Auth methods setting card (admin console).
  'admin.settings.auth_methods_section': 'Authentication methods',
  'admin.settings.auth_methods_intro':
    'Control which login methods are offered on the login screen at runtime. Disabling all methods activates a fail-safe that restores config defaults.',
  'admin.settings.auth_methods_from_config': 'Source: static config',
  'admin.settings.auth_methods_from_setting': 'Source: runtime setting',
  'admin.settings.auth_methods_password_label': 'Password',
  'admin.settings.auth_methods_magic_link_label': 'Magic link (email login link)',
  'admin.settings.auth_methods_passkey_label': 'Passkey (passwordless)',
  'admin.settings.auth_methods_forgot_password_label': 'Forgot password link',
  'admin.settings.auth_methods_social_section': 'Social providers',
  'admin.settings.auth_methods_social_intro':
    'Only providers configured in the code can be enabled here.',
  'admin.settings.auth_methods_magic_link_unavailable':
    'Unavailable — requires mail and `passwordless.magicLink` in config.',
  'admin.settings.auth_methods_passkey_unavailable':
    'Unavailable — requires WebAuthn configured in config.',
  'admin.settings.auth_methods_forgot_disabled_hint':
    'Automatically disabled when password method is off.',
  'admin.settings.auth_methods_no_social': 'No social providers configured in the static config.',
  'admin.settings.auth_methods_passkey_autofill_label':
    'Enable passkey autofill (conditional mediation — suggests passkeys in the email input)',

  // Generic social provider label (fallback when no specific translation exists).
  'login.social_provider': 'Sign in with {provider}',

  // Console admin — paginação compartilhada.
  'admin.pagination.page': 'Page {page} of {total}',
  'admin.pagination.prev': 'Previous',
  'admin.pagination.next': 'Next',

  // Device Authorization Grant (RFC 8628) — telas servidas pelo oidc-provider.
  'device.input.title': 'Sign in to the device',
  'device.input.intro': 'Enter the code shown on your device.',
  'device.input.submit': 'Continue',
  'device.input.error_invalid': 'The code you entered is incorrect. Please try again.',
  'device.input.error_aborted': 'The login request was aborted.',
  'device.input.error_generic': 'An error occurred while processing your request.',
  'device.confirm.title': 'Confirm device',
  'device.confirm.body':
    'The code below should be displayed on your device. Confirm only if you recognize it.',
  'device.confirm.submit': 'Continue',
  'device.confirm.abort': 'Cancel',
  'device.success.title': 'Login complete',
  'device.success.body': 'You are signed in. You can return to your device.',

  // RP-initiated logout (end_session) — splash de saída e tela de sucesso.
  'logout.title': 'Signing out',
  'logout.body': 'Ending your session…',
  'logout.fallback': 'Sign out',
  'logout.success.title': 'Signed out',
  'logout.success.body': 'You have been signed out. See you soon.',

  // Step-up auth (acr_values): cliente exige MFA mas a conta não tem MFA enrolado.
  'mfa_challenge.required_no_enrollment':
    'This client requires two-factor verification. Set up MFA in your account console to continue.',

  // Mensagens de erro/flash produzidas pelos controllers.
  'errors.invalid_credentials': 'Invalid credentials',
  'errors.invalid_code': 'Invalid code',
  'errors.account_disabled': 'This account has been disabled.',
  'errors.email_unverified':
    'Please verify your email address before signing in. Check your inbox for the verification link.',
  'errors.email_taken': 'Email already registered',
  'errors.signup_failed': 'Could not create the account',
  'errors.invalid_or_expired_token': 'Invalid or expired token',
  'errors.account_locked':
    'Account temporarily locked due to too many attempts. Try again in {seconds}s.',
  'errors.otp_locked':
    'Two-factor authentication has been locked due to too many failed attempts. A recovery link has been sent to your email.',
  'errors.bot_protection_failed': 'Bot verification failed. Please try again.',
  'errors.session_expired': 'Session expired',
  'errors.challenge_expired': 'Challenge expired',
  'errors.passkeys_unavailable': 'Passkeys unavailable',
  'errors.no_passkey_registered': 'No passkey registered',
  'errors.registration_disabled':
    'Registration is currently disabled. Please contact the administrator to get access.',
  'errors.not_found': 'Not found.',

  // Manutenção do sistema.
  'maintenance.title': 'Under Maintenance',
  'maintenance.default_message':
    'The service is temporarily unavailable for maintenance. Please try again shortly.',
  'maintenance.admin_login_note':
    'If you are an administrator, you may still log in to manage the system.',

  // Sessão de login (interaction OIDC) expirada/perdida — recuperação graciosa.
  'session_expired.page_title': 'Session expired',
  'session_expired.title': 'Your session expired',
  'session_expired.body':
    'Your login session expired or could not be found. This can happen if you left the page open too long. Please start again.',
  'session_expired.login_link': 'Back to login',

  // Tela amigável de throttle (429) nas rotas de browser — ver `withFriendly429`.
  'throttled.page_title': 'Too many attempts',
  'throttled.title': 'Too many attempts',
  'throttled.body_seconds': 'You have made too many attempts. Please wait {seconds} seconds and try again.',
  'throttled.body': 'You have made too many attempts. Please wait a moment and try again.',
  'throttled.retry_link': 'Back and try again',

  // Política de senha (validação ao definir uma senha nova) + vazamento (HIBP) + histórico + expiração.
  'password.policy.min_length': 'Password must be at least {min} characters long.',
  'password.policy.uppercase': 'Password must contain at least one uppercase letter.',
  'password.policy.lowercase': 'Password must contain at least one lowercase letter.',
  'password.policy.numbers': 'Password must contain at least one number.',
  'password.policy.symbols': 'Password must contain at least one symbol.',
  'password.pwned':
    'This password has appeared in known data breaches. Please choose a different one.',
  'password.common': 'This password is too common. Please choose a more unique password.',
  'password.reused':
    'This password was used recently. Please choose a different one (last {count} passwords are remembered).',
  // Step de troca obrigatória (expiração de senha).
  'login.password_expired_title': 'Password expired',
  'login.password_expired_intro':
    'Your password has expired. Please set a new password to continue.',
  'login.password_expired_new_label': 'New password',
  'login.password_expired_submit': 'Set new password',
  // Banner de graça de verificação de e-mail.
  'login.email_grace_banner': 'Please verify your email. You have {days} day(s) remaining.',
  // Admin settings — password hygiene cards.
  'admin.settings.password_history_section': 'Password reuse history',
  'admin.settings.password_history_intro':
    'Prevents users from reusing recent passwords. Requires the `auth_password_history` table. When enabled, the last N password hashes are stored and checked on every password change.',
  'admin.settings.password_history_count_label': 'Password history count',
  'admin.settings.password_history_from_config': 'Source: defaults',
  'admin.settings.password_history_from_setting': 'Source: runtime setting',
  'admin.settings.password_history_no_table':
    'The `auth_password_history` table is not present. Create it to enable this feature: `id UUID/SERIAL PK, account_id TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TIMESTAMP NOT NULL`.',
  'admin.settings.password_expiration_section': 'Password expiration',
  'admin.settings.password_expiration_intro':
    'Forces users to change their password after a set number of days. Requires the `password_changed_at` column in the auth users table.',
  'admin.settings.password_expiration_max_age_label': 'Max password age (days)',
  'admin.settings.password_expiration_from_config': 'Source: defaults',
  'admin.settings.password_expiration_from_setting': 'Source: runtime setting',
  'admin.settings.password_expiration_no_column':
    'The `password_changed_at` column is not present in the auth users table. Add it (TIMESTAMP NULL) to enable this feature.',

  // Assuntos/corpos de e-mail transacional (default_mailer).
  'mail.common.link_fallback':
    'If the button does not work, copy and paste this link into your browser:',

  'mail.reset.subject': 'Reset your password',
  'mail.reset.heading': 'Reset your password',
  'mail.reset.intro': 'We received a request to reset the password for your account.',
  'mail.reset.cta': 'Reset password',
  'mail.reset.fallback': 'If you did not request this, you can ignore this email.',
  'mail.reset.expires': 'This link expires in {minutes} minutes.',

  'mail.verify.subject': 'Verify your email',
  'mail.verify.heading': 'Verify your email',
  'mail.verify.intro': 'Confirm your email address to finish setting up your account.',
  'mail.verify.cta': 'Verify email',
  'mail.verify.fallback': 'If you did not create this account, you can ignore this email.',
  'mail.verify.expires': 'This link expires in {minutes} minutes.',

  'mail.magic_link.subject': 'Your login link',
  'mail.magic_link.heading': 'Sign in to your account',
  'mail.magic_link.intro':
    'Click the button below to sign in. The link expires shortly and can be used once.',
  'mail.magic_link.cta': 'Sign in',
  'mail.magic_link.fallback': 'If you did not request this, you can ignore this email.',
  'mail.magic_link.code_label': 'Or enter this code to sign in:',
  // E-mail "só código" (login choose-first com channel: 'code'): sem botão/link.
  'mail.magic_link.code_subject': 'Your login code',
  'mail.magic_link.code_intro':
    'Use the code below to sign in. It expires shortly and can be used once.',
  'mail.magic_link.code_only_label': 'Enter this code to sign in:',

  'mail.new_login.subject': 'New login to your account',
  'mail.new_login.heading': 'New login detected',
  'mail.new_login.intro': 'We detected a new login to your account.',
  'mail.new_login.when': 'When: {date}',
  'mail.new_login.ip': 'IP address: {ip}',
  'mail.new_login.device': 'Device: {device}',
  'mail.new_login.fallback':
    'If this was you, no action is needed. If not, reset your password right away.',

  'mail.email_change.subject': 'Confirm your new email',
  'mail.email_change.heading': 'Confirm your new email',
  'mail.email_change.intro':
    'We received a request to change the email address on your account. Confirm the new address below.',
  'mail.email_change.cta': 'Confirm new email',
  'mail.email_change.fallback': 'If you did not request this, you can ignore this email.',
  'mail.email_change.expires': 'This link expires in {minutes} minutes.',

  // E-mail de aviso ao endereço ATUAL quando troca de e-mail é solicitada.
  'mail.email_change_notice.subject': 'Email change requested',
  'mail.email_change_notice.heading': 'Email change requested',
  'mail.email_change_notice.intro':
    'A request was made to change the email address on your account to {newEmail}. A confirmation link was sent to the new address.',
  'mail.email_change_notice.cta': 'Review account security',
  'mail.email_change_notice.fallback':
    'If this was not you, your account may be compromised — change your password immediately.',

  // E-mail de confirmação ao endereço ANTIGO após troca concluída.
  'mail.email_changed_completed.subject': 'Your email address has been changed',
  'mail.email_changed_completed.heading': 'Email address changed',
  'mail.email_changed_completed.intro':
    'The email address on your account has been changed from {oldEmail} to {newEmail}.',
  'mail.email_changed_completed.cta': 'Review account security',
  'mail.email_changed_completed.fallback': 'If this was not you, contact support immediately.',

  // E-mails de notificação de segurança (senha alterada, MFA, passkey, e-mail).
  'mail.security_notice.subject': 'Security alert: {kind}',
  'mail.security_notice.heading': 'Security alert',
  'mail.security_notice.intro': 'A security event occurred on your account: {kind}.',
  'mail.security_notice.when': 'When: {date}',
  'mail.security_notice.ip': 'IP address: {ip}',
  'mail.security_notice.fallback':
    'If this was you, no action is needed. If not, secure your account immediately.',
  'mail.security_notice.kind_password_changed': 'password changed',
  'mail.security_notice.kind_mfa_enabled': 'two-factor authentication enabled',
  'mail.security_notice.kind_mfa_disabled': 'two-factor authentication disabled',
  'mail.security_notice.kind_passkey_added': 'passkey added',
  'mail.security_notice.kind_passkey_removed': 'passkey removed',
  'mail.security_notice.kind_email_changed': 'email address changed',

  // E-mail de desbloqueio do fator OTP.
  'mail.otp_unlock.subject': 'Two-factor authentication unlock',
  'mail.otp_unlock.heading': 'Unlock your two-factor authentication',
  'mail.otp_unlock.intro':
    'Your two-factor authentication factor has been locked due to too many failed attempts. Click the button below to unlock it.',
  'mail.otp_unlock.cta': 'Unlock two-factor',
  'mail.otp_unlock.fallback':
    'If you did not attempt to sign in, your account may be at risk — change your password immediately.',

  // Tela de desbloqueio OTP (/auth/otp-unlock/:token).
  // Sudo mode (confirm identity — /account/confirm).
  'account.confirm.page_title': 'Confirm your identity',
  'account.confirm.title': 'Confirm your identity',
  'account.confirm.intro': 'For security, please confirm your password to continue.',
  'account.confirm.password_label': 'Password',
  'account.confirm.submit': 'Confirm',
  'account.confirm.passkey_button': 'Confirm with passkey',
  'account.confirm.error': 'Incorrect password.',
  'account.confirm.passkey_error': 'Could not authenticate with the passkey. Please try again.',
  'account.confirm.passwordless_notice':
    'This account does not have a password. Please add a passkey to use sudo-protected features.',
  // Rótulos dos métodos do SPI de sudo (account/confirm.edge, um bloco por método disponível).
  'account.confirm.method.password': 'Confirm with your password',
  'account.confirm.method.passkey': 'Confirm with a passkey',
  'account.confirm.method.magic_link': 'Email me a confirmation link',
  'account.confirm.method.oidc_step_up': 'Sign in again to confirm',
  'account.confirm.magic_link_sent':
    'We sent a confirmation link to your email. It expires in 5 minutes.',
  'account.confirm.no_methods':
    'No confirmation method is available for this account. Contact support.',
  'account.confirm.preferred_badge': 'Used last time',

  // Admin settings — sudo_mode card.
  'admin.settings.sudo_mode_section': 'Sudo mode (identity confirmation)',
  'admin.settings.sudo_mode_intro':
    'When enabled, sensitive actions (password change, email change, account deletion, MFA/passkey management, PAT creation/revocation) require the user to confirm their password. The confirmation is valid for a configurable grace period.',
  'admin.settings.sudo_mode_from_config': 'Source: defaults',
  'admin.settings.sudo_mode_from_setting': 'Source: runtime setting',
  'admin.settings.sudo_mode_grace_label': 'Grace period (minutes)',

  'otp_unlock.page_title': 'Two-factor unlock',
  'otp_unlock.ok_title': 'Two-factor authentication unlocked',
  'otp_unlock.ok_body':
    'Your two-factor authentication factor has been unlocked. You can now sign in again.',
  'otp_unlock.login_link': 'Back to login',
  'otp_unlock.invalid_title': 'Invalid or expired link',
  'otp_unlock.invalid_body':
    'The unlock link is invalid or has already been used. Request a new one by attempting to sign in again.',
  'otp_unlock.expired_body':
    'The unlock link has expired. Please sign in again to receive a new link.',

  // Admin settings — otp_lockout card.
  'admin.settings.otp_lockout_section': 'OTP factor lockout',
  'admin.settings.otp_lockout_intro':
    'Locks the TOTP/recovery factor (not the account) after N consecutive failures. Sends an email unlock link. Requires @adonisjs/limiter. Keyed by account ID.',
  'admin.settings.otp_lockout_from_config': 'Source: defaults',
  'admin.settings.otp_lockout_from_setting': 'Source: runtime setting',
  'admin.settings.otp_lockout_max_attempts_label': 'Max failed attempts before lockout',
  'admin.settings.otp_lockout_unlock_ttl_label': 'Unlock token TTL (hours)',

  // Admin settings — email_change card.
  'admin.settings.email_change_section': 'Email change',
  'admin.settings.email_change_intro':
    'Controls the verified email-change flow. When enabled, users can request an email change from /account/security; a confirmation link is sent to the new address and a security notice to the current one.',
  'admin.settings.email_change_ttl_label': 'Token TTL (hours)',
  'admin.settings.email_change_require_password_label': 'Require current password',
  'admin.settings.email_change_from_config': 'Source: defaults',
  'admin.settings.email_change_from_setting': 'Source: runtime setting',

  // Admin settings — security_notifications card.
  'admin.settings.security_notifications_section': 'Security notifications',
  'admin.settings.security_notifications_intro':
    'Sends an email alert to the account when security-sensitive events occur (password change, MFA on/off, passkey add/remove, email change). Each kind can be toggled individually.',
  'admin.settings.security_notifications_kinds_label': 'Notify on',
  'admin.settings.security_notifications_from_config': 'Source: defaults',
  'admin.settings.security_notifications_from_setting': 'Source: runtime setting',
  'admin.settings.security_notifications_kind_password_changed': 'Password changed',
  'admin.settings.security_notifications_kind_mfa_enabled': 'MFA enabled',
  'admin.settings.security_notifications_kind_mfa_disabled': 'MFA disabled',
  'admin.settings.security_notifications_kind_passkey_added': 'Passkey added',
  'admin.settings.security_notifications_kind_passkey_removed': 'Passkey removed',
  'admin.settings.security_notifications_kind_email_changed': 'Email changed',

  // Admin settings — session_policy card.
  'admin.settings.session_policy_section': 'Session policy',
  'admin.settings.session_policy_intro':
    'Controls session lifetime and single-session enforcement. "Remember me" lets users opt into a longer session. Single session revokes all other active OIDC sessions on login. Idle timeout ends the account-console session after inactivity (OIDC tokens are unaffected).',
  'admin.settings.session_policy_from_config': 'Source: defaults',
  'admin.settings.session_policy_from_setting': 'Source: runtime setting',
  'admin.settings.session_policy_remember_enabled_label': 'Show "Keep me signed in" checkbox',
  'admin.settings.session_policy_remember_days_label': 'Remember-me duration (days)',
  'admin.settings.session_policy_remember_days_hint':
    'Duration of the persistent OIDC session when the checkbox is checked.',
  'admin.settings.session_policy_default_hours_label': 'Default session duration (hours)',
  'admin.settings.session_policy_default_hours_hint':
    'Max duration of a transient session (checkbox unchecked or disabled). Derived from config.ttl.session when not set.',
  'admin.settings.session_policy_single_session_label': 'Single active session per account',
  'admin.settings.session_policy_single_session_hint':
    'When enabled, signing in revokes all other active OIDC sessions for the account. Tokens issued in prior sessions become invalid.',
  'admin.settings.session_policy_idle_timeout_label':
    'Account-console idle timeout (minutes, 0 = off)',
  'admin.settings.session_policy_idle_timeout_hint':
    'Ends the account-console session after this many minutes of inactivity. Does not affect OIDC sessions or tokens.',
  'admin.settings.session_policy_idle_warn':
    'Idle timeout warning: idleTimeoutMinutes exceeds defaultSessionHours. The idle timeout will never trigger.',
  'admin.settings.session_policy_remember_days_warn':
    'Remember-me days exceeds 365. This is unusually long.',

  // Admin settings — section headers.
  'admin.settings.section_authentication': 'Authentication',
  'admin.settings.section_security': 'Security',
  'admin.settings.section_sessions': 'Sessions',
  'admin.settings.section_communications': 'Communications',
  'admin.settings.section_advanced': 'Advanced',

  // Admin settings — lockout card.
  'admin.settings.lockout_section': 'Account lockout',
  'admin.settings.lockout_intro':
    'Progressive account lockout (anti-brute-force keyed per email). Requires @adonisjs/limiter. Policy fields are now managed here; the `store` remains in the static config.',
  'admin.settings.lockout_from_config': 'Source: static config / defaults',
  'admin.settings.lockout_from_setting': 'Source: runtime setting',
  'admin.settings.lockout_max_attempts_label': 'Max attempts before lockout',
  'admin.settings.lockout_window_sec_label': 'Sliding window (seconds)',
  'admin.settings.lockout_base_lockout_sec_label': 'Base lockout duration (seconds)',
  'admin.settings.lockout_max_lockout_sec_label': 'Max lockout duration (seconds)',

  // Admin settings — rate_limit card.
  'admin.settings.rate_limit_section': 'Rate limit',
  'admin.settings.rate_limit_intro':
    'Rate-limit buckets for login/signup/forgot/reset (per IP) and PAT introspection. NOTE: the route throttle middleware uses boot-time values; this setting only affects lockout-side logic at runtime. Reconfigure and restart for full effect on the route middleware.',
  'admin.settings.rate_limit_from_config': 'Source: static config / defaults',
  'admin.settings.rate_limit_from_setting': 'Source: runtime setting',
  'admin.settings.rate_limit_login_points_label': 'Login bucket: requests allowed',
  'admin.settings.rate_limit_login_duration_label': 'Login bucket: window duration (e.g. "1 min")',
  'admin.settings.rate_limit_introspection_points_label': 'Introspection bucket: requests allowed',
  'admin.settings.rate_limit_introspection_duration_label': 'Introspection bucket: window duration',
  'admin.settings.rate_limit_limitation_note':
    'LIMITATION: route-level throttle middleware uses boot-time config. This setting affects lockout logic only at runtime.',

  // Admin settings — password_policy card.
  'admin.settings.password_policy_section': 'Password policy',
  'admin.settings.password_policy_intro':
    'Complexity requirements for new passwords. checkPwned checks passwords against HaveIBeenPwned (k-anonymity, fail-safe). Fields were previously in the store config; managing them here avoids redeploy.',
  'admin.settings.password_policy_from_config': 'Source: static config / defaults',
  'admin.settings.password_policy_from_setting': 'Source: runtime setting',
  'admin.settings.password_policy_min_length_label': 'Minimum length',
  'admin.settings.password_policy_require_uppercase_label': 'Require uppercase letter',
  'admin.settings.password_policy_require_lowercase_label': 'Require lowercase letter',
  'admin.settings.password_policy_require_numbers_label': 'Require number',
  'admin.settings.password_policy_require_symbols_label': 'Require symbol',
  'admin.settings.password_policy_check_pwned_label':
    'Check against HaveIBeenPwned (k-anonymity, fail-safe)',
  'admin.settings.password_policy_block_common_label':
    'Block common passwords (offline list of ~10 000 most-used passwords, case-insensitive)',

  // Admin settings — notifications card.
  'admin.settings.notifications_section': 'Login notifications',
  'admin.settings.notifications_intro':
    'Email alerts for new logins (new IP) and new device logins (no trusted-device cookie). Best-effort, fire-and-forget.',
  'admin.settings.notifications_from_config': 'Source: static config / defaults',
  'admin.settings.notifications_from_setting': 'Source: runtime setting',
  'admin.settings.notifications_new_login_label': 'Send new login alert (new IP)',
  'admin.settings.notifications_new_device_label': 'Send new device login alert',

  // Admin settings — trusted_devices card.
  'admin.settings.trusted_devices_section': 'Trusted devices (skip MFA)',
  'admin.settings.trusted_devices_intro':
    'When enabled, an encrypted cookie marks a device as trusted for N days after MFA verification. Step-up (acr_values) always bypasses this. Cookie name and secrets remain in the static config.',
  'admin.settings.trusted_devices_from_config': 'Source: static config / defaults',
  'admin.settings.trusted_devices_from_setting': 'Source: runtime setting',
  'admin.settings.trusted_devices_days_label': 'Trust duration (days)',

  // Admin settings — token_ttl card.
  'admin.settings.token_ttl_section': 'Token TTL',
  'admin.settings.token_ttl_intro':
    'Lifetime of OIDC tokens. Changes take effect immediately via a mutable holder (no redeploy needed). Session TTL is managed via Session policy. Seconds.',
  'admin.settings.token_ttl_from_config': 'Source: static config / defaults',
  'admin.settings.token_ttl_from_setting': 'Source: runtime setting',
  'admin.settings.token_ttl_access_token_label': 'Access token TTL (seconds)',
  'admin.settings.token_ttl_id_token_label': 'ID token TTL (seconds)',
  'admin.settings.token_ttl_refresh_token_label': 'Refresh token TTL (seconds)',

  // Admin settings — admin_impersonation card.
  'admin.settings.admin_impersonation_section': 'Admin impersonation',
  'admin.settings.admin_impersonation_intro':
    'Shows the impersonation panel (RFC 8693 token exchange) on the user page in the admin console. NOT a bypass of auth — the exchange requires an admin access token. Toggle without redeploy.',
  'admin.settings.admin_impersonation_from_config': 'Source: static config / defaults',
  'admin.settings.admin_impersonation_from_setting': 'Source: runtime setting',

  // Admin settings — organizations_policy card.
  'admin.settings.organizations_policy_section': 'Organizations policy',
  'admin.settings.organizations_policy_intro':
    'Runtime policy for multi-tenancy organizations. The `owner` role is always present (governance invariant). Whether organizations are enabled is determined by capability-probing (table presence) and the static config.',
  'admin.settings.organizations_policy_from_config': 'Source: static config / defaults',
  'admin.settings.organizations_policy_from_setting': 'Source: runtime setting',
  'admin.settings.organizations_policy_allow_self_create_label':
    'Allow users to self-create organizations',
  'admin.settings.organizations_policy_invitation_ttl_label': 'Invitation TTL (hours)',
  'admin.settings.organizations_policy_roles_label':
    'Available roles (comma-separated, owner always included)',

  // Console admin — roles catalog (admin/roles).
  'admin.roles.page_title': 'Roles catalog',
  'admin.roles.title': 'Roles catalog',
  'admin.roles.create_section': 'Create role',
  'admin.roles.create_intro':
    'Role names must be uppercase letters and underscores only (e.g. EDITOR, CONTENT_MANAGER). The ADMIN role is always present and cannot be removed.',
  'admin.roles.name_placeholder': 'ROLE_NAME',
  'admin.roles.name_pattern_hint':
    'Uppercase letters, digits and underscores only. Must start with a letter.',
  'admin.roles.description_placeholder': 'Description (optional)',
  'admin.roles.create_submit': 'Create role',
  'admin.roles.empty': 'No roles in the catalog.',
  'admin.roles.protected_badge': 'Protected',
  'admin.roles.save_description': 'Save',
  'admin.roles.delete': 'Remove',
  'admin.roles.delete_confirm':
    'Remove role {name} from the catalog? Users who have this role will keep it — it will just no longer appear in the catalog for new assignments.',
  'admin.roles.delete_note':
    'Removing a role from the catalog does NOT remove it from users who already have it. Use the user page to update individual user roles.',
  'admin.roles.created': 'Role created.',
  'admin.roles.updated': 'Role description updated.',
  'admin.roles.deleted': 'Role removed from catalog.',
  'admin.roles.name_invalid':
    'Invalid role name. Use uppercase letters, digits and underscores only, starting with a letter (e.g. EDITOR, CONTENT_MANAGER).',
  'admin.roles.name_taken': 'A role with this name already exists in the catalog.',
  'admin.roles.admin_protected':
    'The ADMIN role cannot be removed — it is the gate for the admin console.',
  'admin.roles.no_settings_table':
    'The `auth_settings` table is not present. The roles catalog requires runtime settings — create the table first.',
  'admin.roles.unknown_role':
    'One or more selected roles are not in the catalog. Manage the catalog at /admin/roles.',

  // Console admin — users: roles section (updated UI keys).
  'admin.users.roles_section': 'Global roles',
  'admin.users.out_of_catalog_label': 'Roles outside catalog:',
  'admin.users.out_of_catalog_badge': 'out of catalog',

  // Account expiration — login error.
  'errors.account_expired':
    'Your account has been deactivated due to inactivity. To reactivate it, reset your password.',

  // Admin settings — account_expiration card.
  'admin.settings.account_expiration_section': 'Account inactivity expiration',
  'admin.settings.account_expiration_intro':
    'Blocks login for accounts inactive for more than N days (measured by last successful login in the audit log). Requires a queryable audit sink (list capability). Reactivation: user resets their password. No new columns — "last activity" is read from audit.',
  'admin.settings.account_expiration_from_config': 'Source: defaults',
  'admin.settings.account_expiration_from_setting': 'Source: runtime setting',
  'admin.settings.account_expiration_inactive_days_label': 'Inactivity threshold (days)',
  'admin.settings.account_expiration_warn_days_label': 'Warn N days before expiry (0 = off)',
  'admin.settings.account_expiration_no_audit':
    'Queryable audit sink not available. Account expiration requires an audit sink that implements the `list` method (e.g. lucidAuditSink). Enable audit first.',

  // E-mail de aviso de expiração de conta iminente.
  'mail.account_expiration_warn.subject': 'Your account will be deactivated due to inactivity',
  'mail.account_expiration_warn.heading': 'Account inactivity notice',
  'mail.account_expiration_warn.intro':
    'Your account will be deactivated in {days} day(s) due to inactivity. Sign in to keep your account active.',
  'mail.account_expiration_warn.cta': 'Sign in now',
  'mail.account_expiration_warn.fallback':
    'If you no longer use this account, you can ignore this email.',
} satisfies AuthMessages;

/**
 * Catálogo embutido pt-BR. Espelha TODAS as chaves do default `en`. Ativado
 * com `i18n: { locale: 'pt-BR' }` sem nenhuma config extra de mensagens.
 */
export const PT_BR_MESSAGES = {
  // Comum / fallback de marca.
  'common.app_fallback': 'Auth',
  'common.brand_eyebrow': 'Auth',

  // Tela de login (interaction OIDC: identifier + password).
  'login.page_title': 'Entrar',
  'login.title': 'Entrar',
  'login.identifier_intro': 'Informe seu e-mail para continuar.',
  'login.email_label': 'E-mail',
  'login.identifier_submit': 'Continuar',
  'login.create_account': 'Criar conta',
  'login.forgot_password': 'Esqueci a senha',
  'login.divider_or': 'ou',
  'login.google': 'Entrar com Google',
  'login.greeting': 'Olá, {name}',
  'login.switch_account': 'Trocar de conta',
  'login.password_label': 'Senha',
  'login.submit': 'Entrar',
  // Remember-me (session_policy).
  'login.remember_me': 'Manter conectado',
  // Idle timeout redirect reason.
  'account.login.idle_timeout': 'Sua sessão expirou por inatividade. Por favor, entre novamente.',
  // Passwordless (login).
  'login.magic_link_button': 'Me envie um link de login',
  'login.magic_link_sent': 'Se a conta existir, enviamos um link de login.',
  'signup.magic_link_sent': 'Enviamos um link para o seu e-mail. Abra-o para concluir o cadastro.',
  'login.passkey_button': 'Entrar com passkey',
  // Login por OTP (código digitável).
  'login.otp_label': 'Digite o código de login do e-mail',
  'login.otp_placeholder': '000000',
  'login.otp_submit': 'Entrar com o código',
  'login.otp_invalid': 'Código inválido. Tente novamente.',
  'login.otp_expired': 'Este código expirou. Use o link de login ou peça um novo.',
  'login.otp_locked': 'Tentativas demais. O código foi desativado — use o link de login.',

  // Tela de cadastro (signup).
  'signup.page_title': 'Criar conta',
  'signup.title': 'Criar conta',
  'signup.intro': 'Preencha seus dados para começar.',
  'signup.name_label': 'Nome',
  'signup.email_label': 'E-mail',
  'signup.password_label': 'Senha',
  'signup.submit': 'Criar conta',
  'signup.have_account': 'Já tenho conta',

  // Recuperação de senha (forgot).
  'forgot.page_title': 'Recuperar senha',
  'forgot.sent_title': 'E-mail enviado',
  'forgot.sent_body': 'Se o e-mail existir, enviaremos instruções de redefinição.',
  'forgot.title': 'Recuperar senha',
  'forgot.intro': 'Enviaremos um link para redefinir sua senha.',
  'forgot.email_label': 'E-mail',
  'forgot.submit': 'Enviar link',

  // Redefinição de senha (reset).
  'reset.page_title': 'Redefinir senha',
  'reset.done_title': 'Senha redefinida',
  'reset.done_body': 'Você já pode entrar com a nova senha.',
  'reset.title': 'Nova senha',
  'reset.intro': 'Escolha uma nova senha para sua conta.',
  'reset.password_label': 'Senha',
  'reset.submit': 'Redefinir',

  // Verificação de e-mail (verify-email).
  'verify_email.page_title': 'Verificar e-mail',
  'verify_email.verified_title': 'E-mail verificado',
  'verify_email.verified_body': 'Seu e-mail foi confirmado com sucesso.',
  'verify_email.invalid_title': 'Link inválido',
  'verify_email.invalid_body': 'O link de verificação é inválido ou já foi utilizado.',

  // Desafio de MFA no fluxo de login (mfa-challenge).
  'mfa_challenge.page_title': 'Verificação em duas etapas',
  'mfa_challenge.title': 'Verificação em duas etapas',
  'mfa_challenge.intro': 'Abra seu app autenticador e informe o código de 6 dígitos.',
  'mfa_challenge.code_label': 'Código',
  'mfa_challenge.submit': 'Verificar',
  'mfa_challenge.recovery_summary': 'Usar um código de recuperação',
  'mfa_challenge.recovery_submit': 'Entrar com código de recuperação',
  'mfa_challenge.passkey_button': 'Usar passkey',
  'mfa_challenge.passkey_error': 'Não foi possível autenticar com a passkey. Tente novamente.',
  'mfa_challenge.trust_device': 'Confiar neste dispositivo por {days} dias',

  // Consent (autorização de cliente OIDC).
  'consent.page_title': 'Autorizar',
  'consent.title': 'Autorizar acesso',
  'consent.body': 'O app <strong>{app}</strong> quer acessar sua conta.',
  'consent.submit': 'Autorizar',

  // Console de conta — login (account/login).
  'account.login.page_title': 'Minha conta',
  'account.login.title': 'Minha conta',
  'account.login.intro': 'Gerencie seus tokens de acesso.',
  'account.login.email_label': 'E-mail',
  'account.login.password_label': 'Senha',
  'account.login.submit': 'Entrar',

  // Console de conta — tokens (account/tokens).
  'account.tokens.page_title': 'Tokens de acesso',
  'account.tokens.title': 'Tokens de acesso',
  'account.tokens.logout': 'Sair',
  'account.tokens.security': 'Segurança',
  'account.tokens.created_notice': 'Token criado — copie agora, não será mostrado de novo:',
  'account.tokens.name_placeholder': 'Nome do token (ex.: CI deploy)',
  'account.tokens.create': 'Criar',
  'account.tokens.empty': 'Nenhum token ainda.',
  'account.tokens.created_at': 'Criado em {date}',
  'account.tokens.last_used': '· último uso {date}',
  'account.tokens.never_used': '· nunca usado',
  'account.tokens.scopes': 'Escopos: {scopes}',
  'account.tokens.audience': 'Audiência: {audience}',
  'account.tokens.revoke': 'Revogar',

  // Console de conta — segurança (account/security): senha + e-mail.
  'account.security.page_title': 'Segurança da conta',
  'account.security.title': 'Segurança da conta',
  'account.security.logout': 'Sair',
  'account.security.current_email': 'E-mail atual: {email}',
  'account.security.not_supported':
    'A troca de senha e e-mail não está disponível nesta instalação.',
  'account.security.password_section': 'Trocar senha',
  'account.security.current_password_label': 'Senha atual',
  'account.security.new_password_label': 'Nova senha',
  'account.security.change_password_submit': 'Trocar senha',
  'account.security.password_changed': 'Senha alterada com sucesso.',
  'account.security.email_section': 'Trocar e-mail',
  'account.security.email_intro':
    'Enviaremos um link de confirmação para o novo endereço. A troca só é aplicada após a confirmação.',
  'account.security.new_email_label': 'Novo e-mail',
  'account.security.email_password_label': 'Senha atual',
  'account.security.change_email_submit': 'Solicitar troca de e-mail',
  'account.security.email_change_requested':
    'Enviamos um link de confirmação para {email}. Clique nele para concluir a troca.',
  'account.security.email_changed': 'E-mail alterado com sucesso.',
  'account.security.email_change_disabled': 'A troca de e-mail está desabilitada no momento.',
  'account.security.email_change_cancelled': 'Solicitação de troca de e-mail cancelada.',
  // Trusted devices (account/security).
  'account.security.trusted_devices_section': 'Dispositivos confiáveis',
  'account.security.trusted_devices_intro':
    'Você pode deixar de confiar neste navegador para que a verificação em duas etapas volte a ser exigida aqui. Para revogar a confiança em todos os dispositivos, refaça o cadastro do seu autenticador.',
  'account.security.trusted_devices_revoke': 'Deixar de confiar neste dispositivo',
  'account.security.trusted_devices_revoked':
    'Este dispositivo não é mais confiável. A verificação em duas etapas voltará a ser exigida aqui.',
  'account.security.sessions_section': 'Sessões ativas',
  'account.security.sessions_intro': 'Dispositivos e locais onde sua conta está logada agora.',
  'account.security.sessions_empty': 'Nenhuma sessão ativa.',

  // Console de conta — perfil (seção em account/security).
  'account.profile.section': 'Perfil',
  'account.profile.intro': 'Atualize seu nome de exibição e avatar.',
  'account.profile.name_label': 'Nome',
  'account.profile.avatar_label': 'URL do avatar',
  'account.profile.avatar_upload_label': 'Enviar avatar',
  'account.profile.avatar_upload_hint': 'JPG, PNG ou WebP, até 5MB.',
  'account.profile.avatar_invalid_type': 'Tipo de imagem inválido. Use JPG, PNG ou WebP.',
  'account.profile.avatar_too_large': 'A imagem é muito grande.',
  'account.profile.submit': 'Salvar perfil',
  'account.profile.updated': 'Perfil atualizado com sucesso.',
  'account.profile.not_supported': 'A edição de perfil não está disponível nesta instalação.',

  // Console de conta — exportar dados (portabilidade, LGPD/GDPR).
  'account.export.section': 'Exportar seus dados',
  'account.export.intro':
    'Baixe uma cópia dos seus dados: perfil, identidades vinculadas, apps autorizados, sessões ativas, passkeys e seu histórico de auditoria. Nenhum segredo ou token é incluído.',
  'account.export.submit': 'Baixar meus dados (JSON)',
  'account.export.requested':
    'Sua exportação de dados está sendo preparada e será entregue em breve.',

  // Console de conta — deletar conta (danger zone, LGPD/GDPR).
  'account.delete.section': 'Deletar conta',
  'account.delete.intro':
    'Apaga permanentemente sua conta e todos os dados associados: sessões, apps autorizados, tokens de acesso pessoal, passkeys, identidades vinculadas e segredos de duplo fator. Esta ação não pode ser desfeita.',
  'account.delete.confirm_password_label': 'Confirme com sua senha atual',
  'account.delete.confirm_email_label': 'Digite seu e-mail para confirmar',
  'account.delete.submit': 'Deletar minha conta',
  'account.delete.deleted': 'Sua conta foi deletada permanentemente.',
  'account.delete.invalid_confirmation': 'Confirmação falhou. Sua conta NÃO foi deletada.',
  'account.delete.not_supported': 'A deleção de conta não está disponível nesta instalação.',

  // Console de conta — apps com acesso (account/apps).
  'account.apps.page_title': 'Apps com acesso',
  'account.apps.title': 'Apps com acesso',
  'account.apps.intro': 'Apps que você autorizou a acessar sua conta.',
  'account.apps.logout': 'Sair',
  'account.apps.empty': 'Nenhum app tem acesso à sua conta.',
  'account.apps.tokens': '{accessTokens} access · {refreshTokens} refresh',
  'account.apps.revoke': 'Revogar acesso',
  'account.apps.revoke_confirm':
    'Revogar o acesso deste app? Ele precisará ser autorizado novamente e seus tokens deixarão de funcionar.',
  'account.apps.revoked': 'Acesso revogado.',
  'account.apps.not_supported':
    'O adapter OIDC configurado não suporta enumeração — a listagem de apps fica indisponível.',

  // Console de conta — organizations (account/orgs).
  'account.orgs.page_title': 'Minhas Organizações',
  'account.orgs.title': 'Minhas Organizações',
  'account.orgs.logout': 'Sair',
  'account.orgs.empty': 'Você não é membro de nenhuma organização.',
  'account.orgs.active_badge': 'Ativa',
  'account.orgs.activate': 'Definir como ativa',
  'account.orgs.deactivate': 'Desativar',
  'account.orgs.leave': 'Sair',
  'account.orgs.leave_last_owner': 'Não é possível sair — você é o único proprietário.',
  'account.orgs.create_section': 'Criar organização',
  'account.orgs.create_name_label': 'Nome',
  'account.orgs.create_slug_label': 'Slug (identificador de URL)',
  'account.orgs.create_submit': 'Criar organização',
  'account.orgs.created': 'Organização criada.',
  'account.orgs.activated': 'Organização ativada.',
  'account.orgs.deactivated': 'Organização desativada.',
  'account.orgs.left': 'Você saiu da organização.',
  'account.orgs.not_supported': 'Organizations não está disponível nesta instalação.',
  'account.orgs.not_member': 'Você não é membro desta organização.',
  'account.orgs.invitations_section': 'Convites pendentes',
  'account.orgs.invitations_empty': 'Nenhum convite pendente.',
  'account.orgs.invitation_from': 'Convidado para {orgName} como {role}',
  'account.orgs.invitation_accept': 'Aceitar',
  'account.orgs.invitation_accepted': 'Convite aceito.',
  'account.orgs.invitation_error': 'Não foi possível aceitar o convite.',
  'account.orgs.members_section': 'Membros',
  'account.orgs.invite_section': 'Convidar por e-mail',
  'account.orgs.invite_email_label': 'E-mail',
  'account.orgs.invite_role_label': 'Papel',
  'account.orgs.invite_submit': 'Enviar convite',
  'account.orgs.invited': 'Convite enviado.',
  'account.orgs.remove_member': 'Remover',
  'account.orgs.member_removed': 'Membro removido.',
  'account.orgs.change_role': 'Alterar papel',
  'account.orgs.role_updated': 'Papel atualizado.',

  // Confirmação de troca de e-mail (account/email-confirmed).
  'account.email_confirmed.page_title': 'Confirmação de e-mail',
  'account.email_confirmed.ok_title': 'E-mail alterado',
  'account.email_confirmed.ok_body': 'Seu novo e-mail foi confirmado e já está ativo.',
  'account.email_confirmed.invalid_title': 'Link inválido',
  'account.email_confirmed.invalid_body': 'O link de confirmação é inválido ou já foi utilizado.',

  // Console de conta — MFA (account/mfa).
  'account.mfa.page_title': 'Verificação em duas etapas',
  'account.mfa.title': 'Verificação em duas etapas',
  'account.mfa.logout': 'Sair',
  'account.mfa.recovery_codes_notice':
    'Guarde seus códigos de recuperação — eles não serão mostrados de novo:',
  'account.mfa.enroll_intro':
    'Escaneie o QR code com seu app autenticador (Google Authenticator, 1Password, etc.).',
  'account.mfa.qr_alt': 'QR code TOTP',
  'account.mfa.manual_intro': 'Ou informe manualmente:',
  'account.mfa.confirm_code_label': 'Código de confirmação',
  'account.mfa.activate': 'Ativar verificação em duas etapas',
  'account.mfa.enabled_html':
    'A verificação em duas etapas está <span class="font-semibold text-emerald-700">ativa</span> nesta conta.',
  'account.mfa.disable': 'Desativar',
  'account.mfa.disabled_intro':
    'A verificação em duas etapas está desativada. Ative-a para proteger sua conta com um app autenticador.',
  'account.mfa.enable': 'Ativar verificação em duas etapas',

  // Console de conta — passkeys (WebAuthn) na tela de MFA.
  'mfa.passkey.section_title': 'Passkeys (chaves de acesso)',
  'mfa.passkey.section_intro':
    'Use uma chave de acesso (biometria, PIN do dispositivo ou chave de segurança) como segundo fator, sem precisar digitar códigos.',
  'mfa.passkey.add': 'Adicionar passkey',
  'mfa.passkey.remove': 'Remover',
  'mfa.passkey.empty': 'Nenhuma passkey registrada.',
  'mfa.passkey.unnamed': 'Passkey',
  'mfa.passkey.created_at': 'Criada em {date}',
  'mfa.passkey.register_error': 'Não foi possível registrar a passkey. Tente novamente.',
  'mfa.passkey.unsupported': 'Seu navegador não suporta passkeys.',

  // Console admin (B6) — navegação compartilhada.
  'admin.nav.roles': 'Roles',
  'admin.nav.dashboard': 'Painel',
  'admin.nav.users': 'Usuários',
  'admin.nav.orgs': 'Organizações',
  'admin.nav.clients': 'Clients',
  'admin.nav.audit': 'Auditoria',
  'admin.nav.settings': 'Configurações',
  'admin.nav.logout': 'Sair',

  // Console admin — dashboard.
  'admin.dashboard.page_title': 'Painel admin',
  'admin.dashboard.title': 'Painel administrativo',
  'admin.dashboard.users_count': 'Usuários',
  'admin.dashboard.clients_count': 'Clients',
  'admin.dashboard.audit_count': 'Eventos de auditoria',
  'admin.dashboard.recent_title': 'Eventos recentes',
  'admin.dashboard.mau': 'Usuários ativos (30d)',
  'admin.dashboard.active_sessions': 'Sessões ativas',
  'admin.dashboard.signins_title': 'Logins (últimos {days}d)',
  'admin.dashboard.signups_title': 'Cadastros (últimos {days}d)',

  // Console admin — usuários.
  'admin.users.page_title': 'Usuários',
  'admin.users.title': 'Usuários',
  'admin.users.search_placeholder': 'Buscar por e-mail',
  'admin.users.search': 'Buscar',
  'admin.users.empty': 'Nenhum usuário encontrado.',
  'admin.users.roles_placeholder': 'Papéis (separados por vírgula)',
  'admin.users.save_roles': 'Salvar papéis',
  'admin.users.sessions': 'Sessões',
  'admin.users.create_section': 'Criar usuário',
  'admin.users.create_name_placeholder': 'Nome (opcional)',
  'admin.users.create_email_placeholder': 'E-mail',
  'admin.users.create_password_placeholder': 'Senha (deixe em branco para enviar convite)',
  'admin.users.create_submit': 'Criar usuário',
  'admin.users.created': 'Usuário criado.',
  'admin.users.reset_password': 'Enviar redefinição de senha',
  'admin.users.reset_sent': 'E-mail de redefinição de senha enviado.',
  'admin.users.disable': 'Desabilitar',
  'admin.users.enable': 'Reabilitar',
  'admin.users.disabled': 'Conta desabilitada.',
  'admin.users.enabled': 'Conta reabilitada.',
  'admin.users.deleted': 'Conta deletada permanentemente.',
  'admin.users.delete_unsupported': 'O store de contas não suporta deletar usuários.',
  'admin.users.delete': 'Deletar',
  'admin.users.delete_confirm':
    'Deletar permanentemente esta conta e todos os dados? Não pode ser desfeito.',
  'admin.users.disabled_badge': 'Desabilitada',
  'admin.users.disable_confirm': 'Desabilitar esta conta? O usuário não conseguirá entrar.',

  // Console admin — organizations (pt-BR).
  'admin.orgs.page_title': 'Organizações',
  'admin.orgs.title': 'Organizações',
  'admin.orgs.detail_title': 'Organização',
  'admin.orgs.not_supported': 'Organizações não estão disponíveis nesta instalação.',
  'admin.orgs.empty': 'Nenhuma organização encontrada.',
  'admin.orgs.create_section': 'Criar organização',
  'admin.orgs.create_name_placeholder': 'Nome',
  'admin.orgs.create_slug_placeholder': 'Slug (identificador na URL)',
  'admin.orgs.create_submit': 'Criar organização',
  'admin.orgs.created': 'Organização criada.',
  'admin.orgs.deleted': 'Organização deletada.',
  'admin.orgs.slug_taken': 'Já existe uma organização com este slug.',
  'admin.orgs.invalid_input': 'Nome, slug e conta owner são obrigatórios.',
  'admin.orgs.view': 'Ver',
  'admin.orgs.delete': 'Deletar',
  'admin.orgs.delete_confirm':
    'Deletar permanentemente esta organização e todos os membros/convites? Não pode ser desfeito.',
  'admin.orgs.back': 'Voltar para organizações',
  'admin.orgs.members_section': 'Membros',
  'admin.orgs.members_count': 'membros',
  'admin.orgs.members_empty': 'Nenhum membro.',
  'admin.orgs.add_member_section': 'Adicionar membro',
  'admin.orgs.select_account': '— Selecione a conta —',
  'admin.orgs.add_member_submit': 'Adicionar membro',
  'admin.orgs.member_added': 'Membro adicionado.',
  'admin.orgs.member_removed': 'Membro removido.',
  'admin.orgs.member_add_error': 'Não foi possível adicionar o membro.',
  'admin.orgs.member_remove_error': 'Não foi possível remover o membro.',
  'admin.orgs.member_remove_confirm': 'Remover este membro?',
  'admin.orgs.remove_member': 'Remover',
  'admin.orgs.last_owner': 'Não é possível remover o último owner.',
  'admin.orgs.invitations_section': 'Convites pendentes',
  'admin.orgs.expires': 'Expira',
  'admin.orgs.revoke_invitation': 'Revogar',
  'admin.orgs.invitation_revoked': 'Convite revogado.',
  'admin.orgs.danger_zone': 'Zona de perigo',

  // Console admin — sessões/grants ativos de uma conta.
  'admin.sessions.page_title': 'Sessões ativas',
  'admin.sessions.title': 'Sessões ativas',
  'admin.sessions.account': 'Conta: {email}',
  'admin.sessions.back': 'Voltar para usuários',
  'admin.sessions.not_supported':
    'O adapter OIDC configurado não suporta enumeração — a inspeção de sessões fica indisponível.',
  'admin.sessions.revoked_notice':
    'Revogado: {sessions} sessão(ões), {grants} grant(s), {accessTokens} access token(s), {refreshTokens} refresh token(s).',
  'admin.sessions.sessions_section': 'Sessões (login no IdP)',
  'admin.sessions.sessions_empty': 'Nenhuma sessão ativa.',
  'admin.sessions.session_login_ts': 'Login: {date}',
  'admin.sessions.session_amr': 'Métodos: {amr}',
  'admin.sessions.session_device': '{browser} em {os}',
  'admin.sessions.session_ip': 'IP: {ip}',
  'admin.sessions.session_ip_geo': 'IP: {ip} · {location}',
  'admin.sessions.grants_section': 'Grants (autorizações por client)',
  'admin.sessions.grants_empty': 'Nenhum grant ativo.',
  'admin.sessions.grant_client': 'Client: {clientId}',
  'admin.sessions.grant_tokens': '{accessTokens} access · {refreshTokens} refresh',
  'admin.sessions.revoke_all': 'Revogar todas as sessões e grants',
  'admin.sessions.revoke_confirm':
    'Revogar todas as sessões e grants desta conta? O usuário precisará entrar novamente e os tokens emitidos deixarão de funcionar.',

  // Console admin — impersonation (RFC 8693 token exchange).
  'admin.impersonation.title': 'Personificar este usuário',
  'admin.impersonation.help':
    'O Token Exchange (RFC 8693) permite que um admin aja como este usuário. Não há bypass de auth: você troca o SEU PRÓPRIO access token de admin por um escopado ao alvo.',
  'admin.impersonation.curl_label': 'Requisição pronta para rodar',
  'admin.impersonation.note':
    'Troque <ADMIN_ACCESS_TOKEN> por um access token de admin válido. O id_token resultante carrega act={sub: admin}; o evento é auditado como impersonation.started.',
  'admin.impersonation.no_client':
    'Nenhum client tem o grant token-exchange habilitado. Adicione "urn:ietf:params:oauth:grant-type:token-exchange" a um client para habilitar a personificação.',

  // Console admin — clients.
  'admin.clients.page_title': 'Clients OAuth',
  'admin.clients.title': 'Clients OAuth',
  'admin.clients.empty': 'Nenhum client configurado.',
  'admin.clients.confidential': 'Confidencial',
  'admin.clients.public': 'Público',
  'admin.clients.grants': 'Grants: {grants}',
  'admin.clients.redirect_uris': 'Redirects: {uris}',
  'admin.clients.dynamic_notice':
    'O registro dinâmico de clients (RFC 7591) está ligado — clients registrados via /reg são persistidos no adapter e aparecem na seção dinâmica abaixo.',
  'admin.clients.static_section': 'Clients estáticos (config)',
  'admin.clients.dynamic_section': 'Clients dinâmicos (adapter)',
  'admin.clients.dynamic_empty': 'Nenhum client dinâmico persistido.',
  'admin.clients.dynamic_not_supported':
    'O adapter OIDC configurado não suporta enumeração de clients — a gestão dinâmica fica indisponível.',
  'admin.clients.new': 'Novo client',
  'admin.clients.new_title': 'Novo client OIDC',
  'admin.clients.edit_title': 'Editar client OIDC',
  'admin.clients.edit': 'Editar',
  'admin.clients.delete': 'Excluir',
  'admin.clients.delete_confirm': 'Excluir este client? Esta ação não pode ser desfeita.',
  'admin.clients.regenerate_secret': 'Regenerar secret',
  'admin.clients.regenerate_confirm':
    'Regenerar o secret? O secret atual deixará de funcionar imediatamente.',
  'admin.clients.back': 'Voltar',
  'admin.clients.cancel': 'Cancelar',
  'admin.clients.save': 'Salvar',
  'admin.clients.create': 'Criar client',
  'admin.clients.secret_once_title': 'Guarde o client_secret agora',
  'admin.clients.secret_once_notice':
    'Este é o único momento em que o secret é exibido. Copie-o agora — ele não pode ser recuperado depois.',
  'admin.clients.field_client_id': 'Client ID',
  'admin.clients.field_client_id_placeholder': 'deixe em branco para gerar automaticamente',
  'admin.clients.field_client_id_help':
    'Opcional. Se vazio, um identificador aleatório será gerado.',
  'admin.clients.field_redirect_uris': 'Redirect URIs',
  'admin.clients.field_redirect_uris_help': 'Uma URI por linha.',
  'admin.clients.field_post_logout_uris': 'Post-logout redirect URIs',
  'admin.clients.field_post_logout_uris_help': 'Uma URI por linha (opcional).',
  'admin.clients.field_grant_types': 'Grant types',
  'admin.clients.field_auth_method': 'Token endpoint auth method',
  'admin.clients.field_backchannel_uri': 'Back-Channel Logout URI (opcional)',
  'admin.clients.field_backchannel_uri_help':
    'Endpoint de OIDC Back-Channel Logout do RP. Deixe em branco se não usar.',
  'admin.clients.field_backchannel_session_required': 'Exigir sid no logout_token',
  'admin.clients.field_backchannel_session_required_help':
    'Quando marcado, o IdP inclui o session ID (sid) em cada logout_token enviado a este client.',
  'admin.clients.static_deprecated_notice':
    'Estes clients estão definidos estaticamente no config e estão depreciados. ' +
    'Migre-os para o adapter/DB com:',

  // Console admin — auditoria.
  'admin.audit.page_title': 'Auditoria',
  'admin.audit.title': 'Log de auditoria',
  'admin.audit.type_placeholder': 'Filtrar por tipo',
  'admin.audit.subject_placeholder': 'Filtrar por subject (accountId)',
  'admin.audit.filter': 'Filtrar',
  'admin.audit.empty': 'Nenhum evento encontrado.',
  'admin.audit.not_supported': 'O sink de auditoria configurado não suporta consulta.',

  // Console admin — settings (runtime configuration) — pt-BR.
  'admin.settings.page_title': 'Configurações',
  'admin.settings.title': 'Configurações',
  'admin.settings.bot_protection_section': 'Bot protection',
  'admin.settings.bot_protection_intro':
    'Sobrescreva a config estática em tempo de execução. A função `verify` sempre vem do config — aqui só é possível ligar/desligar e escolher as ações afetadas.',
  'admin.settings.bot_protection_no_verify':
    'Bot protection não está configurado — adicione `botProtection.verify` ao config/authkit.ts para habilitar esta feature.',
  'admin.settings.no_settings_table':
    'A tabela `auth_settings` não existe. Para habilitar configurações em runtime, crie-a: `key TEXT PK, value TEXT NOT NULL, updated_at TIMESTAMP, updated_by TEXT`.',
  'admin.settings.enabled_label': 'Habilitado',
  'admin.settings.actions_label': 'Ativo em',
  'admin.settings.action_login': 'Login',
  'admin.settings.action_signup': 'Cadastro',
  'admin.settings.action_reset': 'Redefinição de senha',
  'admin.settings.save': 'Salvar',
  'admin.settings.saved': 'Configurações salvas.',
  'admin.settings.reset_to_config': 'Resetar ao config',
  'admin.settings.reset_done':
    'Setting em runtime apagado — o config estático voltou a ser a fonte de verdade.',
  // Cadastro aberto.
  'admin.settings.registration_section': 'Cadastro aberto',
  'admin.settings.registration_intro':
    'Controla se novos usuários podem se auto-registrar (cadastro público). Contas criadas pelo admin e convites de organização não são afetados.',
  'admin.settings.registration_from_config': 'Fonte: config estático',
  'admin.settings.registration_from_setting': 'Fonte: setting em runtime',
  // Exigir e-mail verificado.
  'admin.settings.require_verified_email_section': 'Exigir e-mail verificado',
  'admin.settings.require_verified_email_intro':
    'Quando ativo, o login é bloqueado para contas com e-mail não verificado (aplica-se a senha, magic link e passkey-first). Sobrescreve o `login.requireVerifiedEmail` do config estático.',
  'admin.settings.require_verified_email_config_note':
    'Nota: sobrescreve `login.requireVerifiedEmail` em config/authkit.ts em tempo de execução.',
  'admin.settings.require_verified_email_from_config': 'Fonte: config estático',
  'admin.settings.require_verified_email_from_setting': 'Fonte: setting em runtime',
  // Modo de manutenção.
  'admin.settings.maintenance_section': 'Modo de manutenção',
  'admin.settings.maintenance_intro':
    'Quando ativo, as telas de login/cadastro/esqueci-senha/interaction exibem uma página de manutenção e rejeitam POSTs. Tokens OIDC existentes (refresh, userinfo, introspection) continuam funcionando. A Admin API e o console admin permanecem acessíveis.',
  'admin.settings.maintenance_message_label': 'Mensagem personalizada (opcional)',
  'admin.settings.maintenance_message_placeholder':
    'Estamos em manutenção programada. Por favor, tente novamente em breve.',
  'admin.settings.maintenance_warning':
    'ATENÇÃO — BLOQUEIO: Se você ativar o modo de manutenção e perder acesso à Admin API, não conseguirá desativá-lo remotamente. Contas com role admin ainda podem entrar — mas se você ficar bloqueado, use a Admin REST API (PUT /api/authkit/v1/settings/maintenance_mode com {"value":{"enabled":false}}) para desativar sem login no browser.',
  'admin.settings.maintenance_from_setting': 'Fonte: setting em runtime',

  // Auth methods setting card (console admin).
  'admin.settings.auth_methods_section': 'Métodos de autenticação',
  'admin.settings.auth_methods_intro':
    'Controla quais métodos de login a tela oferece em tempo de execução. Desativar todos ativa um fail-safe que restaura os defaults do config.',
  'admin.settings.auth_methods_from_config': 'Fonte: config estático',
  'admin.settings.auth_methods_from_setting': 'Fonte: setting em runtime',
  'admin.settings.auth_methods_password_label': 'Senha',
  'admin.settings.auth_methods_magic_link_label': 'Magic link (link de login por e-mail)',
  'admin.settings.auth_methods_passkey_label': 'Passkey (sem senha)',
  'admin.settings.auth_methods_forgot_password_label': 'Link "Esqueci minha senha"',
  'admin.settings.auth_methods_social_section': 'Providers sociais',
  'admin.settings.auth_methods_social_intro':
    'Apenas providers configurados no código podem ser habilitados aqui.',
  'admin.settings.auth_methods_magic_link_unavailable':
    'Indisponível — requer mail e `passwordless.magicLink` no config.',
  'admin.settings.auth_methods_passkey_unavailable':
    'Indisponível — requer WebAuthn configurado no config.',
  'admin.settings.auth_methods_forgot_disabled_hint':
    'Desabilitado automaticamente quando o método senha está desligado.',
  'admin.settings.auth_methods_no_social': 'Nenhum provider social configurado no config estático.',
  'admin.settings.auth_methods_passkey_autofill_label':
    'Habilitar autofill de passkey (conditional mediation — sugere passkeys no campo de e-mail)',

  // Rótulo genérico de provider social (fallback quando não há tradução específica).
  'login.social_provider': 'Entrar com {provider}',

  // Console admin — paginação compartilhada.
  'admin.pagination.page': 'Página {page} de {total}',
  'admin.pagination.prev': 'Anterior',
  'admin.pagination.next': 'Próxima',

  // Device Authorization Grant (RFC 8628) — telas servidas pelo oidc-provider.
  'device.input.title': 'Entrar no dispositivo',
  'device.input.intro': 'Digite o código exibido no seu dispositivo.',
  'device.input.submit': 'Continuar',
  'device.input.error_invalid': 'O código informado está incorreto. Tente novamente.',
  'device.input.error_aborted': 'A solicitação de login foi interrompida.',
  'device.input.error_generic': 'Ocorreu um erro ao processar sua solicitação.',
  'device.confirm.title': 'Confirmar dispositivo',
  'device.confirm.body':
    'O código abaixo deve estar sendo exibido no seu dispositivo. Confirme apenas se reconhecê-lo.',
  'device.confirm.submit': 'Continuar',
  'device.confirm.abort': 'Cancelar',
  'device.success.title': 'Login concluído',
  'device.success.body': 'Login realizado com sucesso. Você já pode voltar ao dispositivo.',

  // RP-initiated logout (end_session) — splash de saída e tela de sucesso.
  'logout.title': 'Saindo',
  'logout.body': 'Encerrando sua sessão…',
  'logout.fallback': 'Sair',
  'logout.success.title': 'Sessão encerrada',
  'logout.success.body': 'Você saiu da sua conta. Até breve.',

  // Step-up auth (acr_values): cliente exige MFA mas a conta não tem MFA enrolado.
  'mfa_challenge.required_no_enrollment':
    'Este cliente exige verificação em duas etapas. Configure o MFA no console da sua conta para continuar.',

  // Mensagens de erro/flash produzidas pelos controllers.
  'errors.invalid_credentials': 'Credenciais inválidas',
  'errors.invalid_code': 'Código inválido',
  'errors.account_disabled': 'Esta conta foi desabilitada.',
  'errors.email_unverified':
    'Verifique seu e-mail antes de entrar. Procure o link de verificação na sua caixa de entrada.',
  'errors.email_taken': 'E-mail já cadastrado',
  'errors.signup_failed': 'Não foi possível criar a conta',
  'errors.invalid_or_expired_token': 'Token inválido ou expirado',
  'errors.account_locked':
    'Conta temporariamente bloqueada por excesso de tentativas. Tente novamente em {seconds}s.',
  'errors.otp_locked':
    'A verificação em duas etapas foi bloqueada por excesso de tentativas incorretas. Um link de recuperação foi enviado para o seu e-mail.',
  'errors.bot_protection_failed': 'A verificação anti-bot falhou. Tente novamente.',
  'errors.session_expired': 'Sessão expirada',
  'errors.challenge_expired': 'Desafio expirado',
  'errors.passkeys_unavailable': 'Passkeys indisponíveis',
  'errors.no_passkey_registered': 'Nenhuma passkey registrada',
  'errors.registration_disabled':
    'O cadastro está desabilitado no momento. Entre em contato com o administrador para obter acesso.',
  'errors.not_found': 'Não encontrado.',

  // Manutenção do sistema.
  'maintenance.title': 'Em manutenção',
  'maintenance.default_message':
    'O serviço está temporariamente indisponível para manutenção. Tente novamente em breve.',
  'maintenance.admin_login_note':
    'Se você é administrador, ainda pode entrar para gerenciar o sistema.',

  // Sessão de login (interaction OIDC) expirada/perdida — recuperação graciosa.
  'session_expired.page_title': 'Sessão expirada',
  'session_expired.title': 'Sua sessão expirou',
  'session_expired.body':
    'Sua sessão de login expirou ou não foi encontrada. Isso pode acontecer se a página ficou aberta por muito tempo. Recomece o login.',
  'session_expired.login_link': 'Voltar ao login',

  // Tela amigável de throttle (429) nas rotas de browser — ver `withFriendly429`.
  'throttled.page_title': 'Muitas tentativas',
  'throttled.title': 'Muitas tentativas',
  'throttled.body_seconds': 'Você fez tentativas demais. Aguarde {seconds} segundos e tente de novo.',
  'throttled.body': 'Você fez tentativas demais. Aguarde um instante e tente de novo.',
  'throttled.retry_link': 'Voltar e tentar de novo',

  // Política de senha (validação ao definir uma senha nova) + vazamento (HIBP) + histórico + expiração.
  'password.policy.min_length': 'A senha deve ter no mínimo {min} caracteres.',
  'password.policy.uppercase': 'A senha deve conter ao menos uma letra maiúscula.',
  'password.policy.lowercase': 'A senha deve conter ao menos uma letra minúscula.',
  'password.policy.numbers': 'A senha deve conter ao menos um número.',
  'password.policy.symbols': 'A senha deve conter ao menos um símbolo.',
  'password.pwned':
    'Esta senha apareceu em vazamentos de dados conhecidos. Escolha uma senha diferente.',
  'password.common': 'Esta senha é muito comum. Escolha uma senha mais única.',
  'password.reused':
    'Esta senha foi usada recentemente. Escolha uma senha diferente (as últimas {count} senhas são lembradas).',
  // Step de troca obrigatória (expiração de senha).
  'login.password_expired_title': 'Senha expirada',
  'login.password_expired_intro': 'Sua senha expirou. Defina uma nova senha para continuar.',
  'login.password_expired_new_label': 'Nova senha',
  'login.password_expired_submit': 'Definir nova senha',
  // Banner de graça de verificação de e-mail.
  'login.email_grace_banner': 'Verifique seu e-mail. Você tem {days} dia(s) restante(s).',
  // Admin settings — password hygiene cards (pt-BR).
  'admin.settings.password_history_section': 'Histórico de senhas',
  'admin.settings.password_history_intro':
    'Impede reutilização de senhas recentes. Requer a tabela `auth_password_history`. Quando habilitado, os últimos N hashes de senha são armazenados e verificados em cada troca.',
  'admin.settings.password_history_count_label': 'Senhas lembradas',
  'admin.settings.password_history_from_config': 'Fonte: padrão',
  'admin.settings.password_history_from_setting': 'Fonte: setting em runtime',
  'admin.settings.password_history_no_table':
    'A tabela `auth_password_history` não existe. Crie-a para habilitar este recurso: `id UUID/SERIAL PK, account_id TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TIMESTAMP NOT NULL`.',
  'admin.settings.password_expiration_section': 'Expiração de senha',
  'admin.settings.password_expiration_intro':
    'Força os usuários a trocar a senha após um número de dias. Requer a coluna `password_changed_at` na tabela de usuários.',
  'admin.settings.password_expiration_max_age_label': 'Dias máximos sem troca',
  'admin.settings.password_expiration_from_config': 'Fonte: padrão',
  'admin.settings.password_expiration_from_setting': 'Fonte: setting em runtime',
  'admin.settings.password_expiration_no_column':
    'A coluna `password_changed_at` não existe na tabela de usuários. Adicione-a (TIMESTAMP NULL) para habilitar este recurso.',

  // Assuntos/corpos de e-mail transacional (default_mailer).
  'mail.common.link_fallback': 'Se o botão não funcionar, copie e cole este link no navegador:',

  'mail.reset.subject': 'Redefinição de senha',
  'mail.reset.heading': 'Redefinição de senha',
  'mail.reset.intro': 'Recebemos um pedido para redefinir a senha da sua conta.',
  'mail.reset.cta': 'Redefinir senha',
  'mail.reset.fallback': 'Se você não solicitou isso, pode ignorar este e-mail.',
  'mail.reset.expires': 'Este link expira em {minutes} minutos.',

  'mail.verify.subject': 'Verifique seu e-mail',
  'mail.verify.heading': 'Verifique seu e-mail',
  'mail.verify.intro': 'Confirme seu endereço de e-mail para concluir a configuração da conta.',
  'mail.verify.cta': 'Verificar e-mail',
  'mail.verify.fallback': 'Se você não criou esta conta, pode ignorar este e-mail.',
  'mail.verify.expires': 'Este link expira em {minutes} minutos.',

  'mail.magic_link.subject': 'Seu link de login',
  'mail.magic_link.heading': 'Entrar na sua conta',
  'mail.magic_link.intro':
    'Clique no botão abaixo para entrar. O link expira em breve e pode ser usado uma vez.',
  'mail.magic_link.cta': 'Entrar',
  'mail.magic_link.fallback': 'Se você não solicitou isso, pode ignorar este e-mail.',
  'mail.magic_link.code_label': 'Ou digite este código para entrar:',
  // E-mail "só código" (login choose-first com channel: 'code'): sem botão/link.
  'mail.magic_link.code_subject': 'Seu código de login',
  'mail.magic_link.code_intro':
    'Use o código abaixo para entrar. Ele expira em instantes e serve para um único acesso.',
  'mail.magic_link.code_only_label': 'Digite este código para entrar:',

  'mail.new_login.subject': 'Novo login na sua conta',
  'mail.new_login.heading': 'Novo login detectado',
  'mail.new_login.intro': 'Detectamos um novo login na sua conta.',
  'mail.new_login.when': 'Quando: {date}',
  'mail.new_login.ip': 'Endereço IP: {ip}',
  'mail.new_login.device': 'Dispositivo: {device}',
  'mail.new_login.fallback':
    'Se foi você, nenhuma ação é necessária. Caso contrário, redefina sua senha imediatamente.',

  'mail.email_change.subject': 'Confirme seu novo e-mail',
  'mail.email_change.heading': 'Confirme seu novo e-mail',
  'mail.email_change.intro':
    'Recebemos um pedido para trocar o e-mail da sua conta. Confirme o novo endereço abaixo.',
  'mail.email_change.cta': 'Confirmar novo e-mail',
  'mail.email_change.fallback': 'Se você não solicitou isso, pode ignorar este e-mail.',
  'mail.email_change.expires': 'Este link expira em {minutes} minutos.',

  // E-mail de aviso ao endereço ATUAL quando troca de e-mail é solicitada.
  'mail.email_change_notice.subject': 'Solicitação de troca de e-mail',
  'mail.email_change_notice.heading': 'Solicitação de troca de e-mail',
  'mail.email_change_notice.intro':
    'Foi feita uma solicitação para trocar o e-mail da sua conta para {newEmail}. Um link de confirmação foi enviado para o novo endereço.',
  'mail.email_change_notice.cta': 'Verificar segurança da conta',
  'mail.email_change_notice.fallback':
    'Se não foi você, sua conta pode estar comprometida — troque sua senha imediatamente.',

  // E-mail de confirmação ao endereço ANTIGO após troca concluída.
  'mail.email_changed_completed.subject': 'Seu e-mail foi alterado',
  'mail.email_changed_completed.heading': 'E-mail alterado',
  'mail.email_changed_completed.intro':
    'O e-mail da sua conta foi alterado de {oldEmail} para {newEmail}.',
  'mail.email_changed_completed.cta': 'Verificar segurança da conta',
  'mail.email_changed_completed.fallback':
    'Se não foi você, entre em contato com o suporte imediatamente.',

  // E-mails de notificação de segurança (senha alterada, MFA, passkey, e-mail).
  'mail.security_notice.subject': 'Alerta de segurança: {kind}',
  'mail.security_notice.heading': 'Alerta de segurança',
  'mail.security_notice.intro': 'Um evento de segurança ocorreu na sua conta: {kind}.',
  'mail.security_notice.when': 'Quando: {date}',
  'mail.security_notice.ip': 'Endereço IP: {ip}',
  'mail.security_notice.fallback':
    'Se foi você, nenhuma ação é necessária. Caso contrário, proteja sua conta imediatamente.',
  'mail.security_notice.kind_password_changed': 'senha alterada',
  'mail.security_notice.kind_mfa_enabled': 'verificação em duas etapas habilitada',
  'mail.security_notice.kind_mfa_disabled': 'verificação em duas etapas desabilitada',
  'mail.security_notice.kind_passkey_added': 'passkey adicionada',
  'mail.security_notice.kind_passkey_removed': 'passkey removida',
  'mail.security_notice.kind_email_changed': 'e-mail alterado',

  // Sudo mode (pt-BR).
  'account.confirm.page_title': 'Confirme sua identidade',
  'account.confirm.title': 'Confirme sua identidade',
  'account.confirm.intro': 'Por segurança, confirme sua senha para continuar.',
  'account.confirm.password_label': 'Senha',
  'account.confirm.submit': 'Confirmar',
  'account.confirm.passkey_button': 'Confirmar com passkey',
  'account.confirm.error': 'Senha incorreta.',
  'account.confirm.passkey_error': 'Não foi possível autenticar com a passkey. Tente novamente.',
  'account.confirm.passwordless_notice':
    'Esta conta não possui senha. Adicione uma passkey para usar funcionalidades protegidas.',
  // Rótulos dos métodos do SPI de sudo (account/confirm.edge, um bloco por método disponível).
  'account.confirm.method.password': 'Confirmar com a senha',
  'account.confirm.method.passkey': 'Confirmar com passkey',
  'account.confirm.method.magic_link': 'Receber link de confirmação por e-mail',
  'account.confirm.method.oidc_step_up': 'Entrar de novo para confirmar',
  'account.confirm.magic_link_sent':
    'Enviamos um link de confirmação para o seu e-mail. Ele expira em 5 minutos.',
  'account.confirm.no_methods':
    'Nenhum método de confirmação está disponível para esta conta. Fale com o suporte.',
  'account.confirm.preferred_badge': 'Usado da última vez',

  // Admin settings — sudo_mode card (pt-BR).
  'admin.settings.sudo_mode_section': 'Modo sudo (confirmação de identidade)',
  'admin.settings.sudo_mode_intro':
    'Quando habilitado, ações sensíveis (troca de senha, troca de e-mail, exclusão de conta, gerência de MFA/passkey, criação/revogação de PAT) exigem que o usuário confirme sua senha. A confirmação é válida por um período de graça configurável.',
  'admin.settings.sudo_mode_from_config': 'Fonte: padrão',
  'admin.settings.sudo_mode_from_setting': 'Fonte: setting em runtime',
  'admin.settings.sudo_mode_grace_label': 'Período de graça (minutos)',

  // E-mail de desbloqueio do fator OTP (pt-BR).
  'mail.otp_unlock.subject': 'Desbloqueio da verificação em duas etapas',
  'mail.otp_unlock.heading': 'Desbloqueie sua verificação em duas etapas',
  'mail.otp_unlock.intro':
    'Sua verificação em duas etapas foi bloqueada após muitas tentativas incorretas. Clique no botão abaixo para desbloquear.',
  'mail.otp_unlock.cta': 'Desbloquear verificação',
  'mail.otp_unlock.fallback':
    'Se você não tentou fazer login, sua conta pode estar em risco — altere sua senha imediatamente.',

  // Tela de desbloqueio OTP (pt-BR).
  'otp_unlock.page_title': 'Desbloqueio da verificação em duas etapas',
  'otp_unlock.ok_title': 'Verificação em duas etapas desbloqueada',
  'otp_unlock.ok_body':
    'Sua verificação em duas etapas foi desbloqueada. Você pode entrar novamente.',
  'otp_unlock.login_link': 'Voltar ao login',
  'otp_unlock.invalid_title': 'Link inválido ou expirado',
  'otp_unlock.invalid_body':
    'O link de desbloqueio é inválido ou já foi usado. Tente fazer login novamente para receber um novo link.',
  'otp_unlock.expired_body':
    'O link de desbloqueio expirou. Tente fazer login novamente para receber um novo link.',

  // Admin settings — otp_lockout card (pt-BR).
  'admin.settings.otp_lockout_section': 'Bloqueio do fator OTP',
  'admin.settings.otp_lockout_intro':
    'Bloqueia o fator TOTP/recovery (não a conta) após N falhas consecutivas. Envia um link de desbloqueio por e-mail. Requer @adonisjs/limiter. Controlado por accountId.',
  'admin.settings.otp_lockout_from_config': 'Fonte: padrão',
  'admin.settings.otp_lockout_from_setting': 'Fonte: setting em runtime',
  'admin.settings.otp_lockout_max_attempts_label': 'Máximo de tentativas antes do bloqueio',
  'admin.settings.otp_lockout_unlock_ttl_label': 'Validade do link de desbloqueio (horas)',

  // Admin settings — email_change card.
  'admin.settings.email_change_section': 'Troca de e-mail',
  'admin.settings.email_change_intro':
    'Controla o fluxo de troca de e-mail verificada. Quando habilitado, usuários podem solicitar troca de e-mail em /account/security; um link de confirmação é enviado para o novo endereço e um aviso de segurança para o atual.',
  'admin.settings.email_change_ttl_label': 'Validade do token (horas)',
  'admin.settings.email_change_require_password_label': 'Exigir senha atual',
  'admin.settings.email_change_from_config': 'Fonte: padrão',
  'admin.settings.email_change_from_setting': 'Fonte: setting em runtime',

  // Admin settings — security_notifications card.
  'admin.settings.security_notifications_section': 'Notificações de segurança',
  'admin.settings.security_notifications_intro':
    'Envia alerta por e-mail à conta quando eventos de segurança ocorrem (troca de senha, MFA ligado/desligado, passkey adicionada/removida, e-mail alterado). Cada tipo pode ser habilitado individualmente.',
  'admin.settings.security_notifications_kinds_label': 'Notificar em',
  'admin.settings.security_notifications_from_config': 'Fonte: padrão',
  'admin.settings.security_notifications_from_setting': 'Fonte: setting em runtime',
  'admin.settings.security_notifications_kind_password_changed': 'Senha alterada',
  'admin.settings.security_notifications_kind_mfa_enabled': 'MFA habilitado',
  'admin.settings.security_notifications_kind_mfa_disabled': 'MFA desabilitado',
  'admin.settings.security_notifications_kind_passkey_added': 'Passkey adicionada',
  'admin.settings.security_notifications_kind_passkey_removed': 'Passkey removida',
  'admin.settings.security_notifications_kind_email_changed': 'E-mail alterado',

  // Admin settings — session_policy card (pt-BR).
  'admin.settings.session_policy_section': 'Política de sessão',
  'admin.settings.session_policy_intro':
    'Controla o tempo de vida da sessão e a imposição de sessão única. "Manter conectado" permite que o usuário opte por uma sessão mais longa. Sessão única revoga todas as outras sessões OIDC ativas no login. O timeout por inatividade encerra a sessão do console de conta após inatividade (tokens OIDC não são afetados).',
  'admin.settings.session_policy_from_config': 'Fonte: padrão',
  'admin.settings.session_policy_from_setting': 'Fonte: setting em runtime',
  'admin.settings.session_policy_remember_enabled_label': 'Exibir checkbox "Manter conectado"',
  'admin.settings.session_policy_remember_days_label': 'Duração do "manter conectado" (dias)',
  'admin.settings.session_policy_remember_days_hint':
    'Duração da sessão OIDC persistente quando o checkbox está marcado.',
  'admin.settings.session_policy_default_hours_label': 'Duração padrão da sessão (horas)',
  'admin.settings.session_policy_default_hours_hint':
    'Duração máxima da sessão transiente (checkbox desmarcado ou desabilitado). Derivado de config.ttl.session quando não definido.',
  'admin.settings.session_policy_single_session_label': 'Sessão única por conta',
  'admin.settings.session_policy_single_session_hint':
    'Quando habilitado, o login revoga todas as outras sessões OIDC ativas da conta. Tokens emitidos em sessões anteriores ficam inválidos.',
  'admin.settings.session_policy_idle_timeout_label':
    'Timeout de inatividade no console de conta (minutos, 0 = desligado)',
  'admin.settings.session_policy_idle_timeout_hint':
    'Encerra a sessão do console de conta após este número de minutos de inatividade. Não afeta sessões OIDC ou tokens.',
  'admin.settings.session_policy_idle_warn':
    'Aviso de timeout de inatividade: idleTimeoutMinutes excede defaultSessionHours. O timeout de inatividade nunca irá disparar.',
  'admin.settings.session_policy_remember_days_warn':
    'Os dias de "manter conectado" excedem 365. Isso é incomumente longo.',

  // Admin settings — seções.
  'admin.settings.section_authentication': 'Autenticação',
  'admin.settings.section_security': 'Segurança',
  'admin.settings.section_sessions': 'Sessões',
  'admin.settings.section_communications': 'Comunicações',
  'admin.settings.section_advanced': 'Avançado',

  // Admin settings — lockout.
  'admin.settings.lockout_section': 'Bloqueio de conta',
  'admin.settings.lockout_intro':
    'Bloqueio progressivo de conta por e-mail (anti-força-bruta). Requer @adonisjs/limiter. Campos de política gerenciados aqui; `store` permanece no config estático.',
  'admin.settings.lockout_from_config': 'Fonte: config estático / defaults',
  'admin.settings.lockout_from_setting': 'Fonte: runtime setting',
  'admin.settings.lockout_max_attempts_label': 'Tentativas antes do bloqueio',
  'admin.settings.lockout_window_sec_label': 'Janela deslizante (segundos)',
  'admin.settings.lockout_base_lockout_sec_label': 'Duração do primeiro bloqueio (segundos)',
  'admin.settings.lockout_max_lockout_sec_label': 'Duração máxima do bloqueio (segundos)',

  // Admin settings — rate_limit.
  'admin.settings.rate_limit_section': 'Rate limit',
  'admin.settings.rate_limit_intro':
    'Buckets de rate-limit para login/signup/forgot/reset (por IP) e introspecção de PAT. NOTA: o middleware de throttle de rota usa os valores do boot; esta setting afeta apenas o lockout-side em runtime.',
  'admin.settings.rate_limit_from_config': 'Fonte: config estático / defaults',
  'admin.settings.rate_limit_from_setting': 'Fonte: runtime setting',
  'admin.settings.rate_limit_login_points_label': 'Bucket de login: requests permitidos',
  'admin.settings.rate_limit_login_duration_label':
    'Bucket de login: duração da janela (ex.: "1 min")',
  'admin.settings.rate_limit_introspection_points_label':
    'Bucket de introspecção: requests permitidos',
  'admin.settings.rate_limit_introspection_duration_label':
    'Bucket de introspecção: duração da janela',
  'admin.settings.rate_limit_limitation_note':
    'LIMITAÇÃO: o middleware de throttle de rota usa o config do boot. Esta setting afeta apenas o lockout-side em runtime.',

  // Admin settings — password_policy.
  'admin.settings.password_policy_section': 'Política de senha',
  'admin.settings.password_policy_intro':
    'Requisitos de complexidade para senhas novas. checkPwned verifica contra HaveIBeenPwned (k-anonymity, fail-safe). Campos antes no config do store; gerenciar aqui evita redeploy.',
  'admin.settings.password_policy_from_config': 'Fonte: config estático / defaults',
  'admin.settings.password_policy_from_setting': 'Fonte: runtime setting',
  'admin.settings.password_policy_min_length_label': 'Comprimento mínimo',
  'admin.settings.password_policy_require_uppercase_label': 'Exigir letra maiúscula',
  'admin.settings.password_policy_require_lowercase_label': 'Exigir letra minúscula',
  'admin.settings.password_policy_require_numbers_label': 'Exigir número',
  'admin.settings.password_policy_require_symbols_label': 'Exigir símbolo',
  'admin.settings.password_policy_check_pwned_label':
    'Verificar contra HaveIBeenPwned (k-anonymity, fail-safe)',
  'admin.settings.password_policy_block_common_label':
    'Bloquear senhas comuns (lista offline com ~10 000 senhas mais usadas, sem distinção de maiúsculas/minúsculas)',

  // Admin settings — notifications.
  'admin.settings.notifications_section': 'Notificações de login',
  'admin.settings.notifications_intro':
    'Alertas de e-mail para novos logins (novo IP) e logins de novo dispositivo. Best-effort, fire-and-forget.',
  'admin.settings.notifications_from_config': 'Fonte: config estático / defaults',
  'admin.settings.notifications_from_setting': 'Fonte: runtime setting',
  'admin.settings.notifications_new_login_label': 'Enviar alerta de novo login (novo IP)',
  'admin.settings.notifications_new_device_label': 'Enviar alerta de login de novo dispositivo',

  // Admin settings — trusted_devices.
  'admin.settings.trusted_devices_section': 'Dispositivos confiáveis (pular MFA)',
  'admin.settings.trusted_devices_intro':
    'Quando habilitado, um cookie encriptado marca o dispositivo como confiável por N dias após verificação MFA. Step-up (acr_values) sempre ignora. Nome do cookie e segredos permanecem no config estático.',
  'admin.settings.trusted_devices_from_config': 'Fonte: config estático / defaults',
  'admin.settings.trusted_devices_from_setting': 'Fonte: runtime setting',
  'admin.settings.trusted_devices_days_label': 'Duração da confiança (dias)',

  // Admin settings — token_ttl.
  'admin.settings.token_ttl_section': 'TTL de tokens',
  'admin.settings.token_ttl_intro':
    'Tempo de vida dos tokens OIDC. Mudanças entram em vigor imediatamente via holder mutável (sem redeploy). O TTL de sessão é gerenciado em Política de sessão. Em segundos.',
  'admin.settings.token_ttl_from_config': 'Fonte: config estático / defaults',
  'admin.settings.token_ttl_from_setting': 'Fonte: runtime setting',
  'admin.settings.token_ttl_access_token_label': 'TTL do access token (segundos)',
  'admin.settings.token_ttl_id_token_label': 'TTL do ID token (segundos)',
  'admin.settings.token_ttl_refresh_token_label': 'TTL do refresh token (segundos)',

  // Admin settings — admin_impersonation.
  'admin.settings.admin_impersonation_section': 'Impersonation admin',
  'admin.settings.admin_impersonation_intro':
    'Exibe o painel de impersonation (RFC 8693 token exchange) na página do usuário no console admin. NÃO é bypass de auth — o exchange exige um access token admin. Altere sem redeploy.',
  'admin.settings.admin_impersonation_from_config': 'Fonte: config estático / defaults',
  'admin.settings.admin_impersonation_from_setting': 'Fonte: runtime setting',

  // Admin settings — organizations_policy.
  'admin.settings.organizations_policy_section': 'Política de organizações',
  'admin.settings.organizations_policy_intro':
    'Política de runtime para organizações (multi-tenancy). A role `owner` é sempre incluída (invariante de governança). Habilitação é determinada por capability-probing e config estático.',
  'admin.settings.organizations_policy_from_config': 'Fonte: config estático / defaults',
  'admin.settings.organizations_policy_from_setting': 'Fonte: runtime setting',
  'admin.settings.organizations_policy_allow_self_create_label':
    'Permitir que usuários criem suas próprias organizações',
  'admin.settings.organizations_policy_invitation_ttl_label': 'TTL dos convites (horas)',
  'admin.settings.organizations_policy_roles_label':
    'Roles disponíveis (separadas por vírgula; owner sempre incluída)',

  // Console admin — catálogo de roles (admin/roles) — pt-BR.
  'admin.roles.page_title': 'Catálogo de roles',
  'admin.roles.title': 'Catálogo de roles',
  'admin.roles.create_section': 'Criar role',
  'admin.roles.create_intro':
    'Os nomes de role devem usar apenas letras maiúsculas e underscores (ex.: EDITOR, GESTOR_CONTEUDO). A role ADMIN é sempre presente e não pode ser removida.',
  'admin.roles.name_placeholder': 'NOME_DA_ROLE',
  'admin.roles.name_pattern_hint':
    'Apenas letras maiúsculas, dígitos e underscores. Deve começar com uma letra.',
  'admin.roles.description_placeholder': 'Descrição (opcional)',
  'admin.roles.create_submit': 'Criar role',
  'admin.roles.empty': 'Nenhuma role no catálogo.',
  'admin.roles.protected_badge': 'Protegida',
  'admin.roles.save_description': 'Salvar',
  'admin.roles.delete': 'Remover',
  'admin.roles.delete_confirm':
    'Remover a role {name} do catálogo? Os usuários que já têm esta role continuarão com ela — ela apenas deixará de aparecer no catálogo para novas atribuições.',
  'admin.roles.delete_note':
    'Remover uma role do catálogo NÃO a remove dos usuários que já a possuem. Use a página de usuários para atualizar as roles individualmente.',
  'admin.roles.created': 'Role criada.',
  'admin.roles.updated': 'Descrição da role atualizada.',
  'admin.roles.deleted': 'Role removida do catálogo.',
  'admin.roles.name_invalid':
    'Nome de role inválido. Use apenas letras maiúsculas, dígitos e underscores, começando com uma letra (ex.: EDITOR, GESTOR_CONTEUDO).',
  'admin.roles.name_taken': 'Já existe uma role com este nome no catálogo.',
  'admin.roles.admin_protected':
    'A role ADMIN não pode ser removida — ela é o gate de acesso ao console admin.',
  'admin.roles.no_settings_table':
    'A tabela `auth_settings` não existe. O catálogo de roles requer configurações em runtime — crie a tabela primeiro.',
  'admin.roles.unknown_role':
    'Uma ou mais roles selecionadas não estão no catálogo. Gerencie o catálogo em /admin/roles.',

  // Console admin — usuários: seção de roles (UI atualizada) — pt-BR.
  'admin.users.roles_section': 'Roles globais',
  'admin.users.out_of_catalog_label': 'Roles fora do catálogo:',
  'admin.users.out_of_catalog_badge': 'fora do catálogo',

  // Expiração de conta por inatividade — erro de login (pt-BR).
  'errors.account_expired':
    'Sua conta foi desativada por inatividade. Para reativá-la, redefina sua senha.',

  // Admin settings — account_expiration card (pt-BR).
  'admin.settings.account_expiration_section': 'Expiração de conta por inatividade',
  'admin.settings.account_expiration_intro':
    'Bloqueia o login de contas inativas há mais de N dias (medido pelo último login bem-sucedido no audit). Requer um audit sink queryável (método `list`). Reativação: o usuário redefine a senha. Sem novas colunas — "última atividade" é lida do audit.',
  'admin.settings.account_expiration_from_config': 'Fonte: padrão',
  'admin.settings.account_expiration_from_setting': 'Fonte: setting em runtime',
  'admin.settings.account_expiration_inactive_days_label': 'Limiar de inatividade (dias)',
  'admin.settings.account_expiration_warn_days_label':
    'Avisar N dias antes de expirar (0 = desligado)',
  'admin.settings.account_expiration_no_audit':
    'Audit sink queryável não disponível. A expiração de conta requer um audit sink com o método `list` (ex.: lucidAuditSink). Habilite o audit primeiro.',

  // E-mail de aviso de expiração iminente (pt-BR).
  'mail.account_expiration_warn.subject': 'Sua conta será desativada por inatividade',
  'mail.account_expiration_warn.heading': 'Aviso de inatividade de conta',
  'mail.account_expiration_warn.intro':
    'Sua conta será desativada em {days} dia(s) por inatividade. Entre na plataforma para manter sua conta ativa.',
  'mail.account_expiration_warn.cta': 'Entrar agora',
  'mail.account_expiration_warn.fallback':
    'Se você não usa mais esta conta, pode ignorar este e-mail.',
} satisfies AuthMessages;

/**
 * Locales embutidos no host-kit. O `en` é o default; o `pt-BR` está disponível
 * com `i18n: { locale: 'pt-BR' }` sem nenhuma config de mensagens extra. Os
 * overrides/locales do host (via `I18nConfig.messages`) são mesclados por cima.
 */
export const BUILTIN_MESSAGES: Record<string, AuthMessages> = {
  en: DEFAULT_MESSAGES,
  'pt-BR': PT_BR_MESSAGES,
};

/**
 * Resolve o catálogo ativo. Começa do catálogo embutido do locale selecionado
 * (ou do default `en` quando o locale não é embutido), depois mescla os
 * overrides do host por cima. Sem config, retorna o default `en` intacto.
 * Chaves omitidas caem no default `en` (fallback de cobertura).
 */
export function resolveMessages(i18n?: I18nConfig): AuthMessages {
  const locale = i18n?.locale ?? DEFAULT_LOCALE;
  // Base: sempre o default `en` para garantir cobertura total das chaves; o
  // catálogo embutido do locale (ex.: pt-BR) é mesclado por cima.
  const base: AuthMessages = {
    ...DEFAULT_MESSAGES,
    ...(BUILTIN_MESSAGES[locale] ?? {}),
  };
  const overrides = i18n?.messages?.[locale];
  if (!overrides) return base;
  // Mescla só valores definidos (o `Partial` permite undefined); chaves omitidas
  // seguem caindo no catálogo base.
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) base[key] = value;
  }
  return base;
}

/**
 * Retorna a string para `key` (cai na própria `key` quando ausente) com
 * interpolação no estilo `{name}`. Mantém placeholders sem valor intactos.
 */
export function translate(
  messages: AuthMessages,
  key: string,
  params?: Record<string, string | number>,
): string {
  const template = messages[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}
