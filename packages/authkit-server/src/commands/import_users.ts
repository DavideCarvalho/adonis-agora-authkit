import type { AccountStore } from '../accounts/account_store.js';
import { supportsAccountImport } from '../accounts/account_store.js';

/** Uma linha do arquivo de import (campos extras viram custom — globalRoles). */
export interface ImportUserRecord {
  email?: string;
  /** Hash de senha já pronto (qualquer formato). Inserido como está (lazy rehash). */
  password_hash?: string | null;
  name?: string | null;
  email_verified?: boolean;
  /** Papéis globais (opcional). */
  global_roles?: string[];
}

/** Relatório agregado do import. */
export interface ImportReport {
  created: number;
  /** Pulados por e-mail duplicado (já existente). */
  skippedDuplicate: number;
  /** Linhas com erro de parsing/validação. */
  errors: { line: number; reason: string }[];
}

/**
 * Faz o parse do conteúdo do arquivo: aceita NDJSON (uma linha JSON por usuário)
 * OU um array JSON. Retorna os registros + os erros de parsing por linha. PURO
 * (sem I/O) para ser testável.
 */
export function parseImportFile(content: string): {
  records: { line: number; record: ImportUserRecord }[];
  parseErrors: { line: number; reason: string }[];
} {
  const trimmed = content.trim();
  const records: { line: number; record: ImportUserRecord }[] = [];
  const parseErrors: { line: number; reason: string }[] = [];

  if (trimmed.startsWith('[')) {
    // Array JSON.
    try {
      const arr = JSON.parse(trimmed);
      if (!Array.isArray(arr)) {
        parseErrors.push({ line: 1, reason: 'expected a JSON array or NDJSON' });
        return { records, parseErrors };
      }
      arr.forEach((record, i) => {
        records.push({ line: i + 1, record });
      });
    } catch (error) {
      parseErrors.push({ line: 1, reason: `invalid JSON array: ${(error as Error).message}` });
    }
    return { records, parseErrors };
  }

  // NDJSON: uma linha JSON por usuário (linhas vazias ignoradas).
  const lines = trimmed.split('\n');
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    try {
      records.push({ line: i + 1, record: JSON.parse(line) });
    } catch (error) {
      parseErrors.push({ line: i + 1, reason: `invalid JSON: ${(error as Error).message}` });
    }
  });
  return { records, parseErrors };
}

/**
 * Importa os registros pelo account store (sem re-hash — o lazy rehash no login
 * migra). Idempotente por e-mail (duplicados são pulados). Com `dryRun`, NÃO
 * persiste nada (só valida e conta o que SERIA criado).
 *
 * Lógica PURA quanto a I/O de arquivo (recebe os registros já parseados) — fácil
 * de testar. Lança se o store não suporta import nem create.
 */
export async function importUsers(
  store: AccountStore,
  records: { line: number; record: ImportUserRecord }[],
  options: { dryRun?: boolean } = {},
): Promise<ImportReport> {
  const report: ImportReport = { created: 0, skippedDuplicate: 0, errors: [] };
  const canImport = supportsAccountImport(store);

  for (const { line, record } of records) {
    const email = record.email?.trim();
    if (!email) {
      report.errors.push({ line, reason: 'missing email' });
      continue;
    }

    // Duplicado: e-mail já existe → pula.
    const existing = await store.findByEmail(email);
    if (existing) {
      report.skippedDuplicate++;
      continue;
    }

    if (options.dryRun) {
      report.created++;
      continue;
    }

    try {
      if (canImport) {
        const created = await store.importAccount({
          email,
          passwordHash: record.password_hash ?? null,
          fullName: record.name ?? null,
          globalRoles: record.global_roles,
          emailVerified: record.email_verified ?? false,
        });
        // null = corrida (e-mail criado entre o check e o insert) → conta como dup.
        if (created) report.created++;
        else report.skippedDuplicate++;
      } else {
        // Fallback: store sem import — usa create (re-hasheia e aplica política).
        // Útil quando o registro traz senha em claro; sem hash nem senha falha.
        report.errors.push({ line, reason: 'store does not support account import' });
      }
    } catch (error) {
      report.errors.push({ line, reason: (error as Error).message });
    }
  }

  return report;
}
