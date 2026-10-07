{
  exports({ to: app.makePath('inertia/pages/authkit/consent.tsx') });
}

import AuthShell, { type AuthBrand } from '../../components/auth_shell';

export default function AuthkitConsent({
  uid,
  params,
  csrfToken,
  brand,
  clientName,
  scopes = [],
}: {
  uid: string;
  params: { client_id: string };
  csrfToken: string;
  brand?: AuthBrand;
  /** O nome que o client registrou (ex.: "Claude Code"); sem ele, o `client_id`. */
  clientName?: string;
  /** Os escopos pedidos, com o rótulo de cada um. */
  scopes?: { id: string; label: string }[];
}) {
  const accent = brand?.accent ?? '#111827';
  const appName = clientName ?? params.client_id;

  return (
    <AuthShell brand={brand}>
      <form method="POST" action={`/auth/interaction/${uid}/consent`}>
        <input type="hidden" name="_csrf" value={csrfToken} />
        <h1 className="text-xl font-semibold text-gray-900">Autorizar acesso</h1>
        <p className="mt-2 text-sm text-gray-600">
          O app <strong>{appName}</strong> quer acessar sua conta.
        </p>
        {scopes.length > 0 && (
          <>
            <p className="mt-4 text-sm font-medium text-gray-900">Ele vai poder:</p>
            <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-gray-600">
              {scopes.map((scope) => (
                <li key={scope.id}>{scope.label}</li>
              ))}
            </ul>
          </>
        )}

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
