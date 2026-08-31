{
  exports({ to: app.makePath('inertia/pages/authkit/forgot.tsx') });
}

import AuthShell from '../../components/auth_shell';

const inputClass =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-transparent focus:ring-2 focus:ring-gray-800';

export default function AuthkitForgot({ csrfToken, sent }: { csrfToken: string; sent?: boolean }) {
  if (sent) {
    return (
      <AuthShell>
        <h1 className="text-xl font-semibold text-gray-900">E-mail enviado</h1>
        <p className="mt-2 text-sm text-gray-600">
          Se o e-mail existir, enviaremos instruções de redefinição.
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <form method="POST" action="/auth/forgot-password">
        <input type="hidden" name="_csrf" value={csrfToken} />
        <h1 className="text-xl font-semibold text-gray-900">Recuperar senha</h1>
        <p className="mt-1 text-sm text-gray-500">Enviaremos um link para redefinir sua senha.</p>

        <div className="mt-6">
          <label htmlFor="email" className="mb-1 block text-sm font-medium text-gray-700">
            E-mail
          </label>
          <input id="email" name="email" type="email" required className={inputClass} />
        </div>

        <button
          type="submit"
          className="mt-6 w-full rounded-lg bg-gray-900 py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
        >
          Enviar link
        </button>
      </form>
    </AuthShell>
  );
}
