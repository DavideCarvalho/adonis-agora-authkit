import { existsSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from '@japa/runner';
import { resetAuthHostConfig } from '../../src/host/auth_host_config.js';
import WebauthnAssetController, {
  resetWebauthnAssetCache,
} from '../../src/host/controllers/webauthn_asset_controller.js';
import { registerAuthHost } from '../../src/host/register_auth_host.js';

const viewsDir = fileURLToPath(new URL('../../src/host/views/', import.meta.url));
const bundlePath = fileURLToPath(new URL('../../src/host/assets/webauthn.js', import.meta.url));

/** Path público do bundle — contrato entre a rota e as quatro views. */
const ASSET_PATH = '/authkit/assets/webauthn.js';

/**
 * Views que fazem o handshake WebAuthn. São exatamente as que importavam o
 * `@simplewebauthn/browser` de `cdn.jsdelivr.net`.
 *
 * Desde o M12 (auditoria de segurança) essas views não importam mais o bundle
 * DIRETAMENTE: o `<script type="module">` inline que fazia `import … from
 * '/authkit/assets/webauthn.js'` foi extraído para um asset same-origem
 * próprio (CSP `script-src 'self'` bloqueia script inline sem nonce/hash), e é
 * ESSE asset que importa o bundle. Ver `WEBAUTHN_ASSET_FILES` abaixo — o
 * vínculo "sem CDN" agora se prova em dois passos: view → asset → bundle.
 */
const WEBAUTHN_VIEWS = [
  'login.edge',
  'mfa-challenge.edge',
  'account/mfa.edge',
  'account/confirm.edge',
];

/**
 * Assets JS (não mais views) que hoje fazem `import … from '/authkit/assets/webauthn.js'`
 * — um por fluxo, extraídos das views acima pelo M12. Mora aqui, ao lado de
 * `WEBAUTHN_VIEWS`, porque as duas listas juntas são o que garante que nenhuma
 * das quatro telas voltou a depender de um CDN.
 */
const WEBAUTHN_ASSET_FILES = [
  'passkey_autofill.js',
  'passkey_button.js',
  'passkey_register.js',
  'webauthn_confirm.js',
];

const assetsDir = fileURLToPath(new URL('../../src/host/assets/', import.meta.url));
const readAsset = (p: string) => readFileSync(assetsDir + p, 'utf8');

/** Todas as views da lib — o teste de anti-regressão de CDN varre o conjunto inteiro. */
function allViews(dir = viewsDir, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory())
      out.push(...allViews(`${dir + entry.name}/`, `${prefix + entry.name}/`));
    else if (entry.name.endsWith('.edge')) out.push(prefix + entry.name);
  }
  return out;
}

const read = (p: string) => readFileSync(viewsDir + p, 'utf8');

/**
 * Diretório dos stubs — o que o `configure` publica no app de quem instala.
 * Uma vez ejetado, o arquivo passa a ser DO HOST: um CDN aqui vira um terceiro
 * no caminho de autenticação de todo mundo, e o pacote não tem mais como
 * corrigir. Por isso os stubs entram na mesma varredura das views da lib.
 */
const stubsDir = fileURLToPath(new URL('../../stubs/', import.meta.url));

/** Arquivos de stub que viram markup/JS no app do host (o resto é config/TS). */
const STUB_EXTENSIONS = ['.edge', '.tsx', '.jsx', '.stub', '.html'];

function allStubs(dir = stubsDir, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory())
      out.push(...allStubs(`${dir + entry.name}/`, `${prefix + entry.name}/`));
    else if (STUB_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) out.push(prefix + entry.name);
  }
  return out;
}

/**
 * Detecta referência a domínio externo numa linha de markup/JS.
 *
 * Compartilhado entre a varredura das views da lib e a dos stubs para que as
 * duas nunca divirjam — se uma ganhar um padrão novo (outro CDN, outra forma
 * de import), a outra ganha junto.
 *
 * Retorna `false` para comentários Edge e para `xmlns`, que não geram fetch.
 */
function hasExternalReference(line: string): boolean {
  // Comentários Edge (`{{-- … --}}`) não vão para o HTML.
  if (line.includes('{{--')) return false;

  /**
   * `xmlns="http://www.w3.org/2000/svg"` é um NAMESPACE XML, não um fetch — o
   * browser nunca vai à rede por causa dele. Sem esta limpeza todo `<svg>` e
   * todo data-URI do CSS gerado viram falso positivo e o teste é desligado por
   * ruído (que é como uma regressão volta).
   */
  const cleaned = line.replace(/xmlns(:\w+)?=(["'])[^"']*\2/g, '');

  return (
    // <script src="https://…">, <link href="https://…">, <img src="…">
    /(?:src|href)\s*=\s*["']https?:\/\//i.test(cleaned) ||
    // import … from 'https://…'  /  await import('https://…')
    /\bfrom\s*["']https?:\/\/|\bimport\s*\(\s*["']https?:\/\//i.test(cleaned) ||
    // CDNs conhecidos em qualquer posição (inclui `//cdn.…` protocol-relative)
    /\/\/cdn\.|jsdelivr|unpkg\.com|cdnjs\./i.test(cleaned)
  );
}

/** Roda `hasExternalReference` linha a linha e devolve os infratores anotados. */
function scanForExternalReferences(files: string[], readFile: (path: string) => string): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    for (const [i, line] of readFile(file).split('\n').entries()) {
      if (hasExternalReference(line))
        offenders.push(`${file}:${i + 1}: ${line.trim().slice(0, 160)}`);
    }
  }
  return offenders;
}

/**
 * Detecta uma tag de ABERTURA `<script>` SEM atributo `src=` — ou seja,
 * script INLINE (M12). Um IdP com CSP `script-src 'self'` (sem
 * `'unsafe-inline'`, sem nonce/hash) bloqueia esse script silenciosamente; foi
 * exatamente o bug do splash de logout (`0.61.3`) e do bundle WebAuthn/CDN
 * acima — a mesma classe de regressão, um nível abaixo (não é o DOMÍNIO que
 * importa aqui, é o script estar ou não INLINE no HTML).
 *
 * `</script>` (fechamento) nunca casa com `<script` (o `/` logo depois do `<`
 * quebra o literal), então não precisa de tratamento especial.
 */
function hasInlineScript(line: string): boolean {
  return /<script\b(?![^>]*\bsrc\s*=)[^>]*>/i.test(line);
}

/**
 * Roda `hasInlineScript` linha a linha e devolve os infratores anotados.
 *
 * Rastreia comentários Edge `{{-- … --}}` MULTI-LINHA: linhas dentro do bloco
 * não repetem o marcador de abertura, e um docblock explicando por que um
 * script virou asset (como o deste próprio arquivo, algumas linhas acima)
 * menciona `<script>` em prosa, não como markup — sem isto, o docblock vira
 * falso positivo do próprio teste que ele documenta.
 */
function scanForInlineScripts(files: string[], readFile: (path: string) => string): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    let inComment = false;
    for (const [i, line] of readFile(file).split('\n').entries()) {
      if (inComment) {
        if (line.includes('--}}')) inComment = false;
        continue;
      }
      if (line.includes('{{--')) {
        if (!line.includes('--}}')) inComment = true; // abre e não fecha na mesma linha
        continue;
      }
      if (hasInlineScript(line)) offenders.push(`${file}:${i + 1}: ${line.trim().slice(0, 160)}`);
    }
  }
  return offenders;
}

/**
 * `HttpContext` mínimo para exercitar o controller. Captura o que foi enviado
 * em vez de mockar o response inteiro do Adonis.
 */
function fakeCtx() {
  const captured: {
    type?: string;
    headers: Record<string, string>;
    body?: unknown;
    status?: number;
  } = { headers: {} };

  const response: any = {
    type(t: string) {
      captured.type = t;
      return response;
    },
    header(k: string, v: string) {
      captured.headers[k] = v;
      return response;
    },
    send(b: unknown) {
      captured.body = b;
      return response;
    },
    notFound(b?: unknown) {
      captured.status = 404;
      captured.body = b;
      return response;
    },
  };

  return { ctx: { response } as any, captured };
}

test.group('webauthn asset (bundle npm, sem CDN)', (group) => {
  group.each.setup(() => {
    resetWebauthnAssetCache();
    return () => resetWebauthnAssetCache();
  });

  test('o bundle é gerado e commitado em src/host/assets/', ({ assert }) => {
    assert.isTrue(
      existsSync(bundlePath),
      'src/host/assets/webauthn.js não existe — rode `node scripts/build_webauthn.mjs`',
    );
    const code = readFileSync(bundlePath, 'utf8');
    // O contrato com as views: os dois símbolos que elas importam.
    assert.include(code, 'startAuthentication');
    assert.include(code, 'startRegistration');
    // Bundle de verdade, não um reexport que o browser tentaria resolver por
    // bare specifier (o browser não resolve node_modules).
    assert.notInclude(code, "from'@simplewebauthn/browser'");
    assert.notInclude(code, "from '@simplewebauthn/browser'");
  });

  test('serve o bundle com content-type text/javascript e cache imutável', async ({ assert }) => {
    const { ctx, captured } = fakeCtx();
    await new WebauthnAssetController().handle(ctx);

    assert.equal(captured.type, 'text/javascript');
    assert.equal(captured.headers['Cache-Control'], 'public, max-age=31536000, immutable');
    assert.isUndefined(captured.status, 'não deveria ter caído no 404');
    assert.isTrue(Buffer.isBuffer(captured.body));
    assert.include((captured.body as Buffer).toString('utf8'), 'startAuthentication');
  });

  test('responde 404 limpo quando o bundle não existe', async ({ assert }) => {
    // Exercita o caminho real (o `readFile` do próprio controller) escondendo o
    // arquivo, em vez de injetar um path falso: é o modo de falha de verdade
    // quando alguém publica sem rodar o build do bundle.
    const hidden = `${bundlePath}.hidden-by-test`;
    renameSync(bundlePath, hidden);
    try {
      resetWebauthnAssetCache();
      const { ctx, captured } = fakeCtx();
      await new WebauthnAssetController().handle(ctx);

      assert.equal(captured.status, 404);
      assert.isUndefined(captured.type, 'não deveria ter setado content-type');
      assert.isUndefined(captured.headers['Cache-Control']);
    } finally {
      renameSync(hidden, bundlePath);
      resetWebauthnAssetCache();
    }
  });

  test('a rota é pública, sem guard, e fora do prefixo do console admin', ({ assert }) => {
    resetAuthHostConfig();

    const routes: Array<{ method: string; pattern: string; middleware: unknown[]; name?: string }> =
      [];
    const mk = (method: string) => (pattern: string, handler?: unknown) => {
      const route = {
        method,
        pattern,
        middleware: [] as unknown[],
        handler,
        name: undefined as any,
      };
      routes.push(route);
      const chain: any = {
        as: (n: string) => {
          route.name = n;
          return chain;
        },
        middleware: () => chain,
        use: (m: unknown[]) => {
          route.middleware.push(...(Array.isArray(m) ? m : [m]));
          return chain;
        },
      };
      return chain;
    };
    const groupChain: any = {
      as: () => groupChain,
      prefix: () => groupChain,
      middleware: () => groupChain,
      use: () => groupChain,
    };
    const router: any = {
      get: mk('GET'),
      post: mk('POST'),
      patch: mk('PATCH'),
      delete: mk('DELETE'),
      put: mk('PUT'),
      any: mk('ANY'),
      group: (cb: () => void) => {
        cb();
        return groupChain;
      },
    };

    // SEM `admin: true` — é justamente o caso que o CDN mascarava: um host sem
    // console admin precisa do script na tela de login do mesmo jeito.
    registerAuthHost(router);

    const route = routes.find((r) => r.pattern === ASSET_PATH);
    assert.isDefined(route, `rota ${ASSET_PATH} não registrada`);
    assert.equal(route!.method, 'GET');
    assert.lengthOf(route!.middleware, 0, 'o asset da tela de login não pode ter guard');

    // Registrada antes do wildcard do provider OIDC — senão um mountPath
    // agressivo engole o asset e o botão de passkey some sem aviso.
    const wildcard = routes.findIndex((r) => r.name === 'authkit.oidc.wildcard');
    assert.isBelow(routes.indexOf(route!), wildcard);
  });

  test('os assets WebAuthn (extraídos das views pelo M12) importam o bundle local', ({
    assert,
  }) => {
    for (const asset of WEBAUTHN_ASSET_FILES) {
      assert.include(readAsset(asset), ASSET_PATH, `${asset} não importa ${ASSET_PATH}`);
    }
  });

  test('as views WebAuthn referenciam, cada uma, um asset same-origin (sem script inline)', ({
    assert,
  }) => {
    // view → asset (checado em detalhe por view em `m12_assets.spec.ts`) →
    // bundle (checado no teste acima). Aqui só a ponta solta: nenhuma das
    // quatro voltou a ter o import inline que este arquivo testava antes.
    for (const view of WEBAUTHN_VIEWS) {
      assert.notInclude(read(view), `from '${ASSET_PATH}'`, `${view} importa ${ASSET_PATH} inline`);
    }
  });

  test('nenhuma view referencia domínio externo (anti-regressão de CDN)', ({ assert }) => {
    // Barato e específico: qualquer volta ao jsdelivr/unpkg/tailwind CDN quebra
    // aqui em vez de quebrar o login de quem roda com CSP `script-src 'self'`.
    const offenders = scanForExternalReferences(allViews(), read);
    assert.deepEqual(offenders, [], `views com referência externa:\n${offenders.join('\n')}`);
  });

  /**
   * M12 (auditoria de segurança): `login.edge`, `mfa-challenge.edge`,
   * `account/confirm.edge`, `account/mfa.edge` e `partials/submit_lock.edge`
   * embutiam `<script>`/`<script type="module">` INLINE — um IdP com CSP
   * `script-src 'self'` (sem `'unsafe-inline'`, sem nonce/hash — a postura
   * recomendada num IdP) bloqueia esse script silenciosamente, e a
   * funcionalidade por trás (autofill/botão de passkey, anti-duplo-submit,
   * verificação WebAuthn do `/account/confirm`) simplesmente não roda, sem
   * erro visível. Mesma classe do bug do splash de logout (`0.61.3`): todos
   * migrados para assets same-origin em `/authkit/assets/*.js`.
   */
  test('nenhuma view embute <script> inline sem src (anti-regressão de CSP — M12)', ({
    assert,
  }) => {
    const offenders = scanForInlineScripts(allViews(), read);
    assert.deepEqual(offenders, [], `views com <script> inline:\n${offenders.join('\n')}`);
  });

  /**
   * Os stubs escapavam da varredura acima — e foi exatamente por isso que
   * `stubs/ui/edge/views/{login,consent}.edge` carregaram o Tailwind Play CDN
   * (`<script src="https://cdn.tailwindcss.com">`) sem ninguém notar.
   *
   * Um stub é PIOR que uma view da lib nesse quesito: depois de ejetado ele
   * pertence ao host, e uma correção no pacote não o alcança mais. O que sai
   * pelo `configure` tem que ser autocontido no momento em que sai.
   */
  test('nenhum stub referencia domínio externo (anti-regressão de CDN)', ({ assert }) => {
    const offenders = scanForExternalReferences(allStubs(), (p) =>
      readFileSync(stubsDir + p, 'utf8'),
    );
    assert.deepEqual(offenders, [], `stubs com referência externa:\n${offenders.join('\n')}`);
  });

  /**
   * Guarda o motivo de o preset `edge` não scaffoldar nada.
   *
   * Existiam stubs Edge de login/consent que nenhum caminho de código
   * publicava (`uiStubPaths('edge')` sempre devolveu `[]`) — código morto que
   * ainda assim ia no pacote publicado carregando um CDN. Foram removidos: a
   * customização de views Edge é via `node ace authkit:eject --views`, que
   * copia as views REAIS da lib (com i18n, CSRF, passkey e o CSS compilado em
   * `partials/styles.edge`).
   *
   * Se alguém recriar os stubs Edge, este teste falha e força a pergunta: por
   * que duplicar as views da lib num scaffold inferior?
   */
  test('o preset edge não tem stubs de view (customização é via authkit:eject --views)', ({
    assert,
  }) => {
    const edgeStubs = allStubs().filter((p) => p.startsWith('ui/edge/'));
    assert.deepEqual(
      edgeStubs,
      [],
      `stubs Edge não são publicados por nenhum caminho de código; use authkit:eject --views:\n${edgeStubs.join('\n')}`,
    );
  });
});
