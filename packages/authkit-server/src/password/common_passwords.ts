/**
 * Verificação offline de senhas comuns (common-password block).
 *
 * Carrega um arquivo embutido com as ~10 000 senhas mais comuns (derivado de
 * datasets públicos: rockyou, SecLists Common-Credentials, NIST SP 800-63B).
 * A checagem é case-insensitive e roda ANTES do HIBP em `assertAcceptable`.
 *
 * Armazenamento: Set<string> em memória, carregado UMA vez via lazy init.
 * Custo: ~50–80 KB de strings; carregamento é síncrono após a primeira chamada.
 *
 * Fonte dos dados: compilação de senhas comuns de domínio público.
 * Licença do arquivo de dados: CC0 / Public Domain.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Set em memória das senhas comuns (minúsculas). Inicializado na primeira
 * chamada a `isCommonPassword`. O módulo garante que o carregamento ocorre
 * apenas uma vez (lazy singleton).
 */
let _commonPasswordsSet: Set<string> | null = null;

/**
 * Carrega o arquivo de senhas comuns uma única vez (lazy).
 *
 * Onde o arquivo é esperado: o build script copia `common_passwords.txt`
 * para o mesmo diretório do módulo compilado (`build/src/password/`, já que
 * `tsc` com `rootDir: "./"` preserva o subcaminho `src/`). Em dev via
 * ts-exec (sem build), o módulo roda direto de `src/password/`, onde o
 * `.txt` já mora ao lado do `.ts` no repo.
 *
 * Checamos mais de um candidato — não só o caminho-irmão — para sobreviver
 * a uma mudança futura em `rootDir`/`outDir` ou a uma regressão no script de
 * cópia do build: o caminho-irmão cobre o layout atual (build e dev); os
 * demais são fallbacks para o layout antigo (`build/password/`) e para ler
 * direto de `src/` a partir de um build.
 *
 * FAIL-SAFE: se o arquivo não existir em nenhum candidato, ou não puder ser
 * lido (ex.: bundle sem assets), retorna um Set vazio — a checagem vira
 * no-op sem quebrar o fluxo. Uma senha comum indevidamente aceita é sempre
 * preferível a um login/signup quebrado por um asset ausente.
 */
function loadCommonPasswords(): Set<string> {
  if (_commonPasswordsSet !== null) return _commonPasswordsSet;

  try {
    const __dir = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(__dir, 'common_passwords.txt'), // caminho-irmão: build/src/password/ (prod) ou src/password/ (dev via ts-exec)
      join(__dir, '..', '..', 'password', 'common_passwords.txt'), // layout antigo: build/password/
      join(__dir, '..', '..', '..', 'src', 'password', 'common_passwords.txt'), // fallback: src/ a partir de um build
    ];
    const filePath = candidates.find((p) => existsSync(p));
    if (!filePath) throw new Error('common_passwords.txt not found in any candidate path');

    const content = readFileSync(filePath, 'utf-8');
    const entries = content
      .split('\n')
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
    _commonPasswordsSet = new Set(entries);
  } catch {
    // Fail-safe: arquivo ausente em todos os candidatos → Set vazio (no-op check).
    _commonPasswordsSet = new Set();
  }

  return _commonPasswordsSet;
}

/**
 * Verifica se a senha fornecida consta na lista offline de senhas comuns.
 *
 * A checagem é case-insensitive: "Password123" é tratado como "password123"
 * para fins de comparação. O carregamento da lista ocorre na primeira chamada.
 *
 * @returns `true` se a senha for considerada comum (deve ser rejeitada).
 */
export function isCommonPassword(plain: string): boolean {
  const set = loadCommonPasswords();
  return set.has(plain.toLowerCase());
}

/**
 * Número de entradas na lista de senhas comuns. Útil para testes e diagnóstico.
 */
export function commonPasswordsCount(): number {
  return loadCommonPasswords().size;
}

/**
 * Permite substituir o Set de senhas comuns (usado em testes).
 * @internal
 */
export function __setCommonPasswordsForTests(passwords: Set<string> | null): void {
  _commonPasswordsSet = passwords;
}
