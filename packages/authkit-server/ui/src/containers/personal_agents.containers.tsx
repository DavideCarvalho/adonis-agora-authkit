import {
  type AuthkitClientError,
  authkitKeys,
  type PersonalAgentEntry,
  type PersonalAgentExtensionOverview,
  type PersonalAgentProtocol,
  type PersonalAgentsOverview,
  usePersonalAgentConnectionsQueryOptions,
  usePersonalAgentsQueryOptions,
  useRemovePersonalAgentEntryMutationOptions,
  useRevokePersonalAgentConnectionMutationOptions,
  useSetPersonalAgentStatusMutationOptions,
} from '@adonis-agora/authkit-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { EmptyState } from '../agora-kit/blocks/empty-state';
import { Badge } from '../agora-kit/ui/badge';
import { Button } from '../agora-kit/ui/button';
import { Modal } from '../components/Modal';
import { Pagination } from '../components/Pagination';
import {
  AdminTable,
  Cell,
  dangerButtonClass,
  Field,
  Notice,
  Row,
  SelectInput,
  Surface,
  TextInput,
} from '../components/primitives';
import { QueryBoundary } from '../components/QueryBoundary';
import { SkeletonPanelTable, SkeletonTable } from '../components/Skeleton';
import { getConfig } from '../lib/config';
import { useToast } from '../lib/toast';

const PAGE_SIZE = 20;

/** As extensions ligadas (`personalAgents.extensions`), pelo id. */
function extensionsOf(
  overview: PersonalAgentsOverview,
): Array<[PersonalAgentProtocol, PersonalAgentExtensionOverview]> {
  return Object.entries(overview.protocols).filter(
    (entry): entry is [string, PersonalAgentExtensionOverview] =>
      entry[0] !== 'pact' && entry[1] !== null,
  );
}

function protocolLabel(overview: PersonalAgentsOverview | undefined, protocol: string): string {
  if (protocol === 'pact') return 'PACT';
  const extension = overview?.protocols[protocol] as PersonalAgentExtensionOverview | null;
  return extension?.label ?? protocol;
}

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
      <Badge variant="destructive">blocked</Badge>
    ) : agent.effective === 'allowed' ? (
      <Badge variant="good">allowed</Badge>
    ) : (
      <Badge variant="neutral">not listed</Badge>
    );
  const sources = [
    agent.config && `config: ${agent.config}`,
    agent.console && `console: ${agent.console.status}`,
  ].filter(Boolean);
  return (
    <div className="flex flex-col items-start gap-[3px]">
      {effective}
      {sources.length > 0 && <span className="text-[11px] text-faint">{sources.join(' · ')}</span>}
    </div>
  );
}

function protocolPolicy(overview: PersonalAgentsOverview): string[] {
  const lines: string[] = [];
  const { pact } = overview.protocols;
  const extensions = extensionsOf(overview);
  if (pact) {
    lines.push(
      pact.open
        ? 'PACT: open — any agent publishing a JWKS via OIDC discovery is accepted, except blocked ones.'
        : 'PACT: only listed agents are accepted.',
    );
  }
  for (const [, extension] of extensions) {
    lines.push(
      extension.requireRegistration
        ? `${extension.label}: registration required — only listed agents can connect.`
        : `${extension.label}: any agent with a valid identifier can connect, except blocked ones.`,
    );
  }
  if (pact?.hostResolver || extensions.some(([, e]) => e.hostResolver)) {
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
      <Notice>
        Personal agents are not configured. Add <code className="mono">personalAgents</code> (PACT
        and/or <code className="mono">extensions</code>) to{' '}
        <code className="mono">defineConfig</code>.
      </Notice>
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
      label="Personal agents"
      isLoading={isLoading}
      error={error}
      onRetry={refetch}
      skeleton={<SkeletonPanelTable rows={4} cols={5} />}
    >
      {data && (
        <>
          <div className="agora-surface agora-rise flex flex-col items-start gap-4 rounded-lg border border-border px-4 pt-3 pb-4 sm:flex-row">
            <div className="flex-1 text-xs leading-[1.7] text-dim">
              {protocolPolicy(data).map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
            <Button size="sm" onClick={() => setAdding(true)}>
              Add agent
            </Button>
          </div>

          <div className="agora-surface agora-rise mb-2 overflow-hidden rounded-lg border border-border">
            {data.agents.length === 0 ? (
              <EmptyState
                title="No personal agents yet"
                description="Agents show up here once listed or once someone connects one."
              />
            ) : (
              <AdminTable
                head={['Agent', 'Protocol', 'Status', 'Connections', '']}
                label="Personal agents"
              >
                {data.agents.map((agent) => {
                  const configBlocked = agent.config === 'blocked';
                  const consoleBlocked = agent.console?.status === 'blocked';
                  return (
                    <Row key={`${agent.protocol} ${agent.identifier}`}>
                      <Cell>
                        <div className="flex flex-col gap-0.5">
                          <span className="text-xs font-medium text-fg">{agent.name}</span>
                          <span className="mono text-[11px] text-faint">{agent.identifier}</span>
                        </div>
                      </Cell>
                      <Cell>
                        <Badge variant="neutral">{protocolLabel(data, agent.protocol)}</Badge>
                      </Cell>
                      <Cell>
                        <StatusBadges agent={agent} />
                      </Cell>
                      <Cell>
                        {agent.connections > 0 ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => onShowConnections(agent)}
                          >
                            {agent.connections}
                          </Button>
                        ) : (
                          <span className="text-faint">0</span>
                        )}
                      </Cell>
                      <Cell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          {agent.console && (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy}
                              onClick={() => remove(agent)}
                            >
                              {consoleBlocked ? 'Unblock' : 'Remove'}
                            </Button>
                          )}
                          {agent.effective === 'unlisted' && (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy}
                              onClick={() => allow(agent)}
                            >
                              Allow
                            </Button>
                          )}
                          {!configBlocked && !consoleBlocked && (
                            <Button
                              variant="outline"
                              size="sm"
                              className={dangerButtonClass}
                              disabled={busy}
                              onClick={() => block(agent)}
                            >
                              Block
                            </Button>
                          )}
                          {configBlocked && (
                            <span
                              className="text-[11px] text-faint"
                              title="Blocked in defineConfig — change it there."
                            >
                              locked by config
                            </span>
                          )}
                        </div>
                      </Cell>
                    </Row>
                  );
                })}
              </AdminTable>
            )}
          </div>

          <AddAgentModal open={adding} onClose={() => setAdding(false)} overview={data} />
        </>
      )}
    </QueryBoundary>
  );
}

function AddAgentModal({
  open,
  onClose,
  overview,
}: {
  open: boolean;
  onClose: () => void;
  overview: PersonalAgentsOverview;
}) {
  const extensions = extensionsOf(overview);
  const protocols: PersonalAgentProtocol[] = [
    ...(overview.protocols.pact ? ['pact'] : []),
    ...extensions.map(([id]) => id),
  ];
  const setStatus = useMutation(useSetPersonalAgentStatusMutationOptions());
  const toast = useToast();
  const onError = useActionError();
  const invalidate = useInvalidate();
  const [protocol, setProtocol] = useState<PersonalAgentProtocol>(protocols[0] ?? 'pact');
  const extension = extensions.find(([id]) => id === protocol)?.[1] ?? null;
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
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={status === 'blocked' ? 'outline' : 'default'}
            className={status === 'blocked' ? dangerButtonClass : undefined}
            form="add-agent-form"
            type="submit"
            disabled={setStatus.isPending || !identifier.trim()}
          >
            {setStatus.isPending ? 'Saving…' : status === 'blocked' ? 'Block' : 'Allow'}
          </Button>
        </>
      }
    >
      <form id="add-agent-form" onSubmit={submit}>
        <Field label="Protocol" htmlFor="add-agent-protocol">
          <SelectInput
            id="add-agent-protocol"
            value={protocol}
            onChange={(e) => setProtocol(e.target.value as PersonalAgentProtocol)}
          >
            {protocols.map((p) => (
              <option key={p} value={p}>
                {protocolLabel(overview, p)}
              </option>
            ))}
          </SelectInput>
        </Field>
        <Field
          label={extension ? extension.identifierLabel : 'Issuer (iss)'}
          htmlFor="add-agent-identifier"
        >
          <TextInput
            id="add-agent-identifier"
            mono
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder={
              extension
                ? (extension.identifierPlaceholder ??
                  `${extension.allowHttpIdentifiers ? 'http(s)' : 'https'}://agent.example`)
                : 'https://agent.example'
            }
            required
          />
        </Field>
        {protocol === 'pact' && (
          <Field
            label={`JWKS URI ${status === 'allowed' ? '(required)' : '(optional)'}`}
            htmlFor="add-agent-jwks"
          >
            <TextInput
              id="add-agent-jwks"
              mono
              value={jwksUri}
              onChange={(e) => setJwksUri(e.target.value)}
              placeholder="https://agent.example/.well-known/jwks.json"
              required={status === 'allowed'}
            />
          </Field>
        )}
        <Field label="Display name (optional)" htmlFor="add-agent-name">
          <TextInput id="add-agent-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Status" htmlFor="add-agent-status">
          <SelectInput
            id="add-agent-status"
            value={status}
            onChange={(e) => setStatusValue(e.target.value === 'blocked' ? 'blocked' : 'allowed')}
          >
            <option value="allowed">Allowed</option>
            <option value="blocked">Blocked (disconnects every account now)</option>
          </SelectInput>
        </Field>
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
  // Só para os nomes dos protocolos (a mesma query da lista de agentes, em cache).
  const { data: overview } = useQuery({ ...usePersonalAgentsQueryOptions(), retry: false });
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
    <section className="mb-6">
      <div className="mb-3 flex flex-col items-start justify-between gap-2.5 border-b border-border pb-2.5 sm:flex-row sm:items-center">
        <div>
          <h3 className="text-[13px] font-semibold text-fg">
            Connections{agent ? ` — ${agent.name}` : ''}
          </h3>
          <p className="mt-0.5 text-[11px] text-faint">
            Accounts that signed in to a personal agent. Revoking cuts that agent off the account
            right away.
          </p>
        </div>
        {agent && (
          <Button variant="ghost" size="sm" onClick={onClearAgent}>
            Show all
          </Button>
        )}
      </div>
      <Surface>
        <QueryBoundary
          label="Connections"
          isLoading={isLoading}
          error={error}
          onRetry={refetch}
          skeleton={<SkeletonTable rows={5} cols={5} />}
        >
          {data && data.data.length === 0 ? (
            <EmptyState
              title="No connections"
              description="No account is connected to a personal agent."
            />
          ) : (
            data && (
              <>
                <AdminTable
                  head={['Account', 'Agent', 'Scopes', 'Connected', 'Expires', '']}
                  label="Connections"
                >
                  {data.data.map((c) => (
                    <Row key={c.id}>
                      <Cell>
                        <div className="flex flex-col gap-0.5">
                          {c.accountEmail && (
                            <span className="text-xs font-medium text-fg">{c.accountEmail}</span>
                          )}
                          <span className="mono text-[11px] text-faint">{c.accountId}</span>
                        </div>
                      </Cell>
                      <Cell>
                        <div className="flex flex-col gap-0.5">
                          <span className="text-xs text-fg">{c.agentName}</span>
                          <span className="text-[11px] text-faint">
                            {protocolLabel(overview, c.protocol)}
                          </span>
                        </div>
                      </Cell>
                      <Cell>
                        <div className="flex flex-wrap gap-1">
                          {c.scopes.map((s) => (
                            <Badge key={s} variant="neutral">
                              {s}
                            </Badge>
                          ))}
                        </div>
                      </Cell>
                      <Cell className="mono text-[11px]">
                        {new Date(c.createdAt).toLocaleString()}
                      </Cell>
                      <Cell className="mono text-[11px]">
                        {new Date(c.expiresAt).toLocaleDateString()}
                      </Cell>
                      <Cell className="text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          className={dangerButtonClass}
                          disabled={revoke.isPending}
                          onClick={() => doRevoke(c.id, c.accountEmail ?? c.accountId, c.agentName)}
                        >
                          Revoke
                        </Button>
                      </Cell>
                    </Row>
                  ))}
                </AdminTable>
                <Pagination page={page} total={data.meta.total} size={PAGE_SIZE} onPage={onPage} />
              </>
            )
          )}
        </QueryBoundary>
      </Surface>
    </section>
  );
}
