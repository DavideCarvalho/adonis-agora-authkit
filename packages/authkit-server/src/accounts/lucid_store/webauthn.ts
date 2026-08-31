import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { PasskeySummary, WebauthnCapability } from '../account_store.js';
import {
  buildMfaStateRepo,
  type LucidStoreContext,
  type ResolvedRp,
  type WebauthnCeremonies,
} from './shared.js';

/**
 * Capacidade de passkeys / WebAuthn (2º fator alternativo ao TOTP). Só é montada
 * quando o `webauthnCredentialModel` é fornecido — ausente, a capacidade inteira
 * fica ABSENTE do store (a UI esconde a seção de passkeys).
 */
export function buildWebauthn(
  ctx: LucidStoreContext,
  Credential: any,
  webauthn: ResolvedRp,
  ceremonies: WebauthnCeremonies,
): WebauthnCapability {
  const { Model } = ctx;
  // Estado de MFA é LIB-OWNED (tabela `auth_mfa`): registrar uma passkey habilita
  // o MFA gravando `mfa_enabled_at` em `auth_mfa`, não numa coluna do model.
  const mfaState = buildMfaStateRepo(Model);

  return {
    async generatePasskeyRegistrationOptions(accountId) {
      const row = await Model.find(accountId);
      if (!row) return null;
      const existing = await Credential.query().where('accountId', accountId);
      const options = await ceremonies.generateRegistrationOptions({
        rpName: webauthn.rpName,
        rpID: webauthn.rpId,
        userName: row.email,
        userDisplayName: row.fullName ?? row.email,
        // Não pede attestation (privacidade); confia na verificação local.
        attestationType: 'none',
        // Evita registrar a mesma credencial duas vezes.
        excludeCredentials: existing.map((c: any) => ({
          id: c.id,
          transports: (c.transports ?? undefined) as any,
        })),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      });
      return {
        options: options as unknown as Record<string, unknown>,
        challenge: options.challenge,
      };
    },

    async verifyPasskeyRegistration(accountId, response, expectedChallenge) {
      const row = await Model.find(accountId);
      if (!row) return false;
      let verification: Awaited<ReturnType<typeof ceremonies.verifyRegistrationResponse>>;
      try {
        verification = await ceremonies.verifyRegistrationResponse({
          response: response as RegistrationResponseJSON,
          expectedChallenge,
          expectedOrigin: webauthn.origin,
          expectedRPID: webauthn.rpId,
        });
      } catch {
        return false;
      }
      if (!verification.verified || !verification.registrationInfo) return false;

      const { credential } = verification.registrationInfo;
      // publicKey vem como Uint8Array → armazenamos como base64url (texto).
      const publicKey = Buffer.from(credential.publicKey).toString('base64url');
      await Credential.create({
        id: credential.id,
        accountId,
        publicKey,
        counter: credential.counter,
        transports: credential.transports ?? null,
        label: null,
      });
      // Registrar uma passkey também habilita o MFA (2º fator presente). O estado
      // vive em `auth_mfa`: só seta `mfa_enabled_at` se ainda não estiver habilitado
      // (preserva o instante do enrollment original — importante p/ trusted-device).
      const current = await mfaState.read(accountId);
      if (!current?.mfaEnabledAt) {
        await mfaState.upsert(accountId, { mfaEnabledAt: Date.now() });
      }
      return true;
    },

    async generatePasskeyAuthenticationOptions(accountId) {
      const creds = await Credential.query().where('accountId', accountId);
      if (creds.length === 0) return null;
      const options = await ceremonies.generateAuthenticationOptions({
        rpID: webauthn.rpId,
        allowCredentials: creds.map((c: any) => ({
          id: c.id,
          transports: (c.transports ?? undefined) as any,
        })),
        userVerification: 'preferred',
      });
      return {
        options: options as unknown as Record<string, unknown>,
        challenge: options.challenge,
      };
    },

    async verifyPasskeyAuthentication(accountId, response, expectedChallenge) {
      const resp = response as AuthenticationResponseJSON;
      // O credential id vem na resposta (base64url) → acha a credencial da conta.
      const cred = await Credential.query()
        .where('accountId', accountId)
        .where('id', resp?.id ?? '')
        .first();
      if (!cred) return false;
      let verification: Awaited<ReturnType<typeof ceremonies.verifyAuthenticationResponse>>;
      try {
        verification = await ceremonies.verifyAuthenticationResponse({
          response: resp,
          expectedChallenge,
          expectedOrigin: webauthn.origin,
          expectedRPID: webauthn.rpId,
          credential: {
            id: cred.id,
            publicKey: new Uint8Array(Buffer.from(cred.publicKey, 'base64url')),
            counter: cred.counter,
            transports: (cred.transports ?? undefined) as any,
          },
        });
      } catch {
        return false;
      }
      if (!verification.verified) return false;
      // Atualiza o signature counter (anti-replay).
      cred.counter = verification.authenticationInfo.newCounter;
      await cred.save();
      return true;
    },

    async listPasskeys(accountId): Promise<PasskeySummary[]> {
      const creds = await Credential.query()
        .where('accountId', accountId)
        .orderBy('createdAt', 'asc');
      return creds.map((c: any) => ({
        id: c.id,
        label: c.label ?? undefined,
        createdAt: c.createdAt?.toISO?.() ?? String(c.createdAt ?? ''),
      }));
    },

    async removePasskey(accountId, credentialId) {
      await Credential.query().where('accountId', accountId).where('id', credentialId).delete();
    },
  };
}
