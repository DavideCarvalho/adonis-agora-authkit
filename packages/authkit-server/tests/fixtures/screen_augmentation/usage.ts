import {
  type AuthkitScreen,
  type AuthkitScreenProps,
  type AuthkitScreenRenderer,
  inertiaRenderer,
  type ScreenRenderProps,
} from '@adonis-agora/authkit-server';
import type { HttpContext } from '@adonisjs/core/http';

// `views` accepts the augmented screen next to the library's.
inertiaRenderer({ prefix: 'authkit', views: ['login', 'professional-login'] });

// …and still refuses a name nobody declared.
// @ts-expect-error 'not-a-screen' is not a key of AuthkitScreenProps
inertiaRenderer({ prefix: 'authkit', views: ['not-a-screen'] });

const screen: AuthkitScreen = 'professional-login';
const props: AuthkitScreenProps['professional-login']['uid'] = 'uid';

// A typed renderer takes the augmented view with its own props.
declare const render: AuthkitScreenRenderer;
declare const ctx: HttpContext;
const loginProps: ScreenRenderProps<'professional-login'> = { uid: 'u', csrfToken: 't' };
render(ctx, 'professional-login', loginProps);

// @ts-expect-error a login screen needs its `uid`
render(ctx, 'professional-login', { csrfToken: 't' });

export { props, screen };
