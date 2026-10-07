{
  exports({ to: app.makePath('inertia/pages/authkit/mfa-challenge.tsx') });
}

import { useRef, useState } from 'react';
import AuthShell, { type AuthBrand } from '../../components/auth_shell';

interface CustomMethod {
  id: string;
  factorId: string;
  label: string;
  fields?: {
    name: string;
    label: string;
    type?: 'text' | 'password';
    inputMode?: 'numeric' | 'text';
    autoComplete?: string;
  }[];
  requiresBegin: boolean;
  started: boolean;
  beginUrl: string;
  verifyUrl: string;
}

const inputClass =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-base outline-none transition focus:border-gray-900 focus:ring-2 focus:ring-gray-900';
const buttonClass =
  'w-full rounded-lg bg-gray-900 px-3 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50';
const secondaryButtonClass =
  'w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm font-semibold text-gray-700 transition hover:bg-gray-50 disabled:opacity-50';

export default function AuthkitMfaChallenge({
  uid,
  csrfToken,
  error,
  brand,
  messages = {},
  noEnrollment = false,
  otpLocked = false,
  totpAvailable = true,
  passkeyAvailable = false,
  trustedDevicesEnabled = false,
  trustedDeviceDays = 30,
  customMfaMethods = [],
  completedMfaMethods = [],
  requiredMfaFactors = 2,
}: {
  uid: string;
  csrfToken: string;
  error?: string;
  brand?: AuthBrand;
  messages?: Record<string, string>;
  noEnrollment?: boolean;
  otpLocked?: boolean;
  totpAvailable?: boolean;
  passkeyAvailable?: boolean;
  trustedDevicesEnabled?: boolean;
  trustedDeviceDays?: number;
  customMfaMethods?: CustomMethod[];
  completedMfaMethods?: string[];
  requiredMfaFactors?: number;
}) {
  const [passkeyPending, setPasskeyPending] = useState(false);
  const [passkeyError, setPasskeyError] = useState(false);
  const [trustDevice, setTrustDevice] = useState(false);
  const passkeyForm = useRef<HTMLFormElement>(null);
  const passkeyResponse = useRef<HTMLInputElement>(null);
  const t = (key: string, fallback: string) => messages[`mfa_challenge.${key}`] ?? fallback;
  const showTotp = !noEnrollment && !otpLocked && totpAvailable;
  const showPasskey = !noEnrollment && passkeyAvailable;
  const remainingMethods = noEnrollment
    ? []
    : customMfaMethods.filter((method) => !completedMfaMethods.includes(method.id));

  async function authenticatePasskey() {
    setPasskeyPending(true);
    setPasskeyError(false);
    try {
      const result = await fetch(`/auth/interaction/${uid}/passkey/options`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({}),
      });
      if (!result.ok) throw new Error('Passkey options failed');
      const moduleUrl = '/authkit/assets/webauthn.js';
      const { startAuthentication } = await import(/* @vite-ignore */ moduleUrl);
      const assertion = await startAuthentication({ optionsJSON: await result.json() });
      if (!passkeyResponse.current || !passkeyForm.current) throw new Error('Missing passkey form');
      passkeyResponse.current.value = JSON.stringify(assertion);
      passkeyForm.current.submit();
    } catch {
      setPasskeyError(true);
      setPasskeyPending(false);
    }
  }

  return (
    <AuthShell brand={brand}>
      <h1 className="text-xl font-semibold text-gray-900">
        {t('title', 'Verificação multifator')}
      </h1>
      <p className="mt-1 text-sm text-gray-500">
        {t('intro', 'Verifique sua identidade usando um método disponível.')}
      </p>
      {requiredMfaFactors > 2 && (
        <p className="mt-3 text-sm text-gray-600" role="status">
          {t('progress', '{completed} de {required} fatores verificados.')
            .replace('{completed}', String(1 + completedMfaMethods.length))
            .replace('{required}', String(requiredMfaFactors))}
        </p>
      )}
      {error && (
        <p className="mt-4 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}

      {showTotp && (
        <form method="POST" action={`/auth/interaction/${uid}/mfa`} className="mt-6">
          <input type="hidden" name="_csrf" value={csrfToken} />
          <label htmlFor="code" className="mb-1 block text-sm font-medium text-gray-700">
            {t('code_label', 'Código')}
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
          {trustedDevicesEnabled && (
            <label className="mt-4 flex items-center gap-2 text-sm text-gray-600">
              <input
                type="checkbox"
                name="trustDevice"
                value="on"
                checked={trustDevice}
                onChange={(event) => setTrustDevice(event.target.checked)}
              />
              {t('trust_device', 'Confiar neste dispositivo por {days} dias').replace(
                '{days}',
                String(trustedDeviceDays),
              )}
            </label>
          )}
          <button type="submit" className={`mt-6 ${buttonClass}`}>
            {t('submit', 'Verificar')}
          </button>
        </form>
      )}

      {remainingMethods.map((method) => (
        <section key={method.id} className="mt-6">
          <h2 className="text-sm font-semibold text-gray-900">{method.label}</h2>
          {method.requiresBegin && !method.started ? (
            <form method="POST" action={method.beginUrl} className="mt-3">
              <input type="hidden" name="_csrf" value={csrfToken} />
              <button type="submit" className={secondaryButtonClass}>
                {t('start', 'Iniciar verificação')}
              </button>
            </form>
          ) : (
            <form method="POST" action={method.verifyUrl} className="mt-3 space-y-3">
              <input type="hidden" name="_csrf" value={csrfToken} />
              {(method.fields ?? []).map((field) => (
                <div key={field.name}>
                  <label
                    htmlFor={`custom-${method.id}-${field.name}`}
                    className="mb-1 block text-sm font-medium text-gray-700"
                  >
                    {field.label}
                  </label>
                  <input
                    id={`custom-${method.id}-${field.name}`}
                    name={field.name}
                    type={field.type ?? 'text'}
                    inputMode={field.inputMode ?? 'text'}
                    autoComplete={field.autoComplete ?? 'off'}
                    className={inputClass}
                  />
                </div>
              ))}
              <button type="submit" className={buttonClass}>
                {t('submit', 'Verificar')}
              </button>
            </form>
          )}
        </section>
      ))}

      {showPasskey && (
        <div className="mt-4">
          <form ref={passkeyForm} method="POST" action={`/auth/interaction/${uid}/passkey/verify`}>
            <input type="hidden" name="_csrf" value={csrfToken} />
            <input ref={passkeyResponse} type="hidden" name="response" />
            <input type="hidden" name="trustDevice" value={trustDevice ? 'on' : ''} />
            <button
              type="button"
              onClick={authenticatePasskey}
              disabled={passkeyPending}
              aria-busy={passkeyPending}
              className={secondaryButtonClass}
            >
              {t('passkey_button', 'Usar passkey')}
            </button>
          </form>
          {passkeyError && (
            <p className="mt-3 text-sm text-red-600" role="alert">
              {t('passkey_error', 'Não foi possível autenticar com a passkey. Tente novamente.')}
            </p>
          )}
        </div>
      )}

      {showTotp && (
        <details className="mt-6 text-sm text-gray-600">
          <summary className="cursor-pointer hover:underline">
            {t('recovery_summary', 'Usar um código de recuperação')}
          </summary>
          <form method="POST" action={`/auth/interaction/${uid}/mfa`} className="mt-3">
            <input type="hidden" name="_csrf" value={csrfToken} />
            <label htmlFor="recovery-code" className="mb-1 block text-sm font-medium text-gray-700">
              {t('recovery_summary', 'Usar um código de recuperação')}
            </label>
            <input
              id="recovery-code"
              name="recoveryCode"
              autoComplete="off"
              placeholder="xxxxx-xxxxx"
              className={inputClass}
            />
            <button type="submit" className={`mt-3 ${secondaryButtonClass}`}>
              {t('recovery_submit', 'Entrar com código de recuperação')}
            </button>
          </form>
        </details>
      )}
    </AuthShell>
  );
}
