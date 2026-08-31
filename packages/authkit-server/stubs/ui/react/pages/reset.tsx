{
  exports({ to: app.makePath('inertia/pages/authkit/reset.tsx') });
}

import AuthShell from '../../components/auth_shell';

const inputClass =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-transparent focus:ring-2 focus:ring-gray-800';

export default function AuthkitReset({
  token,
  csrfToken,
  done,
}: {
  token: string;
  csrfToken: string;
  done?: boolean;
}) {
  if (done) {
    return (
      <AuthShell>
        <h1 className="text-xl font-semibold text-gray-900">Senha redefinida</h1>
        <p className="mt-2 text-sm text-gray-600">Você já pode entrar com a nova senha.</p>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <form method="POST" action="/auth/reset-password">
        <input type="hidden" name="_csrf" value={csrfToken} />
        <input type="hidden" name="token" value={token} />
        <h1 className="text-xl font-semibold text-gray-900">Nova senha</h1>
        <p className="mt-1 text-sm text-gray-500">Escolha uma nova senha para sua conta.</p>

        <div className="mt-6">
          <label htmlFor="password" className="mb-1 block text-sm font-medium text-gray-700">
            Senha
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            minLength={8}
            className={inputClass}
          />
        </div>

        <button
          type="submit"
          className="mt-6 w-full rounded-lg bg-gray-900 py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
        >
          Redefinir
        </button>
      </form>
    </AuthShell>
  );
}
