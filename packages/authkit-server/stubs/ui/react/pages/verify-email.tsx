{
  exports({ to: app.makePath('inertia/pages/authkit/verify-email.tsx') });
}

import AuthShell from '../../components/auth_shell';

export default function AuthkitVerifyEmail({ verified }: { verified?: boolean }) {
  if (verified) {
    return (
      <AuthShell>
        <h1 className="text-xl font-semibold text-gray-900">E-mail verificado</h1>
        <p className="mt-2 text-sm text-gray-600">Seu e-mail foi confirmado com sucesso.</p>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <h1 className="text-xl font-semibold text-gray-900">Link inválido</h1>
      <p className="mt-2 text-sm text-gray-600">
        O link de verificação é inválido ou já foi utilizado.
      </p>
    </AuthShell>
  );
}
