// A host screen, typed the way apps register theirs.
import type { LoginProps } from '@adonis-agora/authkit-server';

declare module '@adonis-agora/authkit-server' {
  interface AuthkitScreenProps {
    'professional-login': LoginProps;
  }
}
