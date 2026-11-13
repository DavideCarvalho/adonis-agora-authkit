import type { PersonalAgentEntry } from '@adonis-agora/authkit-react';
import { parseAsInteger, useQueryState } from 'nuqs';
import { useState } from 'react';
import { PageHeader } from '../agora-kit/blocks/page-header';
import { PageBody } from '../agora-kit/shell/app-shell';
import {
  PersonalAgentConnectionsContainer,
  PersonalAgentsContainer,
} from '../containers/personal_agents.containers';

export function PersonalAgents() {
  const [page, setPage] = useQueryState('page', parseAsInteger.withDefault(1));
  const [agent, setAgent] = useState<PersonalAgentEntry | null>(null);

  return (
    <PageBody>
      <PageHeader
        title="Personal agents"
        description={
          <>
            AI agents (PACT and other protocols) acting for your users: who is connected, and which
            agents may connect. Allow and block add to <code className="mono">defineConfig</code>{' '}
            and apply right away.
          </>
        }
      />
      <PersonalAgentsContainer
        onShowConnections={(a) => {
          setAgent(a);
          void setPage(null);
        }}
      />
      <PersonalAgentConnectionsContainer
        agent={agent}
        onClearAgent={() => {
          setAgent(null);
          void setPage(null);
        }}
        page={page}
        onPage={(p) => void setPage(p)}
      />
    </PageBody>
  );
}
