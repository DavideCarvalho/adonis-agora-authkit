import { useCallback } from 'react';
import { useAuthkitConfig } from '../config.js';
import { jsonRequest, type ResourceState, useResource } from './use_resource.js';

export interface AuthSession {
  id: string;
  device?: string;
  ip?: string;
  lastSeenAt?: string;
  current?: boolean;
  [key: string]: unknown;
}

export interface UseSessionsResult extends ResourceState<AuthSession[]> {
  actions: {
    refetch(): Promise<void>;
    /** revoga uma sessão/dispositivo confiável (POST `${sessions}/:id/revoke`) */
    revoke(id: string): Promise<void>;
  };
}

/**
 * Lista as sessões/dispositivos confiáveis do usuário (GET no endpoint
 * `sessions`) e expõe `revoke`.
 */
export function useSessions(): UseSessionsResult {
  const config = useAuthkitConfig();
  const { data, loading, error, refetch } = useResource<AuthSession[]>(
    config.endpoints.sessions,
    config.csrfToken,
  );

  const revoke = useCallback(
    async (id: string) => {
      await jsonRequest(`${config.endpoints.sessions}/${encodeURIComponent(id)}/revoke`, {
        method: 'POST',
        csrfToken: config.csrfToken,
      });
      await refetch();
    },
    [config.endpoints.sessions, config.csrfToken, refetch],
  );

  return { data, loading, error, actions: { refetch, revoke } };
}
