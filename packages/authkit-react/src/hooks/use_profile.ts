import { useCallback, useState } from 'react';
import { useAuthkitConfig } from '../config.js';
import type { AuthUser } from '../types.js';
import { useAuth } from '../use_auth.js';
import { jsonRequest, type ResourceState } from './use_resource.js';

export interface ProfileUpdate {
  name?: string;
  avatarUrl?: string;
  [key: string]: unknown;
}

export interface UseProfileResult extends ResourceState<AuthUser> {
  actions: {
    /** atualiza o perfil (POST no endpoint `profile`) */
    update(data: ProfileUpdate): Promise<void>;
  };
}

/**
 * Hook de perfil. Os dados iniciais vêm do `useAuth()` (shared-prop), e
 * `actions.update` faz POST no endpoint `profile` configurado.
 * `loading` reflete a mutação em curso.
 */
export function useProfile(): UseProfileResult {
  const config = useAuthkitConfig();
  const { user } = useAuth();
  const [state, setState] = useState<ResourceState<AuthUser>>({
    data: user,
    loading: false,
    error: null,
  });

  const update = useCallback(
    async (data: ProfileUpdate) => {
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const updated = await jsonRequest<AuthUser>(config.endpoints.profile, {
          method: 'POST',
          body: JSON.stringify(data),
          csrfToken: config.csrfToken,
        });
        setState({
          data: updated ?? { ...(user as AuthUser), ...data },
          loading: false,
          error: null,
        });
      } catch (err) {
        setState((s) => ({ ...s, loading: false, error: err as Error }));
      }
    },
    [config.endpoints.profile, config.csrfToken, user],
  );

  return { ...state, actions: { update } };
}
