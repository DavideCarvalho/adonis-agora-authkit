{
  exports({ to: app.makePath('inertia/pages/authkit/login.tsx') });
}

import AuthShell, { type AuthBrand } from '../../components/auth_shell';

const inputClass =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-transparent focus:ring-2';

export default function AuthkitLogin({
  uid,
  csrfToken,
  step = 'identifier',
  email,
  account,
  error,
  brand,
}: {
  uid: string;
  csrfToken: string;
  step?: 'identifier' | 'password';
  email?: string;
  account?: { fullName: string | null; globalRoles: string[] } | null;
  error?: string;
  brand?: AuthBrand;
}) {
  const accent = brand?.accent ?? '#111827';
  const focusStyle = { ['--tw-ring-color' as any]: accent };

  if (step === 'identifier') {
    return (
      <AuthShell brand={brand}>
        <form method="POST" action={`/auth/interaction/${uid}/identifier`}>
          <input type="hidden" name="_csrf" value={csrfToken} />
          <h1 className="text-xl font-semibold text-gray-900">Entrar</h1>
          <p className="mt-1 text-sm text-gray-500">Informe seu e-mail para continuar.</p>

          {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

          <div className="mt-6">
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

          <button
            type="submit"
            className="mt-6 w-full rounded-lg py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
            style={{ backgroundColor: accent }}
          >
            Continuar
          </button>

          <div className="mt-4 flex justify-between text-sm text-gray-600">
            <a href={`/auth/interaction/${uid}/signup`} className="hover:underline">
              Criar conta
            </a>
            <a href="/auth/forgot-password" className="hover:underline">
              Esqueci a senha
            </a>
          </div>
        </form>

        <div className="my-6 flex items-center gap-3 text-xs text-gray-400">
          <span className="h-px flex-1 bg-gray-200" />
          ou
          <span className="h-px flex-1 bg-gray-200" />
        </div>

        <a
          href={`/auth/google/redirect/${uid}`}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-300 bg-white py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="#4285F4"
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z"
            />
            <path
              fill="#34A853"
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
            />
            <path
              fill="#FBBC05"
              d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z"
            />
            <path
              fill="#EA4335"
              d="M12 4.75c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 1.46 14.97.5 12 .5A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.3 9.14 4.75 12 4.75Z"
            />
          </svg>
          Entrar com Google
        </a>
      </AuthShell>
    );
  }

  // step === 'password'
  const isAdmin = account?.globalRoles?.includes('ADMIN') ?? false;

  return (
    <AuthShell brand={brand}>
      <form method="POST" action={`/auth/interaction/${uid}/login`}>
        <input type="hidden" name="_csrf" value={csrfToken} />

        {account?.fullName ? (
          <h1 className="text-xl font-semibold text-gray-900">
            Olá, {account.fullName}
            {isAdmin && (
              <span className="ml-2 inline-block rounded bg-amber-100 px-1.5 py-0.5 align-middle text-xs font-semibold uppercase text-amber-800">
                ADMIN
              </span>
            )}
          </h1>
        ) : (
          <h1 className="text-xl font-semibold text-gray-900">Entrar</h1>
        )}

        <div className="mt-1 flex items-center gap-2">
          <span className="text-sm text-gray-500">{email}</span>
          <a
            href={`/auth/interaction/${uid}/switch`}
            className="text-xs font-medium hover:underline"
            style={{ color: accent }}
          >
            Trocar de conta
          </a>
        </div>

        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

        <div className="mt-6">
          <label htmlFor="password" className="mb-1 block text-sm font-medium text-gray-700">
            Senha
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            className={inputClass}
            style={focusStyle}
          />
        </div>

        <button
          type="submit"
          className="mt-6 w-full rounded-lg py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
          style={{ backgroundColor: accent }}
        >
          Entrar
        </button>

        <div className="mt-4 flex justify-end text-sm text-gray-600">
          <a href="/auth/forgot-password" className="hover:underline">
            Esqueci a senha
          </a>
        </div>
      </form>
    </AuthShell>
  );
}
