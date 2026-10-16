interface Props {
  csrfToken: string;
  error?: string;
}

export default function AccountLogin({ csrfToken, error }: Props) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 p-4">
      <form
        method="POST"
        action="/account/login"
        className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-xl ring-1 ring-black/5"
      >
        <input type="hidden" name="_csrf" value={csrfToken} />
        <div className="text-xs font-semibold uppercase tracking-[0.2em] text-gray-400">Acme</div>
        <h1 className="mt-2 text-xl font-semibold text-gray-900">Minha conta</h1>
        <p className="mt-1 text-sm text-gray-500">Gerencie seus tokens de acesso.</p>

        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

        <label htmlFor="email" className="mt-6 mb-1 block text-sm font-medium text-gray-700">
          E-mail
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-gray-900"
        />

        <label htmlFor="password" className="mt-4 mb-1 block text-sm font-medium text-gray-700">
          Senha
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-gray-900"
        />

        <button
          type="submit"
          className="mt-6 w-full rounded-lg bg-gray-900 py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
        >
          Entrar
        </button>
      </form>
    </div>
  );
}
