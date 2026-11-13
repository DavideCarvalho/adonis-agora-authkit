import { authkitKeys, useRevokeAllSessionsMutationOptions } from '@adonis-agora/authkit-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { parseAsInteger, useQueryState } from 'nuqs';
import { PageHeader } from '../agora-kit/blocks/page-header';
import { XIcon } from '../agora-kit/icons';
import { PageBody } from '../agora-kit/shell/app-shell';
import { Button } from '../agora-kit/ui/button';
import { dangerButtonClass } from '../components/primitives';
import { SessionsTableContainer, useSessionsTotal } from '../containers/sessions.containers';
import { useToast } from '../lib/toast';

export function Sessions() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [page, setPage] = useQueryState('page', parseAsInteger.withDefault(1));
  const total = useSessionsTotal();

  const revokeMutation = useMutation(useRevokeAllSessionsMutationOptions());

  async function revokeAll() {
    if (!confirm('Revoke ALL active sessions? All users will be logged out.')) return;
    try {
      const r = await revokeMutation.mutateAsync();
      toast.success(`Revoked ${r.revoked ?? 0} sessions`);
      queryClient.invalidateQueries({ queryKey: authkitKeys.admin.sessions() });
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <PageBody>
      <PageHeader
        title="Sessions"
        description={`${total.toLocaleString()} active sessions`}
        actions={
          <Button
            variant="outline"
            className={dangerButtonClass}
            onClick={revokeAll}
            disabled={revokeMutation.isPending}
          >
            <XIcon />
            {revokeMutation.isPending ? 'Revoking…' : 'Revoke All'}
          </Button>
        }
      />

      <SessionsTableContainer page={page} onPage={setPage} />
    </PageBody>
  );
}
