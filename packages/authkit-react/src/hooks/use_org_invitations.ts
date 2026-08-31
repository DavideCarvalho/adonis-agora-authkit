import { useCallback } from 'react';
import { useAuthkitConfig } from '../config.js';
import { jsonRequest, type ResourceState, useResource } from './use_resource.js';

export interface OrgInvitationEntry {
  id: string;
  organizationId: string;
  orgName: string;
  orgSlug: string;
  email: string;
  role: string;
  expiresAt: string;
  createdAt: string;
  [key: string]: unknown;
}

export interface UseOrgInvitationsResult extends ResourceState<OrgInvitationEntry[]> {
  actions: {
    refetch(): Promise<void>;
    /** Aceita um convite (POST /account/orgs/invitations/:token/accept). */
    accept(token: string): Promise<void>;
  };
}

interface InvitationsResponse {
  invitations: OrgInvitationEntry[];
}

/**
 * Lista os convites de org pendentes para o e-mail do usuário logado.
 * Consome `GET /account/orgs/invitations/json`.
 */
export function useOrgInvitations(): UseOrgInvitationsResult {
  const config = useAuthkitConfig();
  const { data, loading, error, refetch } = useResource<InvitationsResponse>(
    config.endpoints.orgInvitations,
    config.csrfToken,
  );

  const accept = useCallback(
    async (token: string) => {
      await jsonRequest(`/account/orgs/invitations/${encodeURIComponent(token)}/accept`, {
        method: 'POST',
        csrfToken: config.csrfToken,
      });
      await refetch();
    },
    [config.csrfToken, refetch],
  );

  return {
    data: data?.invitations ?? null,
    loading,
    error,
    actions: { refetch, accept },
  };
}
