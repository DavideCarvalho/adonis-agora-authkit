{
  exports({ to: app.makePath('inertia/components/auth_shell.tsx') });
}

import type { ReactNode } from 'react';

export interface AuthBrand {
  appName: string;
  accent: string;
  accentSoft?: string;
  company?: string;
  tagline?: string;
  audienceLabel?: string;
}

const COMPANY_FALLBACK = 'Acme';

/**
 * Layout de duas colunas para as telas de autenticacao do IdP.
 * Painel esquerdo: marca (empresa guarda-chuva + produto). Painel direito: formulario.
 */
export default function AuthShell({ brand, children }: { brand?: AuthBrand; children: ReactNode }) {
  const accent = brand?.accent ?? '#111827';
  const accentSoft = brand?.accentSoft ?? accent;
  const company = brand?.company ?? COMPANY_FALLBACK;
  const appName = brand?.appName ?? 'Sua conta';
  const tagline = brand?.tagline ?? 'Acesso unificado';

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 p-4">
      <div className="w-full max-w-4xl overflow-hidden rounded-2xl bg-white shadow-xl ring-1 ring-black/5 grid md:grid-cols-2">
        {/* Painel da marca */}
        <div
          className="relative flex flex-col justify-between p-8 text-white md:p-10"
          style={{ backgroundImage: `linear-gradient(135deg, ${accent} 0%, ${accentSoft} 100%)` }}
        >
          <div
            className="text-xs font-semibold uppercase tracking-[0.2em] text-white/80"
            aria-label="Empresa"
          >
            {company}
          </div>

          <div className="mt-10 md:mt-0">
            <h2 className="text-2xl font-bold leading-tight md:text-3xl">{appName}</h2>
            <p className="mt-2 text-sm text-white/85">{tagline}</p>
            {brand?.audienceLabel && (
              <span className="mt-4 inline-block rounded-full bg-white/20 px-3 py-1 text-xs font-medium uppercase tracking-wide text-white ring-1 ring-white/30">
                {brand.audienceLabel}
              </span>
            )}
          </div>

          <div className="mt-10 text-xs text-white/60">© {company}</div>
        </div>

        {/* Painel do formulario */}
        <div className="p-8 md:p-10">{children}</div>
      </div>
    </div>
  );
}
