import { randomBytes } from 'node:crypto';
import { Scrypt } from '@adonisjs/core/hash/drivers/scrypt';
import { DateTime } from 'luxon';
import {
  OTP_LOGIN_PREFIX,
  decodeOtpToken,
  encodeOtpToken,
  evaluateLoginOtp,
  generateOtpCode,
  hashLoginOtp,
  linkTokenFromOtpUrl,
} from '../../host/otp_login.js';
import type {
  AccountImportCapability,
  AccountSecurityCapability,
  CoreAccountStore,
  CreateAccountInput,
  MagicLinkCapability,
  OtpLoginCapability,
} from '../account_store.js';
import type { LucidStoreContext } from './shared.js';
import { hasColumn } from './status_profile.js';
import {
  generateExpiringHashedToken,
  generateHashedToken,
  parseExpiringTokenExp,
  rawToDbToken,
  rawToExpiringDbToken,
  sha256Hex,
} from './token_hash.js';

/**
 * Prefixo do token de troca de e-mail (reaproveita a coluna emailVerificationToken).
 *
 * Formato ARMAZENADO (plan 009): `ec:<b64email>:<exp>:sha256(<random>)` — o
 * e-mail continua em base64url (inalterado, plan 007 não mexeu nisso), mas
 * agora carrega uma deadline (`exp`, epoch ms) e o `random` vai HASHEADO em
 * repouso (antes ia em claro). Ver a análise de segurança do `exp` embutido
 * em `token_hash.ts` (`rawToExpiringDbToken`/`parseExpiringTokenExp`).
 *
 * Limite prático: com um e-mail codificado em base64url, o valor cabe em
 * VARCHAR(255) para e-mails de até ~129 bytes (`3 + b64(129) + 1 + 13 + 1 +
 * 64 = 254`); acima disso o valor gravado excederia a coluna. Nenhum e-mail
 * real chega perto disso — é uma folga generosa, não um limite apertado.
 */
const EMAIL_CHANGE_PREFIX = 'ec:';

/** Prefixo do magic link (reaproveita as colunas de reset de senha). */
const MAGIC_LINK_PREFIX = 'ml:';

/**
 * Hasher usado SOMENTE para a verificação "dummy" anti-enumeração (mesma
 * instância/parâmetros do mixin withAuthUser). Não toca em hashes reais.
 */
const dummyHasher = new Scrypt({});

/**
 * Hash dummy pré-computado de uma senha aleatória (descartada). É um scrypt
 * REAL com os mesmos parâmetros de custo dos hashes de conta — verificar contra
 * ele gasta ~o mesmo tempo de CPU que verificar um hash legítimo.
 *
 * Promise resolvida UMA vez no boot do módulo; o caminho sem-row aguarda-a e
 * roda `dummyHasher.verify` para igualar o timing do caminho com-row, mitigando
 * account enumeration por timing no login (OWASP).
 */
const dummyHashPromise: Promise<string> = dummyHasher.make(randomBytes(32).toString('hex'));

/**
 * Núcleo SEMPRE presente do {@link CoreAccountStore} sobre um model Lucid:
 * identidade, cadastro, reset de senha, verificação de e-mail, administração
 * (listagem paginada + roles globais) e o self-service de segurança
 * ({@link AccountSecurityCapability}: trocar senha/e-mail).
 */
export function buildCore(
  ctx: LucidStoreContext,
): CoreAccountStore &
  AccountSecurityCapability &
  MagicLinkCapability &
  OtpLoginCapability &
  AccountImportCapability {
  const { Model, toAccount } = ctx;

  return {
    async findById(id) {
      const row = await Model.find(id);
      return row ? toAccount(row) : null;
    },

    async findByEmail(email) {
      const row = await Model.query().where('email', email).first();
      return row ? toAccount(row) : null;
    },

    async verifyCredentials(email, password) {
      const row = await Model.query().where('email', email).first();
      if (!row) {
        // Anti-enumeração por timing: e-mail inexistente roda uma verificação
        // scrypt DUMMY (mesmo custo do caminho real) e descarta o resultado, de
        // modo que com-row e sem-row gastem ~o mesmo tempo de CPU. Best-effort:
        // qualquer erro aqui NÃO altera o retorno (segue null).
        try {
          const dummyHash = await dummyHashPromise;
          await ctx.passwords.verify(dummyHash, password, {
            nativeVerify: (hashed: string, plain: string) => dummyHasher.verify(hashed, plain),
            needsRehash: () => false,
          });
        } catch {
          // ignora — o objetivo é só gastar o tempo equivalente.
        }
        return null;
      }
      const result = await ctx.passwords.verify(row.password, password, {
        nativeVerify: (_hashed: string, plain: string) => row.verifyPassword(plain),
        needsRehash: () => row.passwordNeedsRehash(),
      });
      if (!result.ok) return null;
      // Lazy rehash transparente (padrão Auth0/Clerk): senha confere mas o hash
      // está em formato legado OU com parâmetros desatualizados → re-hasheia com o
      // hasher atual e persiste. Best-effort: uma falha no rehash NÃO falha o login.
      if (result.rehash) {
        try {
          row.password = password; // o @beforeSave do mixin re-hasheia
          await row.save();
          await ctx.audit?.record({ type: 'password.rehashed', accountId: row.id });
        } catch {
          // ignora — o usuário já está autenticado; o rehash tentará de novo no próximo login.
        }
      }
      return toAccount(row);
    },

    async create(input: CreateAccountInput) {
      // Aplica a política de senha (comprimento/complexidade + vazamento) à senha
      // nova. Lança PasswordPolicyError quando viola — o controller traduz a chave.
      await ctx.passwords.assertAcceptable(input.password);
      // Aplica o pepper antes do hash (o @beforeSave do mixin hasheia o que receber).
      const pepperedPassword = ctx.passwords.applyCurrentPepper(input.password);
      const now = DateTime.now();
      const row = await Model.create({
        email: input.email,
        password: pepperedPassword,
        fullName: input.fullName ?? null,
        globalRoles: input.globalRoles ?? [],
        emailVerifiedAt: input.emailVerified ? now : null,
        // Registra quando a senha foi definida (se a coluna existe).
        ...(hasColumn(Model, 'passwordChangedAt') ? { passwordChangedAt: now } : {}),
      });
      return toAccount(row);
    },

    async importAccount(input) {
      // Skip se o e-mail já existe (idempotência do import).
      const existing = await Model.query().where('email', input.email).first();
      if (existing) return null;
      // Cria com uma senha aleatória (que o @beforeSave hasheia) só para satisfazer
      // a coluna NOT NULL; em seguida sobrescreve com o hash de ORIGEM via query
      // builder (bypassa o @beforeSave, então o hash entra COMO ESTÁ — o lazy rehash
      // no 1º login migra para o hasher atual). NÃO aplica a política de senha.
      const row = await Model.create({
        email: input.email,
        password: randomBytes(24).toString('hex'),
        fullName: input.fullName ?? null,
        globalRoles: input.globalRoles ?? [],
        emailVerifiedAt: input.emailVerified ? DateTime.now() : null,
      });
      if (input.passwordHash) {
        await Model.query().where('id', row.id).update({ password: input.passwordHash });
        row.password = input.passwordHash;
        // Limpa o dirty para que um save futuro não re-hasheie este hash de origem.
        row.$attributes.password = input.passwordHash;
      }
      return toAccount(row);
    },

    async issuePasswordResetToken(email) {
      const row = await Model.query().where('email', email).first();
      if (!row) return null;
      // Token BRUTO devolvido ao chamador (vai pro e-mail); só o HASH (sha256 da
      // parte aleatória) é persistido — um dump da tabela não rende um token
      // usável (mesmo padrão de host/otp_lockout.ts).
      const { raw: token, dbValue } = generateHashedToken();
      row.passwordResetToken = dbValue;
      row.passwordResetExpiresAt = DateTime.now().plus({ hours: 1 });
      await row.save();
      return { token, account: toAccount(row) };
    },

    async consumePasswordResetToken(token, newPassword) {
      // Magic links (`ml:` e `ml2:` com OTP) NÃO são tokens de reset de senha —
      // só o fluxo de consumeMagicLinkToken pode consumi-los (não trocam senha).
      // Checagem de prefixo acontece ANTES do hash, sobre o token BRUTO recebido.
      if (token.startsWith(MAGIC_LINK_PREFIX) || token.startsWith(OTP_LOGIN_PREFIX)) return false;
      const row = await Model.query().where('passwordResetToken', rawToDbToken('', token)).first();
      if (!row) return false;
      if (!row.passwordResetExpiresAt || row.passwordResetExpiresAt < DateTime.now()) return false;
      // Política de senha aplicada também no reset (lança PasswordPolicyError).
      await ctx.passwords.assertAcceptable(newPassword);
      // Aplica o pepper antes do hash.
      row.password = ctx.passwords.applyCurrentPepper(newPassword);
      row.passwordResetToken = null;
      row.passwordResetExpiresAt = null;
      // Atualiza o timestamp da última troca (se a coluna existe).
      if (hasColumn(Model, 'passwordChangedAt')) {
        row.passwordChangedAt = DateTime.now();
      }
      await row.save();
      return true;
    },

    // ----- Magic link (login passwordless) -----

    async issueMagicLinkToken(email) {
      const row = await Model.query().where('email', email).first();
      if (!row) return null;
      // Token `ml:<random>` nas colunas de reset (sem migração); o prefixo o
      // distingue de um token de reset de senha. Curta duração (15 min).
      // O prefixo fica em CLARO no valor persistido — só a parte aleatória é
      // hasheada — porque os guards de discriminação de fluxo leem esse prefixo
      // direto do valor armazenado (ver consumePasswordResetToken/consumeMagicLinkToken).
      const { raw: token, dbValue } = generateHashedToken(MAGIC_LINK_PREFIX);
      row.passwordResetToken = dbValue;
      row.passwordResetExpiresAt = DateTime.now().plus({ minutes: 15 });
      await row.save();
      return { token, account: toAccount(row) };
    },

    async consumeMagicLinkToken(token) {
      if (!token) return null;

      // Magic link com OTP ativo: o slot guarda `ml2:<linkToken>:<...>` mas a URL
      // carrega só `ml2:<linkToken>`. Busca pelo prefixo do link (linkToken é hex
      // validado — sem metacaractere de LIKE) e consome o slot inteiro (mata o
      // código junto — single-use conjunto).
      if (token.startsWith(OTP_LOGIN_PREFIX)) {
        const linkToken = linkTokenFromOtpUrl(token);
        if (!linkToken) return null;
        // O slot armazena o HASH do link-token (não o valor bruto da URL); o
        // padrão do LIKE precisa ser construído sobre o hash. `sha256Hex` sempre
        // devolve hex minúsculo — sem metacaractere de LIKE, então isso não
        // reabre a guarda de LIKE-injection que `linkTokenFromOtpUrl` já fecha.
        const linkTokenHash = sha256Hex(linkToken);
        const row = await Model.query()
          .where('passwordResetToken', 'like', `${OTP_LOGIN_PREFIX}${linkTokenHash}:%`)
          .first();
        if (!row) return null;
        if (!row.passwordResetExpiresAt || row.passwordResetExpiresAt < DateTime.now()) return null;
        row.passwordResetToken = null;
        row.passwordResetExpiresAt = null;
        await row.save();
        return toAccount(row);
      }

      if (!token.startsWith(MAGIC_LINK_PREFIX)) return null;
      const row = await Model.query()
        .where('passwordResetToken', rawToDbToken(MAGIC_LINK_PREFIX, token))
        .first();
      if (!row) return null;
      if (!row.passwordResetExpiresAt || row.passwordResetExpiresAt < DateTime.now()) return null;
      // Single-use: limpa o token (NÃO altera a senha).
      row.passwordResetToken = null;
      row.passwordResetExpiresAt = null;
      await row.save();
      return toAccount(row);
    },

    // ----- Login por OTP (código digitável — extensão do magic link) -----

    async issueMagicLinkWithCode(email, uid, opts) {
      const row = await Model.query().where('email', email).first();
      if (!row) return null;
      // `linkToken` BRUTO vai só na URL; o slot armazena o HASH dele (NÃO o
      // valor bruto) — `codeHash` já é sha256(uid:code) e NÃO é re-hasheado aqui.
      const linkToken = randomBytes(32).toString('hex');
      const linkTokenHash = sha256Hex(linkToken);
      const code = generateOtpCode(opts.digits);
      const codeHash = hashLoginOtp(uid, code);
      const codeExpMs = DateTime.now().plus({ minutes: opts.ttlMinutes }).toMillis();
      // Slot `ml2:` — código + link juntos, contador em 0. Ver host/otp_login.ts.
      row.passwordResetToken = encodeOtpToken({
        linkToken: linkTokenHash,
        codeHash,
        codeExpMs,
        attempts: 0,
      });
      // O LINK herda a validade padrão do magic link (15 min); o CÓDIGO carrega o
      // próprio `codeExpMs` (mais curto) embutido no slot.
      row.passwordResetExpiresAt = DateTime.now().plus({ minutes: 15 });
      await row.save();
      return { token: `${OTP_LOGIN_PREFIX}${linkToken}`, code, account: toAccount(row) };
    },

    async verifyLoginCode(email, uid, code, opts) {
      // ── Atomicidade do contador de lockout (barreira PRIMÁRIA, fail-closed) ──
      // O contador de tentativas vive DENTRO do slot `ml2:` e é a única barreira
      // contra brute-force do código curto (o throttle de rota é camada EXTRA e
      // pode estar ausente). Um read-modify-write ingênuo (first→avaliar→save) é
      // derrotável por concorrência: N requests leem o MESMO contador, todos
      // gravam `attempts+1` (last-write-wins) e o lockout nunca dispara — pior,
      // como a COMPARAÇÃO do código acontece após a leitura, N requests
      // concorrentes conseguem N comparações contra o MESMO valor do contador,
      // varrendo o espaço de 10^6 dentro do TTL.
      //
      // Correção: serializa o read-compare-write numa TRANSAÇÃO com row-lock
      // (`forUpdate`). Cada tentativa lê o estado JÁ commitado pela anterior, o
      // contador avança 1-a-1 e — porque a comparação vive DENTRO da seção
      // crítica — o total de comparações contra um mesmo código fica limitado a
      // `maxAttempts` (garantia DURA, não probabilística). No Postgres o lock é
      // por linha; no sqlite a própria transação serializa. Os demais caminhos
      // que tocam o slot (`consumeMagicLinkToken`, sucesso do OTP) só gravam
      // `null` (terminal) — não regridem contador — e ainda serializam atrás
      // deste lock (todo UPDATE trava a linha), então não podem ressuscitar um
      // slot já consumido nem apagar um incremento.
      const trx = await Model.query().client.transaction();
      try {
        const row = await Model.query({ client: trx }).where('email', email).forUpdate().first();
        if (!row) {
          await trx.commit();
          return { status: 'no_code' };
        }
        const parsed = decodeOtpToken(row.passwordResetToken);
        const evaluation = evaluateLoginOtp({
          parsed,
          uid,
          code,
          nowMs: DateTime.now().toMillis(),
          maxAttempts: opts.maxAttempts,
        });
        // Efeito de persistência: `undefined` = não escreve; `null` = limpa o slot
        // (sucesso, mata o link junto); string = novo slot (contador++/invalidação).
        // A escrita ocorre DENTRO da mesma transação/lock da leitura.
        if (evaluation.nextToken === null) {
          row.useTransaction(trx);
          row.passwordResetToken = null;
          row.passwordResetExpiresAt = null;
          await row.save();
        } else if (typeof evaluation.nextToken === 'string') {
          // Contador/invalidação: preserva a validade do LINK (só o código muda).
          row.useTransaction(trx);
          row.passwordResetToken = evaluation.nextToken;
          await row.save();
        }
        await trx.commit();
        if (evaluation.result === 'ok') return { status: 'ok', account: toAccount(row) };
        return { status: evaluation.result };
      } catch (error) {
        await trx.rollback();
        throw error;
      }
    },

    async issueEmailVerificationToken(email) {
      const row = await Model.query().where('email', email).first();
      if (!row) return null;
      // Token `<exp>:<random>` (sem prefixo — mesma coluna de sempre); só o
      // HASH da parte aleatória é persistido, e o `exp` (deadline, epoch ms)
      // vai em CLARO dentro do valor gravado. Ver a análise de segurança em
      // `token_hash.ts` (generateExpiringHashedToken): o `exp` só é confiável
      // DEPOIS que a igualdade de hash bater — é essa igualdade que prova que
      // ele não foi adulterado pelo cliente.
      const expiresAt = DateTime.now().plus({ hours: ctx.emailVerificationTtlHours ?? 24 });
      const { raw: token, dbValue } = generateExpiringHashedToken('', expiresAt);
      row.emailVerificationToken = dbValue;
      await row.save();
      return { token, account: toAccount(row) };
    },

    async consumeEmailVerificationToken(token) {
      if (!token) return false;
      // Tokens de troca de e-mail (`ec:`) NÃO são verificações de cadastro — só o
      // fluxo de confirmEmailChange pode consumi-los.
      if (token.startsWith(EMAIL_CHANGE_PREFIX)) return false;
      const dbValue = rawToExpiringDbToken('', token);
      const row = await Model.query().where('emailVerificationToken', dbValue).first();
      if (!row) return false;
      // O `exp` só é lido AGORA, depois que a busca por `dbValue` já achou uma
      // linha — esse match prova que este `exp` é o mesmo gravado no issue,
      // não um valor que o cliente escreveu na hora. `null` (ausente/não-
      // parseável — inclusive tokens gravados por uma versão anterior desta
      // lib, sem `exp` nenhum) conta como EXPIRADO (fail-closed), mirando o
      // mesmo formato de `!row.passwordResetExpiresAt || ... < DateTime.now()`
      // usado no reset de senha.
      const exp = parseExpiringTokenExp('', token);
      if (exp === null || exp < DateTime.now().toMillis()) return false;
      row.emailVerifiedAt = DateTime.now();
      row.emailVerificationToken = null;
      await row.save();
      return true;
    },

    // ----- Administração (console admin) -----

    async listAccounts(params) {
      const page = Math.max(1, params.page ?? 1);
      const limit = Math.max(1, params.limit ?? 20);
      const search = params.search?.trim();

      const base = () => {
        const q = Model.query();
        // Filtro por e-mail (substring, case-insensitive). `whereILike` cai no LIKE
        // no sqlite (case-insensitive por default p/ ASCII), e em ILIKE no Postgres.
        if (search) q.whereILike('email', `%${search}%`);
        return q;
      };

      const countResult = await base().count('* as total');
      // O shape do count varia por dialeto; lê de $extras.total (Lucid).
      const total = Number(countResult[0]?.$extras?.total ?? 0);

      const rows = await base()
        .orderBy('email', 'asc')
        .offset((page - 1) * limit)
        .limit(limit);

      return { data: rows.map(toAccount), total };
    },

    async setGlobalRoles(accountId, roles) {
      const row = await Model.find(accountId);
      if (!row) return;
      // A coluna `globalRoles` é serializada como JSON pelo mixin withAuthUser.
      row.globalRoles = roles;
      await row.save();
    },

    // ----- Self-service de segurança (console de conta) -----

    async changePassword(accountId, newPassword) {
      const row = await Model.find(accountId);
      if (!row) return false;
      // Política de senha aplicada na troca (lança PasswordPolicyError).
      await ctx.passwords.assertAcceptable(newPassword);
      // O hash acontece no @beforeSave do mixin withAuthUser ao detectar $dirty.password.
      // Aplica o pepper antes do hash.
      const pepperedNew = ctx.passwords.applyCurrentPepper(newPassword);
      row.password = pepperedNew;
      // Atualiza o timestamp da última troca (se a coluna existe).
      if (hasColumn(Model, 'passwordChangedAt')) {
        row.passwordChangedAt = DateTime.now();
      }
      await row.save();
      return true;
    },

    async requestEmailChange(accountId, newEmail) {
      const row = await Model.find(accountId);
      if (!row) return null;
      // Não permite tomar um e-mail já usado por OUTRA conta.
      const taken = await Model.query().where('email', newEmail).first();
      if (taken && taken.id !== row.id) return null;
      // Token = `ec:<base64url(newEmail)>:<exp>:<random>`. Reaproveita a coluna
      // emailVerificationToken (sem migração nova); o prefixo `ec:` distingue do
      // token de verificação de cadastro. O e-mail viaja codificado no próprio
      // token (sem coluna extra para o "pending email"); o `exp` (deadline,
      // epoch ms) também viaja em CLARO no token — ver a análise de segurança
      // em `token_hash.ts` (generateExpiringHashedToken/rawToExpiringDbToken):
      // só a parte `random` é hasheada, e é a igualdade sobre a string INTEIRA
      // (prefixo + e-mail + exp + hash) que impede o cliente de adulterar o
      // `exp` sem invalidar o próprio token.
      const encodedEmail = Buffer.from(newEmail, 'utf8').toString('base64url');
      const expiresAt = DateTime.now().plus({ hours: ctx.emailChangeTtlHours ?? 1 });
      const { raw: token, dbValue } = generateExpiringHashedToken(
        `${EMAIL_CHANGE_PREFIX}${encodedEmail}:`,
        expiresAt,
      );
      row.emailVerificationToken = dbValue;
      await row.save();
      return { token, account: toAccount(row), newEmail };
    },

    async confirmEmailChange(token) {
      if (!token || !token.startsWith(EMAIL_CHANGE_PREFIX)) return { ok: false as const };
      const parts = token.split(':');
      // Forma esperada (plan 009): ['ec', '<b64email>', '<exp>', '<random>'] —
      // 4 partes (era 3 antes de embutir o `exp`).
      if (parts.length !== 4) return { ok: false as const };
      let newEmail: string;
      try {
        newEmail = Buffer.from(parts[1], 'base64url').toString('utf8');
      } catch {
        return { ok: false as const };
      }
      if (!newEmail) return { ok: false as const };
      const prefix = `${EMAIL_CHANGE_PREFIX}${parts[1]}:`;
      const dbValue = rawToExpiringDbToken(prefix, token);
      const row = await Model.query().where('emailVerificationToken', dbValue).first();
      if (!row) return { ok: false as const };
      // O `exp` só é lido DEPOIS do match acima (mesmo raciocínio de
      // consumeEmailVerificationToken) — `null` (ausente/não-parseável) conta
      // como EXPIRADO, fail-closed.
      const exp = parseExpiringTokenExp(prefix, token);
      if (exp === null || exp < DateTime.now().toMillis()) return { ok: false as const };
      // Defesa contra corrida: o e-mail pode ter sido tomado entre o pedido e a
      // confirmação por outra conta.
      const taken = await Model.query().where('email', newEmail).first();
      if (taken && taken.id !== row.id) return { ok: false as const };
      // Captura o e-mail antigo ANTES de sobrescrever (para notificações de segurança).
      const oldEmail = row.email as string;
      row.email = newEmail;
      row.emailVerifiedAt = DateTime.now();
      row.emailVerificationToken = null;
      await row.save();
      return { ok: true as const, account: toAccount(row), oldEmail, newEmail };
    },
  };
}
