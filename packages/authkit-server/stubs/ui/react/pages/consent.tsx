{
  exports({ to: app.makePath('inertia/pages/authkit/consent.tsx') });
}

import AuthShell, { type AuthBrand } from '../../components/auth_shell';

export default function AuthkitConsent({
  uid,
  params,
  csrfToken,
  brand,
}: {
  uid: string;
  params: { client_id: string };
  csrfToken: string;
  brand?: AuthBrand;
}) {
  const accent = brand?.accent ?? '#111827';
  const appName = brand?.appName ?? params.client_id;

  return (
    <AuthShell brand={brand}>
      <form method="POST" action={`/auth/interaction/${uid}/consent`}>
        <input type="hidden" name="_csrf" value={csrfToken} />
        <h1 className="text-xl font-semibold text-gray-900">Autorizar acesso</h1>
        <p className="mt-2 text-sm text-gray-600">
          O app <strong>{appName}</strong> quer acessar sua conta.
        </p>

        <button
          type="submit"
          className="mt-6 w-full rounded-lg py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
          style={{ backgroundColor: accent }}
        >
          Autorizar
        </button>
      </form>
    </AuthShell>
  );
}
