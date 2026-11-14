import {
  type AuthkitClientError,
  authkitKeys,
  type McpClientsStatus,
  type McpClientsUpdateInput,
  useMcpClientsQueryOptions,
  useUpdateMcpClientsMutationOptions,
} from '@adonis-agora/authkit-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { parseAsString, useQueryStates } from 'nuqs';
import { Badge } from '../agora-kit/ui/badge';
import { Button } from '../agora-kit/ui/button';
import { Toggle } from '../components/forms';
import { Code, Notice, SettingsRow, Surface } from '../components/primitives';
import { QueryBoundary } from '../components/QueryBoundary';
import { Skeleton } from '../components/Skeleton';
import { getConfig } from '../lib/config';
import { useToast } from '../lib/toast';

/** Por que o login de clientes MCP está desligado, em uma frase. */
function offReason(status: McpClientsStatus): string {
  switch (status.off) {
    case 'config':
      return 'Desligado no código: `mcpClients: false` em config/authkit.ts.';
    case 'setting':
      return 'Desligado por aqui (setting `mcp_clients`).';
    case 'no-resource':
      return 'Nenhum servidor MCP registrado com o authkit — liga sozinho quando um aparecer (ex.: o hub /mcp/agora do agent com devTools).';
    default:
      return '';
  }
}

function McpClientsSkeleton() {
  return (
    <Surface className="px-4 py-3.5" aria-hidden>
      <div className="flex flex-col gap-2">
        <Skeleton width="45%" height={13} />
        <Skeleton width="70%" height={11} />
        <Skeleton width="30%" height={11} />
      </div>
    </Surface>
  );
}

/**
 * Card "Login de clientes MCP" das Settings: estado vivo (ligado/desligado e por quê, quais
 * resources), o liga/desliga da setting `mcp_clients` (sudo; travado com `mcpClients: false`), e
 * quantos clientes MCP se registraram, com o atalho para revogá-los em Clients.
 */
export function McpClientsCard() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery(useMcpClientsQueryOptions());
  const update = useMutation(useUpdateMcpClientsMutationOptions());
  const [, setRoute] = useQueryStates({ view: parseAsString, type: parseAsString });

  async function save(patch: Partial<McpClientsUpdateInput>) {
    if (!data) return;
    const next: McpClientsUpdateInput = {
      enabled: data.setting.enabled,
      dynamicRegistration: data.setting.dynamicRegistration,
      metadataDocuments: data.setting.metadataDocuments,
      ...patch,
    };
    try {
      const saved = await update.mutateAsync(next);
      queryClient.setQueryData(authkitKeys.admin.mcpClients(), saved);
      queryClient.invalidateQueries({ queryKey: authkitKeys.admin.settings() });
      toast.success(`Login de clientes MCP: ${saved.enabled ? 'ligado' : 'desligado'}`);
    } catch (err: unknown) {
      const code = (err as AuthkitClientError | null)?.code;
      if (code === 'sudo_required') {
        const back = window.location.pathname + window.location.search;
        window.location.href = `${getConfig().endpoints.confirm ?? '/account/confirm'}?return_to=${encodeURIComponent(back)}`;
        return;
      }
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  const locked = data?.lockedByConfig ?? false;
  const busy = update.isPending;

  return (
    <section className="mb-6">
      <div className="mb-1 flex flex-col items-start justify-between gap-2.5 border-b border-border pb-2.5 sm:flex-row sm:items-center">
        <div>
          <h3 className="flex flex-wrap items-center gap-2 text-[13px] font-semibold text-fg">
            Login de clientes MCP
            {data &&
              (data.enabled ? (
                <Badge variant="good">ligado</Badge>
              ) : (
                <Badge variant="neutral">desligado</Badge>
              ))}
            {locked && <Badge variant="brand">definido via config</Badge>}
          </h3>
          <p className="mt-0.5 text-[11px] text-faint">
            Claude Code, Claude, ChatGPT, Cursor e VS Code se registram e entram sozinhos quando há
            um servidor MCP registrado com o authkit.
          </p>
          <div className="mono mt-0.5 text-[10.5px] text-faint">mcp_clients</div>
        </div>
      </div>

      <QueryBoundary
        label="Login de clientes MCP"
        isLoading={isLoading}
        error={error}
        onRetry={refetch}
        skeleton={<McpClientsSkeleton />}
      >
        {data && (
          <Surface className="px-4">
            <SettingsRow
              name="Estado"
              description={
                data.enabled ? 'Automático: há servidor MCP registrado.' : offReason(data)
              }
            >
              <span className="mono text-[11px] text-faint">{data.enabled ? 'on' : 'off'}</span>
            </SettingsRow>
            <SettingsRow
              name="Servidores MCP registrados"
              description={
                data.resources.length === 0 ? 'Nenhum.' : 'Os tokens só valem para estes.'
              }
            >
              <div className="flex max-w-[320px] flex-wrap justify-end gap-1">
                {data.resources.map((r) => (
                  <Code key={r}>{r}</Code>
                ))}
              </div>
            </SettingsRow>
            <SettingsRow
              name="Permitir login de clientes MCP"
              description={
                locked
                  ? 'Travado no defineConfig() (`mcpClients: false`). Remova de lá para controlar por aqui.'
                  : 'Desligado, o registro e o login de novos clientes MCP param no próximo request.'
              }
            >
              <Toggle
                label="Permitir login de clientes MCP"
                checked={!locked && data.setting.enabled !== false}
                disabled={locked || busy}
                onChange={(v) => void save({ enabled: v ? 'auto' : false })}
              />
            </SettingsRow>
            {data.config.dynamicRegistration === 'mcp' && (
              <SettingsRow
                name="Registro dinâmico (RFC 7591)"
                description="Clientes MCP se cadastram pelo /reg, só com os callbacks conhecidos."
              >
                <Toggle
                  label="Registro dinâmico"
                  checked={!locked && data.setting.dynamicRegistration}
                  disabled={locked || busy || data.setting.enabled === false}
                  onChange={(v) => void save({ dynamicRegistration: v })}
                />
              </SettingsRow>
            )}
            {data.config.dynamicRegistration === 'app' && (
              <SettingsRow
                name="Registro dinâmico (RFC 7591)"
                description="Controlado pelo `dynamicRegistration` do config/authkit.ts."
              >
                <span className="mono text-[11px] text-faint">config</span>
              </SettingsRow>
            )}
            {data.config.metadataDocuments && (
              <SettingsRow
                name="Client ID Metadata Documents"
                description="O client_id é uma URL https com o documento do cliente — sem cadastro."
              >
                <Toggle
                  label="Client ID Metadata Documents"
                  checked={!locked && data.setting.metadataDocuments}
                  disabled={locked || busy || data.setting.enabled === false}
                  onChange={(v) => void save({ metadataDocuments: v })}
                />
              </SettingsRow>
            )}
            <SettingsRow
              name="Clientes MCP registrados"
              description={
                data.clients.dynamic === null
                  ? 'O adapter não lista clients.'
                  : `${data.clients.dynamic} pelo registro dinâmico.`
              }
            >
              <Button
                variant="outline"
                size="sm"
                onClick={() => void setRoute({ view: 'clients', type: 'mcp' })}
              >
                Ver em Clients
              </Button>
            </SettingsRow>
          </Surface>
        )}
        {data && (
          <Notice tone="info" className="mt-2">
            Desligar recusa novos registros e logins na hora. Tokens já emitidos continuam valendo
            até expirar — revogue os clients em Clients para cortá-los.
          </Notice>
        )}
      </QueryBoundary>
    </section>
  );
}
