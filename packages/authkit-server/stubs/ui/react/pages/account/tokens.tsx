interface TokenRow {
  id: string;
  name: string;
  scopes: string[];
  audience: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}
interface Props {
  csrfToken: string;
  createdToken: string | null;
  tokens: TokenRow[];
}

export default function AccountTokens({ csrfToken, createdToken, tokens }: Props) {
  return (
    <div className="min-h-screen bg-gray-100 p-4">
      <div className="mx-auto max-w-2xl">
        <div className="flex items-center justify-between py-6">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-gray-400">
              Acme
            </div>
            <h1 className="text-xl font-semibold text-gray-900">Tokens de acesso</h1>
          </div>
          <form method="POST" action="/account/logout">
            <input type="hidden" name="_csrf" value={csrfToken} />
            <button type="submit" className="text-sm text-gray-500 hover:underline">
              Sair
            </button>
          </form>
        </div>

        {createdToken && (
          <div className="mb-6 rounded-lg border border-emerald-300 bg-emerald-50 p-4">
            <p className="text-sm font-medium text-emerald-900">
              Token criado — copie agora, não será mostrado de novo:
            </p>
            <code className="mt-2 block break-all rounded bg-white px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-200">
              {createdToken}
            </code>
          </div>
        )}

        <form
          method="POST"
          action="/account/tokens"
          className="mb-6 flex gap-2 rounded-xl bg-white p-4 shadow-sm ring-1 ring-black/5"
        >
          <input type="hidden" name="_csrf" value={csrfToken} />
          <input
            name="name"
            placeholder="Nome do token (ex.: CI deploy)"
            className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-gray-900"
          />
          <button
            type="submit"
            className="rounded-lg bg-gray-900 px-4 text-sm font-semibold text-white"
          >
            Criar
          </button>
        </form>

        <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-black/5">
          {tokens.length === 0 ? (
            <p className="p-6 text-sm text-gray-500">Nenhum token ainda.</p>
          ) : (
            tokens.map((t) => (
              <div
                key={t.id}
                className="flex items-center justify-between border-b border-gray-100 p-4 last:border-0"
              >
                <div>
                  <p className="text-sm font-medium text-gray-900">{t.name}</p>
                  <p className="text-xs text-gray-500">
                    Criado em {new Date(t.createdAt).toLocaleDateString('pt-BR')}
                    {t.lastUsedAt
                      ? ` · último uso ${new Date(t.lastUsedAt).toLocaleDateString('pt-BR')}`
                      : ' · nunca usado'}
                  </p>
                </div>
                <form method="POST" action={`/account/tokens/${t.id}/revoke`}>
                  <input type="hidden" name="_csrf" value={csrfToken} />
                  <button type="submit" className="text-sm text-red-600 hover:underline">
                    Revogar
                  </button>
                </form>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
