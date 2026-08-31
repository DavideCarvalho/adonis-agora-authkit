{
  exports({ to: app.makePath('inertia/pages/authkit/signup.tsx') });
}

import AuthShell, { type AuthBrand } from '../../components/auth_shell';

const inputClass =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-transparent focus:ring-2';

export default function AuthkitSignup({
  uid,
  csrfToken,
  error,
  brand,
}: {
  uid: string;
  csrfToken: string;
  error?: string;
  brand?: AuthBrand;
}) {
  const accent = brand?.accent ?? '#111827';
  const focusStyle = { ['--tw-ring-color' as any]: accent };

  return (
    <AuthShell brand={brand}>
      <form method="POST" action={`/auth/interaction/${uid}/signup`}>
        <input type="hidden" name="_csrf" value={csrfToken} />
        <h1 className="text-xl font-semibold text-gray-900">Criar conta</h1>
        <p className="mt-1 text-sm text-gray-500">Preencha seus dados para começar.</p>

        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

        <div className="mt-6">
          <label htmlFor="fullName" className="mb-1 block text-sm font-medium text-gray-700">
            Nome
          </label>
          <input
            id="fullName"
            name="fullName"
            type="text"
            required
            className={inputClass}
            style={focusStyle}
          />
        </div>

        <div className="mt-4">
          <label htmlFor="email" className="mb-1 block text-sm font-medium text-gray-700">
            E-mail
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            className={inputClass}
            style={focusStyle}
          />
        </div>

        <div className="mt-4">
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
            style={focusStyle}
          />
        </div>

        <button
          type="submit"
          className="mt-6 w-full rounded-lg py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
          style={{ backgroundColor: accent }}
        >
          Criar conta
        </button>

        <a
          href={`/auth/interaction/${uid}`}
          className="mt-4 block text-center text-sm text-gray-600 hover:underline"
        >
          Já tenho conta
        </a>
      </form>
    </AuthShell>
  );
}
