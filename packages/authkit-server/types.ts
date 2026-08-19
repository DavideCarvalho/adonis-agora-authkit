import type { MetricsRecorder } from '@adonis-agora/authkit-core';
import type { AccountStore } from './src/accounts/account_store.js';
import type { PatStore } from './src/pat/pat_store.js';
import type { OidcService } from './src/provider/oidc_service.js';

/**
 * FONTE ÚNICA dos bindings de container do authkit-server.
 *
 * Este bloco morava DUPLICADO dentro de `providers/authkit_server_provider.ts`,
 * enquanto este arquivo declarava só `authkit.server`. Como o provider é o que
 * todo host registra no `adonisrc.ts`, era a cópia DELE que tipava os apps — e
 * esta, exposta pelo subpath `./types`, era uma visão parcial: `authkit.metrics`,
 * `authkit.accountStore` e `authkit.patStore` davam TS2339 por ela.
 *
 * Duas tabelas de bindings sem nada conferindo que concordam é a mesma classe de
 * defeito que deixou cinco eventos de auditoria fora da união. Agora existe uma
 * só, e o provider a alcança com um `import '../types.js'` — que por isso NÃO é
 * redundante: é o que mantém os hosts tipados.
 */
declare module '@adonisjs/core/types' {
  interface ContainerBindings {
    'authkit.server': OidcService;
    'authkit.metrics': MetricsRecorder;
    'authkit.accountStore': AccountStore;
    'authkit.patStore': PatStore;
  }
}

export type { OidcService, MetricsRecorder, AccountStore, PatStore };
