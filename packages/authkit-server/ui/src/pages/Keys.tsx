import { PageHeader } from '../agora-kit/blocks/page-header';
import { PageBody } from '../agora-kit/shell/app-shell';
import { KeysContainer } from '../containers/keys.containers';

export function Keys() {
  return (
    <PageBody>
      <PageHeader
        title="Signing Keys"
        description="Chaves JWKS de assinatura — rotação, grace e status. Mudanças aplicam ao vivo."
      />
      <KeysContainer />
    </PageBody>
  );
}
