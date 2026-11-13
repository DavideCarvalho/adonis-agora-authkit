import {
  authkitKeys,
  useKeysQueryOptions,
  useRotateKeysMutationOptions,
  useSetSettingMutationOptions,
} from '@adonis-agora/authkit-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { cn } from '../agora-kit/lib/utils';
import { Button } from '../agora-kit/ui/button';
import { Toggle } from '../components/forms';
import {
  dangerButtonClass,
  Notice,
  SettingsRow,
  SettingsSection,
  Surface,
  TextInput,
} from '../components/primitives';
import { QueryBoundary } from '../components/QueryBoundary';
import { Skeleton } from '../components/Skeleton';
import { useToast } from '../lib/toast';

/** A bordered surface holding settings rows (authkit `.panel` with no head). */
export function KeysContainer() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    ...useKeysQueryOptions(),
    retry: (n: number, err: unknown) => {
      // 501 = jwks não é managed+store → não adianta retry
      if (
        err &&
        typeof err === 'object' &&
        'status' in err &&
        (err as { status: number }).status === 501
      )
        return false;
      return n < 1;
    },
  });

  const rotate = useMutation(useRotateKeysMutationOptions());
  const setSetting = useMutation(useSetSettingMutationOptions());

  const [maxAgeDays, setMaxAgeDays] = useState<number | null>(null);
  const [keep, setKeep] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const isNotManaged =
    error &&
    typeof error === 'object' &&
    'status' in error &&
    (error as { status: number }).status === 501;
  if (isNotManaged) {
    return (
      <Notice>
        Rotação indisponível: o <code className="mono">jwks</code> não é{' '}
        <code className="mono">managed</code> com um <code className="mono">store</code> persistente
        (ex.: <code className="mono">{`{ source: 'managed', store: { driver: 'lucid' } }`}</code>).
        Chaves inline (<code className="mono">source: 'jwks'</code>) não rotacionam.
      </Notice>
    );
  }

  const policy = data?.policy;
  const effMaxAge = maxAgeDays ?? policy?.maxAgeDays ?? 90;
  const effKeep = keep ?? policy?.keep ?? 2;

  async function savePolicy(next: { enabled?: boolean; maxAgeDays?: number; keep?: number }) {
    setBusy('policy');
    try {
      const value = {
        enabled: next.enabled ?? policy?.enabled ?? false,
        maxAgeDays: next.maxAgeDays ?? effMaxAge,
        keep: next.keep ?? effKeep,
      };
      await setSetting.mutateAsync({ key: 'key_rotation', value });
      qc.invalidateQueries({ queryKey: authkitKeys.admin.keys() });
      setMaxAgeDays(null);
      setKeep(null);
      toast.success('Política de rotação salva');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function doRotate(retire: boolean) {
    const msg = retire
      ? 'Isso DESABILITA todas as chaves atuais e cria uma nova. Tokens já emitidos deixam de validar imediatamente. Continuar?'
      : 'Rotacionar agora? Uma chave nova vira a ativa; as antigas continuam validando (janela de grace).';
    if (!window.confirm(msg)) return;
    setBusy(retire ? 'retire' : 'rotate');
    try {
      const res = await rotate.mutateAsync(retire ? { retire: true } : { keep: effKeep });
      qc.invalidateQueries({ queryKey: authkitKeys.admin.keys() });
      toast.success(`Rotacionado. Nova chave: ${res.newKid.slice(0, 8)}…`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <QueryBoundary
      label="Signing keys"
      isLoading={isLoading}
      error={isNotManaged ? undefined : error}
      onRetry={refetch}
      skeleton={<Skeleton width="100%" height={220} />}
    >
      {data && (
        <div className="flex flex-col gap-6">
          {/* Status */}
          <Surface className="px-4">
            <div className="flex flex-col items-start justify-between gap-3 py-3 sm:flex-row sm:gap-5">
              <div className="min-w-0">
                <div className="mono text-xs font-medium text-fg">Chave de assinatura ativa</div>
                <div className="mono text-xs break-all text-dim">
                  {data.keys.find((k) => k.active)?.kid ?? '—'}
                </div>
              </div>
              <div className="text-[11px] text-faint sm:text-right">
                <div>Idade: {data.ageDays} dia(s)</div>
                <div className="mt-0.5">
                  Próxima rotação:{' '}
                  {data.nextRotationInDays === null
                    ? '— (auto off)'
                    : `~${data.nextRotationInDays} dia(s)`}
                </div>
              </div>
            </div>
          </Surface>

          {/* Política de rotação */}
          <SettingsSection
            title="Rotação automática"
            description="Gera uma chave nova quando a ativa passa da idade máxima; mantém as N mais recentes (janela de grace)."
          >
            <Surface className="px-4 mt-3">
              <SettingsRow name="Habilitar rotação agendada" description="key_rotation.enabled">
                <Toggle
                  label="Habilitar rotação agendada"
                  checked={Boolean(policy?.enabled)}
                  disabled={busy === 'policy'}
                  onChange={(v) => {
                    if (busy !== 'policy') void savePolicy({ enabled: v });
                  }}
                />
              </SettingsRow>
              <SettingsRow name="Idade máxima (dias)" description="key_rotation.maxAgeDays">
                <TextInput
                  mono
                  type="number"
                  aria-label="Idade máxima (dias)"
                  className="w-[90px] text-right"
                  value={String(effMaxAge)}
                  onChange={(e) => setMaxAgeDays(Number(e.target.value))}
                />
                {maxAgeDays !== null && (
                  <Button
                    size="sm"
                    disabled={busy === 'policy'}
                    onClick={() => savePolicy({ maxAgeDays: effMaxAge })}
                  >
                    Save
                  </Button>
                )}
              </SettingsRow>
              <SettingsRow name="Manter N chaves (grace)" description="key_rotation.keep">
                <TextInput
                  mono
                  type="number"
                  aria-label="Manter N chaves (grace)"
                  className="w-[90px] text-right"
                  value={String(effKeep)}
                  onChange={(e) => setKeep(Number(e.target.value))}
                />
                {keep !== null && (
                  <Button
                    size="sm"
                    disabled={busy === 'policy'}
                    onClick={() => savePolicy({ keep: effKeep })}
                  >
                    Save
                  </Button>
                )}
              </SettingsRow>
            </Surface>
          </SettingsSection>

          {/* Chaves */}
          <SettingsSection
            title="Chaves no keyset"
            description="A primeira é a ativa (assina); as demais ainda validam tokens (grace)."
          >
            <Surface className="px-4 mt-3">
              {data.keys.map((k) => (
                <div key={k.kid} className="border-b border-border py-3 last:border-0">
                  <div className="mono text-xs font-medium break-all text-fg">
                    {k.kid}
                    <span
                      className={cn(
                        'mono ml-1.5 rounded-sm border px-1.5 py-px text-[9.5px]',
                        k.active
                          ? 'border-brand-border bg-brand-soft text-brand'
                          : 'border-border bg-hover text-faint',
                      )}
                    >
                      {k.active ? 'ativa' : 'grace'}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-faint">
                    {k.alg} · {k.ageDays} dia(s)
                  </div>
                </div>
              ))}
            </Surface>
          </SettingsSection>

          {/* Ações */}
          <SettingsSection title="Ações">
            <Surface className="px-4 mt-3 flex flex-wrap gap-3 py-4">
              <Button disabled={!!busy} onClick={() => doRotate(false)}>
                {busy === 'rotate' ? 'Rotacionando…' : 'Rotacionar agora'}
              </Button>
              <Button
                variant="outline"
                className={cn('border-bad/40 text-bad', dangerButtonClass)}
                disabled={!!busy}
                onClick={() => doRotate(true)}
              >
                {busy === 'retire' ? 'Desabilitando…' : 'Desabilitar todas + criar nova'}
              </Button>
            </Surface>
          </SettingsSection>
        </div>
      )}
    </QueryBoundary>
  );
}
