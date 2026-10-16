interface Props {
  csrfToken: string;
  enabled: boolean;
  enrolling?: boolean;
  secret?: string | null;
  qrDataUrl?: string | null;
  error?: string;
  recoveryCodes?: string[] | null;
}

export default function AccountMfa({
  csrfToken,
  enabled,
  enrolling,
  secret,
  qrDataUrl,
  error,
  recoveryCodes,
}: Props) {
  return (
    <div className="min-h-screen bg-gray-100 p-4">
      <div className="mx-auto max-w-2xl">
        <div className="flex items-center justify-between py-6">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-gray-400">
              Acme
            </div>
            <h1 className="text-xl font-semibold text-gray-900">Verificação em duas etapas</h1>
          </div>
          <form method="POST" action="/account/logout">
            <input type="hidden" name="_csrf" value={csrfToken} />
            <button type="submit" className="text-sm text-gray-500 hover:underline">
              Sair
            </button>
          </form>
        </div>

        {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

        {recoveryCodes && recoveryCodes.length > 0 && (
          <div className="mb-6 rounded-lg border border-emerald-300 bg-emerald-50 p-4">
            <p className="text-sm font-medium text-emerald-900">
              Guarde seus códigos de recuperação — eles não serão mostrados de novo:
            </p>
            <ul className="mt-3 grid grid-cols-2 gap-2">
              {recoveryCodes.map((rc) => (
                <li key={rc}>
                  <code className="block rounded bg-white px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-200">
                    {rc}
                  </code>
                </li>
              ))}
            </ul>
          </div>
        )}

        {enrolling ? (
          <div className="rounded-xl bg-white p-6 shadow-sm ring-1 ring-black/5">
            <p className="text-sm text-gray-600">
              Escaneie o QR code com seu app autenticador (Google Authenticator, 1Password, etc.).
            </p>
            {qrDataUrl && (
              <img src={qrDataUrl} alt="QR code TOTP" className="mx-auto my-4 h-48 w-48" />
            )}
            {secret && (
              <>
                <p className="text-center text-xs text-gray-500">Ou informe manualmente:</p>
                <code className="mx-auto mt-1 block w-fit break-all rounded bg-gray-100 px-3 py-2 text-sm text-gray-800">
                  {secret}
                </code>
              </>
            )}
            <form method="POST" action="/account/mfa/confirm" className="mt-6">
              <input type="hidden" name="_csrf" value={csrfToken} />
              <label htmlFor="code" className="mb-1 block text-sm font-medium text-gray-700">
                Código de confirmação
              </label>
              <input
                id="code"
                name="code"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-center text-lg tracking-[0.4em] outline-none focus:border-gray-900"
              />
              <button
                type="submit"
                className="mt-4 w-full rounded-lg bg-gray-900 py-2.5 text-sm font-semibold text-white"
              >
                Ativar verificação em duas etapas
              </button>
            </form>
          </div>
        ) : enabled ? (
          <div className="rounded-xl bg-white p-6 shadow-sm ring-1 ring-black/5">
            <p className="text-sm text-gray-700">
              A verificação em duas etapas está{' '}
              <span className="font-semibold text-emerald-700">ativa</span> nesta conta.
            </p>
            <form method="POST" action="/account/mfa/disable" className="mt-4">
              <input type="hidden" name="_csrf" value={csrfToken} />
              <button
                type="submit"
                className="rounded-lg border border-red-300 px-4 py-2 text-sm font-semibold text-red-600 hover:bg-red-50"
              >
                Desativar
              </button>
            </form>
          </div>
        ) : (
          <div className="rounded-xl bg-white p-6 shadow-sm ring-1 ring-black/5">
            <p className="text-sm text-gray-700">
              A verificação em duas etapas está desativada. Ative-a para proteger sua conta com um
              app autenticador.
            </p>
            <form method="POST" action="/account/mfa/enroll" className="mt-4">
              <input type="hidden" name="_csrf" value={csrfToken} />
              <button
                type="submit"
                className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white"
              >
                Ativar verificação em duas etapas
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
