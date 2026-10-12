import {
  type AuthkitClientError,
  authkitKeys,
  type PersonalAgentEntry,
  type PersonalAgentProtocol,
  type PersonalAgentsOverview,
  usePersonalAgentConnectionsQueryOptions,
  usePersonalAgentsQueryOptions,
  useRemovePersonalAgentEntryMutationOptions,
  useRevokePersonalAgentConnectionMutationOptions,
  useSetPersonalAgentStatusMutationOptions,
} from '@adonis-agora/authkit-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import { Modal } from '../components/Modal';
import { Pagination } from '../components/Pagination';
import { QueryBoundary } from '../components/QueryBoundary';
import { SkeletonPanelTable } from '../components/Skeleton';
import { getConfig } from '../lib/config';
import { useToast } from '../lib/toast';

const PAGE_SIZE = 20;

const PROTOCOL_LABEL: Record<PersonalAgentProtocol, string> = { pact: 'PACT', poppy: 'Poppy' };

function isNotConfigured(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'status' in error && error.status === 404;
}

/**
 * Ações destrutivas pedem sudo: sem ele, manda o admin confirmar a identidade e
 * voltar para esta mesma tela.
 */
function useActionError() {
  const toast = useToast();
  return (err: unknown) => {
    const code = (err as AuthkitClientError | null)?.code;
    if (code === 'sudo_required') {
      const back = window.location.pathname + window.location.search;
      window.location.href = `${getConfig().endpoints.confirm ?? '/account/confirm'}?return_to=${encodeURIComponent(back)}`;
      return;
    }
    toast.error(err instanceof Error ? err.message : String(err));
  };
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: authkitKeys.admin.personalAgents() });
}

function StatusBadges({ agent }: { agent: PersonalAgentEntry }) {
  const effective =
    agent.effective === 'blocked' ? (
      <span className="badge badge-red">blocked</span>
    ) : agent.effective === 'allowed' ? (
      <span className="badge badge-green">allowed</span>
    ) : (
      <span className="badge badge-muted">not listed</span>
    );
  const sources = [
    agent.config && `config: ${agent.config}`,
    agent.console && `console: ${agent.console.status}`,
  ].filter(Boolean);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-start' }}>
      {effective}
      {sources.length > 0 && (
        <span style={{ fontSize: 11, color: 'var(--faint)' }}>{sources.join(' · ')}</span>
      )}
    </div>
  );
}

function protocolPolicy(overview: PersonalAgentsOverview): string[] {
  const lines: string[] = [];
  const { pact, poppy } = overview.protocols;
  if (pact) {
    lines.push(
      pact.open
        ? 'PACT: open — any agent publishing a JWKS via OIDC discovery is accepted, except blocked ones.'
        : 'PACT: only listed agents are accepted.',
    );
  }
  if (poppy) {
    lines.push(
      poppy.requireRegistration
        ? 'Poppy: registration required — only listed agents can start sessions.'
        : 'Poppy: any agent with a valid client_id can start sessions, except blocked ones.',
    );
  }
  if (pact?.hostResolver || poppy?.hostResolver) {
    lines.push('Part of the list comes from a host function and is not shown here.');
  }
  return lines;
}

interface AgentsTableProps {
  onShowConnections: (agent: PersonalAgentEntry) => void;
}

export function PersonalAgentsContainer({ onShowConnections }: AgentsTableProps) {
  const { data, isLoading, error, refetch } = useQuery({
    ...usePersonalAgentsQueryOptions(),
    retry: (n: number, err: unknown) => !isNotConfigured(err) && n < 1,
  });
  const setStatus = useMutation(useSetPersonalAgentStatusMutationOptions());
  const removeEntry = useMutation(useRemovePersonalAgentEntryMutationOptions());
  const toast = useToast();
  const onError = useActionError();
  const invalidate = useInvalidate();
  const [adding, setAdding] = useState(false);

  if (isNotConfigured(error)) {
    return (
      <div className="error-box">
        Personal agents are not configured. Add <code>personalAgents</code> (PACT and/or{' '}
        <code>poppy</code>) to <code>defineConfig</code>.
      </div>
    );
  }

  async function block(agent: PersonalAgentEntry) {
    if (
      !confirm(
        `Block ${agent.name}? Every account connected to it is disconnected now (${agent.connections}), and it cannot connect again until unblocked.`,
      )
    )
      return;
    try {
      const res = await setStatus.mutateAsync({
        protocol: agent.protocol,
        identifier: agent.identifier,
        status: 'blocked',
        name: agent.console ? undefined : agent.name,
        jwksUri: agent.jwksUri ?? undefined,
      });
      toast.success(`Blocked — ${res.disconnected} connection(s) revoked`);
      invalidate();
    } catch (err) {
      onError(err);
    }
  }

  async function allow(agent: PersonalAgentEntry) {
    if (agent.protocol === 'pact' && !agent.jwksUri) {
      setAdding(true);
      return;
    }
    try {
      await setStatus.mutateAsync({
        protocol: agent.protocol,
        identifier: agent.identifier,
        status: 'allowed',
        jwksUri: agent.jwksUri ?? undefined,
      });
      toast.success('Agent allowed');
      invalidate();
    } catch (err) {
      onError(err);
    }
  }

  async function remove(agent: PersonalAgentEntry) {
    if (!agent.console) return;
    const what = agent.console.status === 'blocked' ? 'Unblock' : 'Remove from the allowlist';
    if (!confirm(`${what}: ${agent.name}?`)) return;
    try {
      await removeEntry.mutateAsync(agent.console.id);
      toast.success(agent.console.status === 'blocked' ? 'Unblocked' : 'Removed');
      invalidate();
    } catch (err) {
      onError(err);
    }
  }

  const busy = setStatus.isPending || removeEntry.isPending;

  return (
    <QueryBoundary
      isLoading={isLoading}
      error={error}
      onRetry={refetch}
      skeleton={<SkeletonPanelTable rows={4} cols={5} />}
    >
      {data && (
        <>
          <div className="panel" style={{ marginBottom: 16 }}>
            <div
              className="panel-body"
              style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}
            >
              <div style={{ flex: 1, fontSize: 12, color: 'var(--muted)', lineHeight: 1.7 }}>
                {protocolPolicy(data).map((line) => (
                  <div key={line}>{line}</div>
                ))}
              </div>
              <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
                Add agent
              </button>
            </div>
          </div>

          <div className="panel" style={{ marginBottom: 24 }}>
            {data.agents.length === 0 ? (
              <div className="empty-state">
                <h4>No personal agents yet</h4>
                <p>Agents show up here once listed or once someone connects one.</p>
              </div>
            ) : (
              <div className="tbl-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th>Protocol</th>
                      <th>Status</th>
                      <th>Connections</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.agents.map((agent) => {
                      const configBlocked = agent.config === 'blocked';
                      const consoleBlocked = agent.console?.status === 'blocked';
                      return (
                        <tr key={`${agent.protocol} ${agent.identifier}`}>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              <span style={{ fontSize: 12, fontWeight: 500 }}>{agent.name}</span>
                              <span className="mono text-sm" style={{ color: 'var(--faint)' }}>
                                {agent.identifier}
                              </span>
                            </div>
                          </td>
                          <td>
                            <span className="badge badge-muted">
                              {PROTOCOL_LABEL[agent.protocol]}
                            </span>
                          </td>
                          <td>
                            <StatusBadges agent={agent} />
                          </td>
                          <td>
                            {agent.connections > 0 ? (
                              <button
                                className="btn btn-ghost btn-sm"
                                onClick={() => onShowConnections(agent)}
                              >
                                {agent.connections}
                              </button>
                            ) : (
                              <span style={{ color: 'var(--faint)' }}>0</span>
                            )}
                          </td>
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {agent.console && (
                              <button
                                className="btn btn-ghost btn-sm"
                                disabled={busy}
                                onClick={() => remove(agent)}
                              >
                                {consoleBlocked ? 'Unblock' : 'Remove'}
                              </button>
                            )}
                            {agent.effective === 'unlisted' && (
                              <button
                                className="btn btn-ghost btn-sm"
                                disabled={busy}
                                onClick={() => allow(agent)}
                              >
                                Allow
                              </button>
                            )}
                            {!configBlocked && !consoleBlocked && (
                              <button
                                className="btn btn-danger btn-sm"
                                disabled={busy}
                                onClick={() => block(agent)}
                              >
                                Block
                              </button>
                            )}
                            {configBlocked && (
                              <span
                                style={{ fontSize: 11, color: 'var(--faint)' }}
                                title="Blocked in defineConfig — change it there."
                              >
                                locked by config
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <AddAgentModal
            open={adding}
            onClose={() => setAdding(false)}
            protocols={(['pact', 'poppy'] as const).filter((p) => data.protocols[p] !== null)}
            allowHttp={!!data.protocols.poppy?.allowInsecureClientIds}
          />
        </>
      )}
    </QueryBoundary>
  );
}

function AddAgentModal({
  open,
  onClose,
  protocols,
  allowHttp,
}: {
  open: boolean;
  onClose: () => void;
  protocols: PersonalAgentProtocol[];
  allowHttp: boolean;
}) {
  const setStatus = useMutation(useSetPersonalAgentStatusMutationOptions());
  const toast = useToast();
  const onError = useActionError();
  const invalidate = useInvalidate();
  const [protocol, setProtocol] = useState<PersonalAgentProtocol>(protocols[0] ?? 'poppy');
  const [identifier, setIdentifier] = useState('');
  const [name, setName] = useState('');
  const [jwksUri, setJwksUri] = useState('');
  const [status, setStatusValue] = useState<'allowed' | 'blocked'>('allowed');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await setStatus.mutateAsync({
        protocol,
        identifier: identifier.trim(),
        status,
        name: name.trim() || undefined,
        jwksUri: protocol === 'pact' ? jwksUri.trim() || undefined : undefined,
      });
      toast.success(
        status === 'blocked'
          ? `Blocked — ${res.disconnected} connection(s) revoked`
          : 'Agent allowed',
      );
      invalidate();
      setIdentifier('');
      setName('');
      setJwksUri('');
      onClose();
    } catch (err) {
      onError(err);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add personal agent"
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className={status === 'blocked' ? 'btn btn-danger' : 'btn btn-primary'}
            form="add-agent-form"
            type="submit"
            disabled={setStatus.isPending || !identifier.trim()}
          >
            {setStatus.isPending ? (
              <span className="spinner sm" />
            ) : status === 'blocked' ? (
              'Block'
            ) : (
              'Allow'
            )}
          </button>
        </>
      }
    >
      <form id="add-agent-form" onSubmit={submit}>
        <div className="field">
          <label>Protocol</label>
          <select
            className="input"
            value={protocol}
            onChange={(e) => setProtocol(e.target.value as PersonalAgentProtocol)}
          >
            {protocols.map((p) => (
              <option key={p} value={p}>
                {PROTOCOL_LABEL[p]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>{protocol === 'poppy' ? 'Client ID (metadata URL)' : 'Issuer (iss)'}</label>
          <input
            className="input input-mono"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder={
              protocol === 'poppy'
                ? `${allowHttp ? 'http(s)' : 'https'}://agent.example/poppy-agent/agent.json`
                : 'https://agent.example'
            }
            required
          />
        </div>
        {protocol === 'pact' && (
          <div className="field">
            <label>JWKS URI {status === 'allowed' ? '(required)' : '(optional)'}</label>
            <input
              className="input input-mono"
              value={jwksUri}
              onChange={(e) => setJwksUri(e.target.value)}
              placeholder="https://agent.example/.well-known/jwks.json"
              required={status === 'allowed'}
            />
          </div>
        )}
        <div className="field">
          <label>Display name (optional)</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label>Status</label>
          <select
            className="input"
            value={status}
            onChange={(e) => setStatusValue(e.target.value === 'blocked' ? 'blocked' : 'allowed')}
          >
            <option value="allowed">Allowed</option>
            <option value="blocked">Blocked (disconnects every account now)</option>
          </select>
        </div>
      </form>
    </Modal>
  );
}

interface ConnectionsProps {
  agent: { protocol: PersonalAgentProtocol; identifier: string; name: string } | null;
  onClearAgent: () => void;
  page: number;
  onPage: (p: number) => void;
}

export function PersonalAgentConnectionsContainer({
  agent,
  onClearAgent,
  page,
  onPage,
}: ConnectionsProps) {
  const params = {
    protocol: agent?.protocol,
    clientId: agent?.identifier,
    page,
    size: PAGE_SIZE,
  };
  const { data, isLoading, error, refetch } = useQuery({
    ...usePersonalAgentConnectionsQueryOptions(params),
    retry: (n: number, err: unknown) => !isNotConfigured(err) && n < 1,
  });
  const revoke = useMutation(useRevokePersonalAgentConnectionMutationOptions());
  const toast = useToast();
  const onError = useActionError();
  const invalidate = useInvalidate();

  if (isNotConfigured(error)) return null;

  async function doRevoke(id: string, who: string, agentName: string) {
    if (!confirm(`Disconnect ${agentName} from ${who}?`)) return;
    try {
      await revoke.mutateAsync(id);
      toast.success('Connection revoked');
      invalidate();
    } catch (err) {
      onError(err);
    }
  }

  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <div>
          <h3>Connections{agent ? ` — ${agent.name}` : ''}</h3>
          <p style={{ marginTop: 2 }}>
            Accounts that signed in to a personal agent. Revoking cuts that agent off the account
            right away.
          </p>
        </div>
        {agent && (
          <button className="btn btn-ghost btn-sm" onClick={onClearAgent}>
            Show all
          </button>
        )}
      </div>
      <div className="panel">
        <QueryBoundary
          isLoading={isLoading}
          error={error}
          onRetry={refetch}
          skeleton={<SkeletonPanelTable rows={5} cols={5} />}
        >
          {data && data.data.length === 0 ? (
            <div className="empty-state">
              <h4>No connections</h4>
              <p>No account is connected to a personal agent.</p>
            </div>
          ) : (
            data && (
              <div className="tbl-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th>Agent</th>
                      <th>Scopes</th>
                      <th>Connected</th>
                      <th>Expires</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.data.map((c) => (
                      <tr key={c.id} style={{ cursor: 'default' }}>
                        <td>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            {c.accountEmail && (
                              <span style={{ fontSize: 12, fontWeight: 500 }}>
                                {c.accountEmail}
                              </span>
                            )}
                            <span className="mono text-sm" style={{ color: 'var(--faint)' }}>
                              {c.accountId}
                            </span>
                          </div>
                        </td>
                        <td>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ fontSize: 12 }}>{c.agentName}</span>
                            <span style={{ fontSize: 11, color: 'var(--faint)' }}>
                              {PROTOCOL_LABEL[c.protocol]}
                            </span>
                          </div>
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                            {c.scopes.map((s) => (
                              <span key={s} className="badge badge-muted">
                                {s}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td>
                          <span className="mono text-sm">
                            {new Date(c.createdAt).toLocaleString()}
                          </span>
                        </td>
                        <td>
                          <span className="mono text-sm">
                            {new Date(c.expiresAt).toLocaleDateString()}
                          </span>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <button
                            className="btn btn-danger btn-sm"
                            disabled={revoke.isPending}
                            onClick={() =>
                              doRevoke(c.id, c.accountEmail ?? c.accountId, c.agentName)
                            }
                          >
                            Revoke
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ padding: '0 16px 12px' }}>
                  <Pagination
                    page={page}
                    total={data.meta.total}
                    size={PAGE_SIZE}
                    onPage={onPage}
                  />
                </div>
              </div>
            )
          )}
        </QueryBoundary>
      </div>
    </div>
  );
}
