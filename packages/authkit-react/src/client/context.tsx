/**
 * Contexto React que distribui o `AuthkitClient` para hooks de query/mutation.
 *
 * Uso mínimo (browser com window.__AUTHKIT__):
 * ```tsx
 * <QueryClientProvider client={queryClient}>
 *   <AuthkitClientProvider>
 *     <App />
 *   </AuthkitClientProvider>
 * </QueryClientProvider>
 * ```
 *
 * Com opções explícitas (SSR / testes):
 * ```tsx
 * const client = createAuthkitClient({ baseUrl: '/admin/api', csrfToken: token })
 * <AuthkitClientProvider client={client}>
 *   <App />
 * </AuthkitClientProvider>
 * ```
 *
 * Helper para criar um QueryClient pré-configurado para o AuthKit:
 * ```ts
 * const queryClient = createAuthkitQueryClient()
 * ```
 */

import { QueryClient } from '@tanstack/react-query';
import { createContext, createElement, type ReactNode, useContext } from 'react';
import { type AuthkitClient, type AuthkitClientOptions, createAuthkitClient } from './client.js';

// ---------------------------------------------------------------------------
// Contexto
// ---------------------------------------------------------------------------

const AuthkitClientContext = createContext<AuthkitClient | null>(null);

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Lê o `AuthkitClient` do contexto.
 * Lança erro descritivo se chamado fora de `<AuthkitClientProvider>`.
 */
export function useAuthkitClient(): AuthkitClient {
  const client = useContext(AuthkitClientContext);
  if (!client) {
    throw new Error(
      '[AuthkitClient] useAuthkitClient() chamado fora de <AuthkitClientProvider>. ' +
        'Envolva sua árvore com <AuthkitClientProvider>.',
    );
  }
  return client;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface AuthkitClientProviderProps {
  /**
   * Instância do client. Se omitida, o provider cria uma com `createAuthkitClient(opts)`.
   * Passe uma instância explícita em testes ou topologias custom.
   */
  client?: AuthkitClient;
  /**
   * Opções passadas para `createAuthkitClient()` quando `client` não é fornecido.
   * Ignorado quando `client` é fornecido.
   */
  opts?: AuthkitClientOptions;
  children: ReactNode;
}

/**
 * Provider que injeta o `AuthkitClient` na árvore React.
 *
 * Deve ser aninhado DENTRO de `<QueryClientProvider>` (o host é responsável por
 * criar e prover o `QueryClient`). Use `createAuthkitQueryClient()` para obter
 * um `QueryClient` com configuração recomendada para o AuthKit.
 */
export function AuthkitClientProvider({ client, opts, children }: AuthkitClientProviderProps) {
  const resolved = client ?? createAuthkitClient(opts);
  return createElement(AuthkitClientContext.Provider, { value: resolved }, children);
}

// ---------------------------------------------------------------------------
// Helper: QueryClient pré-configurado
// ---------------------------------------------------------------------------

/**
 * Cria um `QueryClient` com configuração recomendada para o AuthKit:
 * - `staleTime: 30s` — dados ficam frescos por 30 segundos
 * - `gcTime: 5min` — garbage collection após 5 minutos sem subscribers
 * - `retry: 1` — uma re-tentativa em caso de erro
 * - `refetchOnWindowFocus: false` — sem refetch automático ao focar a janela
 *
 * Você pode trazer seu próprio `QueryClient` — este helper é puramente
 * opcional/conveniente.
 */
export function createAuthkitQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  });
}
