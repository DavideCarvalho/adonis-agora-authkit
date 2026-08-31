import { useCallback } from 'react';
import { useAuthkitConfig } from '../config.js';
import { jsonRequest, type ResourceState, useResource } from './use_resource.js';

export interface AuthorizedApp {
  clientId: string;
  name?: string;
  logoUrl?: string;
  scopes?: string[];
  authorizedAt?: string;
  [key: string]: unknown;
}

export interface UseAuthorizedAppsResult extends ResourceState<AuthorizedApp[]> {
  actions: {
    refetch(): Promise<void>;
    /** revoga o consentimento de um app (POST `${apps}/:clientId/revoke`) */
    revoke(clientId: string): Promise<void>;
  };
}

/**
 * Lista os apps OAuth/OIDC autorizados pelo usuário (GET no endpoint `apps`)
 * e expõe `revoke`.
 */
export function useAuthorizedApps(): UseAuthorizedAppsResult {
  const config = useAuthkitConfig();
  const { data, loading, error, refetch } = useResource<AuthorizedApp[]>(
    config.endpoints.apps,
    config.csrfToken,
  );

  const revoke = useCallback(
    async (clientId: string) => {
      await jsonRequest(`${config.endpoints.apps}/${encodeURIComponent(clientId)}/revoke`, {
        method: 'POST',
        csrfToken: config.csrfToken,
      });
      await refetch();
    },
    [config.endpoints.apps, config.csrfToken, refetch],
  );

  return { data, loading, error, actions: { refetch, revoke } };
}
