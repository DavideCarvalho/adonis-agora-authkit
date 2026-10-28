import React, { useState } from 'react';
import { type SettingSection, SettingsSectionContainer } from '../containers/settings.containers';

// Seções plugadas nas settings REAIS de `auth_settings` (SETTING_KEYS). Cada seção é
// uma setting estruturada; os campos mapeiam para os fields do objeto. Quando a key
// está travada via defineConfig, a seção mostra "definido via config" e fica read-only.
const SETTING_SECTIONS: SettingSection[] = [
  {
    title: 'Métodos de login',
    description:
      'Quais métodos a tela de login oferece. Travável via defineConfig({ authMethods }).',
    settingKey: 'auth_methods',
    fields: [
      {
        field: 'password',
        label: 'Senha',
        description: 'Login por e-mail + senha',
        type: 'boolean',
        defaultValue: true,
      },
      {
        field: 'magicLink',
        label: 'Magic link',
        description: 'Login por link enviado no e-mail (requer mail + passwordless.magicLink)',
        type: 'boolean',
        defaultValue: false,
      },
      {
        field: 'passkey',
        label: 'Passkey',
        description: 'Entrar com passkey (WebAuthn) antes da senha',
        type: 'boolean',
        defaultValue: false,
      },
      {
        field: 'forgotPassword',
        label: 'Esqueci a senha',
        description: 'Link de reset (só aparece com senha ligada)',
        type: 'boolean',
        defaultValue: true,
      },
      {
        field: 'passkeyAutofill',
        label: 'Autofill de passkey',
        description: 'Sugestões de passkey no input de e-mail (conditional mediation)',
        type: 'boolean',
        defaultValue: true,
      },
    ],
  },
  {
    title: 'Cadastro',
    description: 'Cadastro público (self-service).',
    settingKey: 'registration',
    fields: [
      {
        field: 'enabled',
        label: 'Permitir cadastro',
        description: 'Novos usuários podem se cadastrar sozinhos',
        type: 'boolean',
        defaultValue: true,
      },
    ],
  },
  {
    title: 'Verificação de e-mail',
    description: 'Exigir e-mail verificado para logar.',
    settingKey: 'require_verified_email',
    fields: [
      {
        field: 'enabled',
        label: 'Exigir e-mail verificado',
        description: 'Bloqueia login de contas com e-mail não verificado',
        type: 'boolean',
        defaultValue: false,
      },
      {
        field: 'graceDays',
        label: 'Dias de graça',
        description: 'Permite login não-verificado por N dias após o cadastro (0 = sem graça)',
        type: 'number',
        defaultValue: 0,
      },
    ],
  },
  {
    title: 'Manutenção',
    description: 'Modo manutenção — bloqueia login de contas comuns (admin segue entrando).',
    settingKey: 'maintenance_mode',
    fields: [
      {
        field: 'enabled',
        label: 'Modo manutenção',
        description: 'Telas de login/signup mostram página de manutenção',
        type: 'boolean',
        defaultValue: false,
      },
      {
        field: 'message',
        label: 'Mensagem',
        description: 'Texto exibido na página de manutenção (vazio = default)',
        type: 'string',
        defaultValue: '',
      },
    ],
  },
  {
    title: 'Bloqueio por falha (lockout)',
    description: 'Trava a conta após tentativas de login falhas.',
    settingKey: 'lockout',
    fields: [
      {
        field: 'enabled',
        label: 'Ligar lockout',
        description: 'Trava a conta após muitas falhas de senha',
        type: 'boolean',
        defaultValue: false,
      },
      {
        field: 'maxAttempts',
        label: 'Máx. tentativas',
        description: 'Falhas antes de travar',
        type: 'number',
        defaultValue: 5,
      },
      {
        field: 'windowSec',
        label: 'Janela (s)',
        description: 'Janela em que as falhas contam',
        type: 'number',
        defaultValue: 900,
      },
      {
        field: 'baseLockoutSec',
        label: 'Trava base (s)',
        description: 'Duração inicial da trava (backoff exponencial)',
        type: 'number',
        defaultValue: 60,
      },
      {
        field: 'maxLockoutSec',
        label: 'Trava máx. (s)',
        description: 'Teto da duração da trava',
        type: 'number',
        defaultValue: 3600,
      },
    ],
  },
  {
    title: 'Login social: 2º fator',
    description:
      'Quando o "Continuar com Google" pede o 2º fator da conta. Travável via defineConfig({ social: { secondFactor } }).',
    settingKey: 'social_second_factor',
    fields: [
      {
        field: 'policy',
        label: 'Política',
        description: 'Para quem não tem um dos papéis abaixo',
        type: 'select',
        options: [
          { value: 'enrolled', label: 'Pedir se a conta tem fator cadastrado' },
          { value: 'required', label: 'Sempre exigir' },
          { value: 'never', label: 'Confiar só no provider' },
        ],
        defaultValue: 'enrolled',
      },
      {
        field: 'requiredRoles',
        label: 'Papéis que sempre exigem',
        description:
          'Separados por vírgula. Conta sem fator cadastrado com esses papéis precisa cadastrar antes de entrar pelo Google.',
        type: 'list',
        defaultValue: [],
      },
    ],
  },
  {
    title: 'TTL dos tokens',
    description: 'Tempo de vida dos tokens OIDC (segundos).',
    settingKey: 'token_ttl',
    fields: [
      {
        field: 'accessTokenSec',
        label: 'Access token (s)',
        description: 'Validade do access token',
        type: 'number',
        defaultValue: 3600,
      },
      {
        field: 'idTokenSec',
        label: 'ID token (s)',
        description: 'Validade do ID token',
        type: 'number',
        defaultValue: 3600,
      },
      {
        field: 'refreshTokenSec',
        label: 'Refresh token (s)',
        description: 'Validade do refresh token',
        type: 'number',
        defaultValue: 2592000,
      },
    ],
  },
];

export function Settings() {
  const [unavailable, setUnavailable] = useState(false);

  if (unavailable) {
    return (
      <div>
        <div className="page-title" style={{ marginBottom: 8 }}>
          Settings
        </div>
        <div className="error-box">
          Runtime settings exigem a tabela <code>auth_settings</code>. Rode a migration para
          habilitar.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <div className="page-title">Settings</div>
        <div className="page-sub">
          Configuração de runtime — mudanças valem na hora. Settings definidas no{' '}
          <code>defineConfig()</code> ficam travadas (config &gt; runtime).
        </div>
      </div>

      {SETTING_SECTIONS.map((section) => (
        <SettingsSectionContainer
          key={section.settingKey}
          section={section}
          onUnavailable={() => setUnavailable(true)}
        />
      ))}
    </div>
  );
}
