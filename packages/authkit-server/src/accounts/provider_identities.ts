import {
  type AccountStore,
  type AuthAccount,
  type LinkProviderIdentityInput,
  type ProviderIdentitySummary,
  supportsProviderIdentity,
} from './account_store.js';

/** O account store não tem account linking (o host não passou `providerIdentityModel`). */
export class ProviderIdentitiesUnsupportedError extends Error {
  constructor() {
    super(
      '[authkit] o accountStore não suporta identidades de provider — passe `providerIdentityModel` ao lucidAccountStore',
    );
    this.name = 'ProviderIdentitiesUnsupportedError';
  }
}

/** Resultado de {@link ProviderIdentities.link}. */
export interface LinkProviderIdentityResult {
  /**
   * Conta a que a identidade estava ligada antes; `null` se era nova. Diferente do
   * `accountId` pedido = a identidade MUDOU de conta (o "Entrar com <provider>" passa
   * a abrir a conta nova).
   */
  previousAccountId: string | null;
}

/**
 * Identidades de provider (Google, GitHub, …) das contas: a MESMA ligação que o
 * "Entrar com <provider>" consulta antes de cair no e-mail. Exposto como
 * `authkit.identities` (`@adonis-agora/authkit-server/services/main`) para o host
 * ligar uma conta a um provider fora do login social — ex.: quando a pessoa conecta
 * o Google numa tela de integrações — sem tocar na tabela nem no account store cru.
 *
 * Store sem a capacidade: `supported` é `false` e os demais métodos lançam
 * {@link ProviderIdentitiesUnsupportedError}. Nada falha em silêncio.
 */
export class ProviderIdentities {
  readonly #getStore: () => AccountStore;

  constructor(getStore: () => AccountStore) {
    this.#getStore = getStore;
  }

  /** O account store tem account linking por provider. */
  get supported(): boolean {
    return supportsProviderIdentity(this.#getStore());
  }

  #store() {
    const store = this.#getStore();
    if (!supportsProviderIdentity(store)) throw new ProviderIdentitiesUnsupportedError();
    return store;
  }

  /** A conta ligada a `(provider, providerUserId)`; `null` se ninguém. */
  find(provider: string, providerUserId: string): Promise<AuthAccount | null> {
    return this.#store().findByProviderIdentity(provider, providerUserId);
  }

  /**
   * Liga a identidade à conta. Idempotente na chave `(provider, providerUserId)`: se
   * ela já estava em OUTRA conta, MUDA para esta (e `previousAccountId` diz de onde).
   * Só chame depois de provar que a pessoa é dona da identidade (OAuth concluído)
   * E da conta (sessão nela).
   */
  async link(input: LinkProviderIdentityInput): Promise<LinkProviderIdentityResult> {
    const store = this.#store();
    const previous = await store.findByProviderIdentity(input.provider, input.providerUserId);
    await store.linkProviderIdentity(input);
    return { previousAccountId: previous?.id ?? null };
  }

  /** As identidades da conta, sem tokens. */
  list(accountId: string): Promise<ProviderIdentitySummary[]> {
    return this.#store().listProviderIdentities(accountId);
  }

  /** Remove todas as identidades da conta; devolve quantas. */
  unlinkAll(accountId: string): Promise<number> {
    return this.#store().unlinkAllProviderIdentities(accountId);
  }
}
