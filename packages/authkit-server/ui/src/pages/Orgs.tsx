import { parseAsInteger, parseAsString, useQueryState } from 'nuqs';
import { useState } from 'react';
import { PageHeader, Toolbar } from '../agora-kit/blocks/page-header';
import { PageBody } from '../agora-kit/shell/app-shell';
import { Button } from '../agora-kit/ui/button';
import { Notice, SearchInput } from '../components/primitives';
import {
  CreateOrgModal,
  OrgDetailDrawer,
  OrgsTableContainer,
  useOrgsTotal,
} from '../containers/orgs.containers';
import { useDebounce } from '../lib/use_debounce';

export function Orgs() {
  // Estado de rota (URL): paginação, busca e drawer de detalhe via nuqs.
  const [page, setPage] = useQueryState('page', parseAsInteger.withDefault(1));
  const [search, setSearch] = useQueryState('q', parseAsString.withDefault(''));
  const [detailOrgId, setDetailOrgId] = useQueryState('org');
  const dSearch = useDebounce(search, 300);
  // Estado efêmero de UI permanece local.
  const [unavailable, setUnavailable] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const total = useOrgsTotal(dSearch);

  if (unavailable) {
    return (
      <PageBody>
        <PageHeader title="Organizations" />
        <Notice>Organizations are not enabled in this AuthKit installation.</Notice>
      </PageBody>
    );
  }

  return (
    <PageBody>
      <PageHeader
        title="Organizations"
        description={`${total.toLocaleString()} orgs`}
        actions={<Button onClick={() => setCreateOpen(true)}>New organization</Button>}
      />

      <Toolbar label="Filter organizations">
        <SearchInput
          wrapperClassName="w-full sm:max-w-[300px]"
          placeholder="Search organizations…"
          aria-label="Search organizations"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
      </Toolbar>

      <OrgsTableContainer
        search={dSearch}
        page={page}
        onPage={setPage}
        onSelectOrg={setDetailOrgId}
        onUnavailable={() => setUnavailable(true)}
        onCreateClick={() => setCreateOpen(true)}
      />

      {detailOrgId && <OrgDetailDrawer orgId={detailOrgId} onClose={() => setDetailOrgId(null)} />}

      <CreateOrgModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => setCreateOpen(false)}
      />
    </PageBody>
  );
}
