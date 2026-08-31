{
  exports({ to: app.makePath('inertia/pages/authkit/mfa-challenge.tsx') });
}

import AuthShell from '../components/auth_shell';

const inputClass =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-center text-lg tracking-[0.4em] outline-none transition focus:border-transparent focus:ring-2 focus:ring-gray-800';

export default function AuthkitMfaChallenge({
  uid,
  csrfToken,
  error,
}: {
  uid: string;
  csrfToken: string;
  error?: string;
}) {
  return (
    <AuthShell>
      <form method="POST" action={`/auth/interaction/${uid}/mfa`}>
        <input type="hidden" name="_csrf" value={csrfToken} />
        <h1 className="text-xl font-semibold text-gray-900">Verificação em duas etapas</h1>
        <p className="mt-1 text-sm text-gray-500">
          Abra seu app autenticador e informe o código de 6 dígitos.
        </p>

        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

        <div className="mt-6">
          <label htmlFor="code" className="mb-1 block text-sm font-medium text-gray-700">
            Código
          </label>
          <input
            id="code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={6}
            className={inputClass}
          />
        </div>

        <button
          type="submit"
          className="mt-6 w-full rounded-lg bg-gray-900 py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
        >
          Verificar
        </button>
      </form>

      <details className="mt-6 text-sm text-gray-600">
        <summary className="cursor-pointer hover:underline">Usar um código de recuperação</summary>
        <form method="POST" action={`/auth/interaction/${uid}/mfa`} className="mt-3">
          <input type="hidden" name="_csrf" value={csrfToken} />
          <input
            name="recoveryCode"
            placeholder="xxxxx-xxxxx"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-gray-900"
          />
          <button
            type="submit"
            className="mt-3 w-full rounded-lg border border-gray-300 py-2.5 text-sm font-semibold text-gray-700 transition hover:bg-gray-50"
          >
            Entrar com código de recuperação
          </button>
        </form>
      </details>
    </AuthShell>
  );
}
