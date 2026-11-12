/**
 * Database backup and restore.
 *
 * A backup that has never been restored is a file, not a backup. So this module does two
 * things the naive version does not: it verifies the copy by opening it and reading the
 * schema, and restore takes a safety copy of the current database first, so a bad restore
 * is recoverable rather than fatal.
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export interface BackupResult {
  ok: boolean
  path: string | null
  bytes: number
  /** Tables found in the copy; empty means the copy is not a usable database. */
  tables: string[]
  error: string | null
}

export interface RestoreResult {
  ok: boolean
  /** Where the pre-restore copy was written, so a bad restore can be undone. */
  safetyCopy: string | null
  tables: string[]
  error: string | null
}

/**
 * Every table the current schema version defines.
 *
 * Taken from the CREATE TABLE statements in tasks/store.ts, not from a report: if a
 * migration adds a table, this list has to grow with it or a restore would accept a backup
 * that silently omits it. One list, used by the backup check and by the post-restore check,
 * so the two cannot drift apart.
 */
export const REQUIRED_TABLES: readonly string[] = [
  'schema_version',
  'tasks',
  'task_transitions',
  'attempts',
  'sessions',
  'runtimes',
  'verifications',
  'events',
  'projects',
  'project_configs',
  'project_events',
  'approvals',
  'project_locks',
  // v3 — the requirement system
  'advisor_conversations',
  'advisor_messages',
  'advisor_session_links',
  'context_snapshots',
  'attachments',
  'drafts',
  'draft_versions',
  'research_requests',
  'research_reports',
  'requirement_baselines',
  'change_proposals',
]

/** The schema version this build writes and can read back. */
export const SCHEMA_VERSION_MIN = 1
export const SCHEMA_VERSION_MAX = 3

/** Copy the database and prove the copy is readable. */
export function createBackup(dbPath: string, targetPath: string): BackupResult {
  const result: BackupResult = { ok: false, path: null, bytes: 0, tables: [], error: null }
  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    // VACUUM INTO writes a consistent snapshot without stopping the writer, which a plain
    // file copy cannot promise while WAL is active.
    const source = new DatabaseSync(dbPath)
    try {
      source.exec(`VACUUM INTO '${targetPath.split("'").join("''")}'`)
    } finally {
      source.close()
    }
    result.bytes = fs.statSync(targetPath).size
    result.tables = readTables(targetPath)
    const missing = REQUIRED_TABLES.filter((name) => !result.tables.includes(name))
    if (missing.length > 0) {
      result.error = 'the backup is missing required tables: ' + missing.join(', ')
      return result
    }
    result.ok = true
    result.path = targetPath
    return result
  } catch (error) {
    result.error = String((error as Error)?.message ?? error)
    return result
  }
}

export interface IntegrityReport {
  ok: boolean
  tables: string[]
  missingTables: string[]
  integrity: string
  foreignKeyViolations: number
  schemaVersion: number
  error: string | null
}

/**
 * Prove a database is usable, not merely openable.
 *
 * "It opened" says nothing about whether the rows survived. This checks the tables the app
 * needs, SQLite's own integrity and foreign-key checks, and the schema version, so a restore
 * that produced a structurally broken file is reported as a failure.
 */
export function verifyDatabase(
  dbPath: string,
  requiredTables: readonly string[],
  maxSchemaVersion: number,
  minSchemaVersion = SCHEMA_VERSION_MIN,
): IntegrityReport {
  const report: IntegrityReport = {
    ok: false,
    tables: [],
    missingTables: [],
    integrity: 'not checked',
    foreignKeyViolations: -1,
    schemaVersion: -1,
    error: null,
  }
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      report.tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((r) => r.name)
      report.missingTables = requiredTables.filter((name) => !report.tables.includes(name))
      const integrity = db.prepare('PRAGMA integrity_check').all() as { integrity_check?: string }[]
      report.integrity = integrity.map((row) => String(row.integrity_check ?? '')).join('; ') || 'empty'
      const fk = db.prepare('PRAGMA foreign_key_check').all() as unknown[]
      report.foreignKeyViolations = fk.length
      const version = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version?: number } | undefined
      report.schemaVersion = Number(version?.version ?? -1)
      report.ok =
        report.missingTables.length === 0 &&
        report.integrity === 'ok' &&
        report.foreignKeyViolations === 0 &&
        report.schemaVersion >= minSchemaVersion &&
        report.schemaVersion <= maxSchemaVersion
      return report
    } finally {
      db.close()
    }
  } catch (error) {
    report.error = String((error as Error)?.message ?? error)
    return report
  }
}

/** Open a database file and list its tables; throws when it is not a database. */
export function readTables(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]
    return rows.map((row) => row.name)
  } finally {
    db.close()
  }
}

/**
 * Replace the live database with a backup.
 *
 * The current database is copied aside first. If the restore fails at any point, the caller
 * still has both the original and the safety copy.
 */
export function restoreBackup(dbPath: string, backupPath: string, safetyPath: string): RestoreResult {
  const result: RestoreResult = { ok: false, safetyCopy: null, tables: [], error: null }
  try {
    // The safety copy is taken first, before anything is validated. A restore that is
    // refused because the backup is missing or unusable is exactly the moment the user
    // most needs a snapshot of what they still have.
    if (fs.existsSync(dbPath)) {
      fs.mkdirSync(path.dirname(safetyPath), { recursive: true })
      // A plain file copy misses transactions still in the WAL. VACUUM INTO produces a
      // consistent snapshot of the live database, which is what a safety copy has to be:
      // if the restore goes wrong, this file is the only way back.
      const snapshot = createBackup(dbPath, safetyPath)
      if (!snapshot.ok) {
        result.error = 'could not take a safety copy: ' + (snapshot.error ?? 'unknown')
        return result
      }
      result.safetyCopy = safetyPath
    }

    if (!fs.existsSync(backupPath)) {
      result.error = 'backup file does not exist'
      return result
    }
    const backupTables = readTables(backupPath)
    const absent = REQUIRED_TABLES.filter((name) => !backupTables.includes(name))
    if (absent.length > 0) {
      // Copying table by table would leave the target's rows for the absent tables in
      // place, producing a database that is half backup and half current data while
      // looking like a clean restore. Refuse instead.
      result.error = 'the backup is incomplete; it is missing: ' + absent.join(', ')
      return result
    }

    // Replacing the file directly is not reliable under WAL: the -wal and -shm handles can
    // outlive close() on Windows, and a stale journal beside a replaced database would
    // replay old frames into it. Instead the backup is written into the live file through
    // SQLite itself, which keeps the journal consistent and needs no file surgery.
    const source = new DatabaseSync(backupPath, { readOnly: true })
    try {
      const tables = source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
      if (tables.length === 0) {
        result.error = 'the backup contains no tables'
        return result
      }
      const target = new DatabaseSync(dbPath)
      try {
        // Copy every table's rows into the live database inside one transaction: either the
        // whole backup lands or the current data stays exactly as it was.
        target.exec('PRAGMA foreign_keys = OFF;')
        target.exec('BEGIN IMMEDIATE')
        try {
          for (const table of tables) {
            if (table.name.startsWith('sqlite_')) continue
            target.exec('DELETE FROM "' + table.name + '";')
            const rows = source.prepare('SELECT * FROM "' + table.name + '"').all() as Record<string, unknown>[]
            if (rows.length === 0) continue
            const columns = Object.keys(rows[0])
            const placeholders = columns.map(() => '?').join(', ')
            const insert = target.prepare('INSERT INTO "' + table.name + '" (' + columns.map((c) => '"' + c + '"').join(', ') + ') VALUES (' + placeholders + ')')
            for (const row of rows) insert.run(...columns.map((c) => row[c] as never))
          }
          target.exec('COMMIT')
        } catch (error) {
          target.exec('ROLLBACK')
          throw error
        } finally {
          target.exec('PRAGMA foreign_keys = ON;')
        }
      } finally {
        target.close()
      }
    } finally {
      source.close()
    }
    result.tables = readTables(dbPath)
    result.ok = true
    return result
    result.tables = readTables(dbPath)
    result.ok = true
    return result
  } catch (error) {
    result.error = String((error as Error)?.message ?? error)
    return result
  }
}
