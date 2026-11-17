import { authkitKeys, useRevokeAllSessionsMutationOptions } from '@adonis-agora/authkit-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { parseAsArrayOf, parseAsString, useQueryState } from 'nuqs';
import { PageHeader } from '../agora-kit/blocks/page-header';
import { XIcon } from '../agora-kit/icons';
import { PageBody } from '../agora-kit/shell/app-shell';
import { Button } from '../agora-kit/ui/button';
import { dangerButtonClass } from '../components/primitives';
import { SessionsTableContainer } from '../containers/sessions.containers';
import { useToast } from '../lib/toast';

export function Sessions() {
  const toast = useToast();
  const queryClient = useQueryClient();
  // `?after=c1,c2`: the cursor of every page walked so far, so back/forward and a shared link land
  // on the same page. The first page has no param.
  const [cursors, setCursors] = useQueryState(
    'after',
    parseAsArrayOf(parseAsString).withDefault([]).withOptions({ history: 'push' }),
  );

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
        description="Active sessions, most recent activity first"
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

      <SessionsTableContainer
        {...(cursors.length > 0 ? { after: cursors[cursors.length - 1] } : {})}
        onNext={(next) => void setCursors([...cursors, next])}
        onPrevious={() => void setCursors(cursors.length <= 1 ? null : cursors.slice(0, -1))}
      />
    </PageBody>
  );
}
