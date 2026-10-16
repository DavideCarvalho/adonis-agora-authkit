import type Configure from '@adonisjs/core/commands/configure';
import { stubsRoot } from '../stubs/main.js';

export async function configure(command: Configure) {
  const codemods = await command.createCodemods();
  await codemods.makeUsingStub(stubsRoot, 'config/authkit_client.stub', {});
  await codemods.makeUsingStub(stubsRoot, 'controllers/oidc_session_controller.stub', {});
  await codemods.updateRcFile((rc) =>
    rc.addProvider('@adonis-agora/authkit-client/authkit_client_provider'),
  );
  await codemods.registerMiddleware('router', [
    { path: '@adonis-agora/authkit-client/authkit_middleware' },
  ]);
  await codemods.defineEnvValidations({
    leadingComment: 'Variáveis do @adonis-agora/authkit-client (OIDC client)',
    variables: {
      AUTHKIT_ISSUER: `Env.schema.string({ format: 'url', tld: false })`,
      AUTHKIT_CLIENT_ID: 'Env.schema.string()',
      AUTHKIT_CLIENT_SECRET: 'Env.schema.string.optional()',
      AUTHKIT_REDIRECT_URI: `Env.schema.string({ format: 'url', tld: false })`,
    },
  });

  // As rotas não são registradas pelo configure. O caminho é o `registerOidcClient`
  // (startSession/endSession, RP-initiated logout, back-channel); o controller
  // ejetado acima existe só para quem precisa customizar o fluxo.
  command.logger.info(
    'Registre as rotas de sessão em start/routes.ts com registerOidcClient(router) ' +
      "(import { registerOidcClient } from '@adonis-agora/authkit-client'). " +
      'O app/controllers/oidc_session_controller.ts publicado é só para customizar o fluxo.',
  );
}
