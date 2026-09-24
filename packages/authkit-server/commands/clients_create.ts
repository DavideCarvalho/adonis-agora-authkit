import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';

/**
 * Cria um client OIDC no adapter/DB via {@link AdminClientsService}. O client fica
 * disponível em runtime imediatamente, sem necessidade de redeploy. Para clients
 * confidenciais, o secret é gerado aleatoriamente e impresso UMA ÚNICA VEZ — não é
 * recuperável depois.
 *
 * Exemplos:
 *   node ace authkit:clients:create --client-id=my-spa --redirect-uri=https://app/cb --public
 *   node ace authkit:clients:create --client-id=my-api --redirect-uri=https://api/cb --redirect-uri=https://api/cb2 --grant=client_credentials
 *   node ace authkit:clients:create --redirect-uri=https://app/cb --json
 *   node ace authkit:clients:create --client-id=my-mobile --native --redirect-uri=com.example.app:/oauth
 */
export default class AuthkitClientsCreate extends BaseCommand {
  static commandName = 'authkit:clients:create';
  static description =
    'Cria um client OIDC no adapter/DB em runtime (sem redeploy). O secret é impresso uma vez.';

  static help = [
    'Cria um client OIDC persistido no adapter via AdminClientsService, o mesmo',
    'caminho usado pelo console admin e pelo registro dinâmico (RFC 7591).',
    '',
    'Para clients confidenciais (default), um secret aleatório é gerado e',
    'impresso UMA ÚNICA VEZ no terminal — armazene-o imediatamente.',
    '',
    'Flags repetíveis (--flag=v1 --flag=v2):',
    '  --redirect-uri      URI(s) de callback do client (obrigatório).',
    '  --post-logout-uri   URI(s) de post-logout redirect.',
    '  --grant             Grant types. Default: authorization_code + refresh_token.',
    '',
    'App nativo (React Native/Expo, iOS, Android, desktop — RFC 8252): use --native.',
    'Implica client público (sem secret; PKCE já é obrigatório) e aceita redirect de',
    'esquema privado (com.example.app:/oauth), https claimed e loopback http://127.0.0.1.',
    '',
    'Exemplos:',
    '  node ace authkit:clients:create --client-id=my-spa --redirect-uri=https://app/cb --public',
    '  node ace authkit:clients:create --redirect-uri=https://app/cb --backchannel-logout-uri=https://app/bc',
    '  node ace authkit:clients:create --client-id=my-app --redirect-uri=https://a/cb --redirect-uri=https://b/cb --json',
    '  node ace authkit:clients:create --client-id=my-mobile --native --redirect-uri=com.example.app:/oauth',
  ];

  static options: CommandOptions = { startApp: true };

  @flags.string({ description: 'client_id desejado. Omitir gera um UUID aleatório.' })
  declare clientId?: string;

  @flags.array({ description: 'redirect_uri(s) permitidas (repetível). Obrigatório.' })
  declare redirectUri?: string[];

  @flags.array({ description: 'post_logout_redirect_uri(s) permitidas (repetível).' })
  declare postLogoutUri?: string[];

  @flags.array({
    description: 'Grant types (repetível). Default: authorization_code + refresh_token.',
  })
  declare grant?: string[];

  @flags.boolean({
    description:
      'Cria um client público (sem secret; token_endpoint_auth_method=none). Default: false (confidencial).',
  })
  declare public?: boolean;

  @flags.boolean({
    description:
      'Client de app nativo (application_type=native, RFC 8252): aceita redirect de esquema privado/loopback. Implica --public.',
  })
  declare native?: boolean;

  @flags.string({
    description: 'Endpoint de OIDC Back-Channel Logout do RP (POST de logout_token).',
  })
  declare backchannelLogoutUri?: string;

  @flags.boolean({
    description: 'Output em JSON machine-readable (inclui clientId e clientSecret).',
  })
  declare json?: boolean;

  async run() {
    const redirectUris = this.redirectUri ?? [];
    if (redirectUris.length === 0) {
      this.logger.logError('❌ --redirect-uri é obrigatório. Passe ao menos uma URI de callback.');
      this.exitCode = 1;
      return;
    }

    const service = await this.app.container.make('authkit.server');
    const { AdminClientsService } = await import('../src/host/admin_clients_service.js');
    const svc = new AdminClientsService(service);

    const grantTypes =
      this.grant && this.grant.length > 0 ? this.grant : ['authorization_code', 'refresh_token'];

    // App nativo é sempre público (RFC 8252 §8.5): `--native` implica `--public`.
    const isPublic = !!this.public || !!this.native;
    const applicationType = this.native ? ('native' as const) : ('web' as const);
    const tokenEndpointAuthMethod = isPublic ? ('none' as const) : ('client_secret_basic' as const);

    const { ClientMetadataError } = await import('../src/host/client_metadata.js');
    let created: Awaited<ReturnType<typeof svc.create>>;
    try {
      created = await svc.create({
        clientId: this.clientId,
        applicationType,
        redirectUris,
        postLogoutRedirectUris: this.postLogoutUri ?? [],
        grantTypes,
        tokenEndpointAuthMethod,
        backchannelLogoutUri: this.backchannelLogoutUri,
      });
    } catch (err) {
      if (err instanceof ClientMetadataError) {
        this.logger.logError(`❌ ${err.message}`);
        this.exitCode = 1;
        return;
      }
      throw err;
    }

    if (this.json) {
      const out: Record<string, unknown> = {
        clientId: created.clientId,
        redirectUris,
        postLogoutRedirectUris: this.postLogoutUri ?? [],
        grantTypes,
        tokenEndpointAuthMethod,
        applicationType,
        confidential: !isPublic,
      };
      if (created.clientSecret) out.clientSecret = created.clientSecret;
      if (this.backchannelLogoutUri) out.backchannelLogoutUri = this.backchannelLogoutUri;
      this.logger.info(JSON.stringify(out, null, 2));
      return;
    }

    this.logger.success(`Client criado: ${created.clientId}`);
    this.logger.info(`  redirect_uris: ${redirectUris.join(', ')}`);
    this.logger.info(`  grant_types:   ${grantTypes.join(', ')}`);
    this.logger.info(`  type:          ${isPublic ? 'publico (sem secret)' : 'confidencial'}`);
    if (this.native) this.logger.info('  application:   native (RFC 8252)');
    if (this.backchannelLogoutUri) {
      this.logger.info(`  backchannel:   ${this.backchannelLogoutUri}`);
    }

    if (created.clientSecret) {
      this.logger.info('');
      this.logger.success('CLIENT SECRET (mostrado UMA vez - armazene agora):');
      this.logger.success(`  ${created.clientSecret}`);
      this.logger.info('');
    }
  }
}
