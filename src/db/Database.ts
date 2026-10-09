/**
 * SQLite 访问层（方案 §8）。
 * - WAL + 外键 + busy_timeout；写操作走短事务，API 请求期间不持有写事务。
 * - 迁移按版本号顺序执行，记录在 schema_migrations。
 * - 备份用 VACUUM INTO（一致性备份，不在运行中裸复制主文件而忽略 WAL）。
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** schema.sql 与编译产物同目录（构建时由 npm run build 复制） */
export function schemaPath(): string {
    const local = join(HERE, 'schema.sql');
    if (existsSync(local)) return local;
    return join(HERE, '..', '..', 'src', 'db', 'schema.sql');
}

export type SqlParam = string | number | bigint | null | Uint8Array;
export type Row = Record<string, unknown>;

/** node:sqlite 不接受 undefined / boolean，统一归一化，避免静默丢参数 */
function norm(params: unknown[]): SqlParam[] {
    return params.map((p) => {
        if (p === undefined) return null;
        if (typeof p === 'boolean') return p ? 1 : 0;
        if (p === null) return null;
        if (typeof p === 'number' && !Number.isFinite(p)) return null;
        return p as SqlParam;
    });
}

export class Db {
    readonly raw: DatabaseSync;
    private inTx = false;

    constructor(path: string) {
        if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
        this.raw = new DatabaseSync(path);
        this.exec('PRAGMA foreign_keys = ON');
        this.exec('PRAGMA busy_timeout = 5000');
        if (path !== ':memory:') {
            this.exec('PRAGMA journal_mode = WAL');
            this.exec('PRAGMA synchronous = NORMAL');
        }
    }

    exec(sql: string): void { this.raw.exec(sql); }

    all<T = Row>(sql: string, ...params: unknown[]): T[] {
        return this.raw.prepare(sql).all(...norm(params)) as T[];
    }
    get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
        return this.raw.prepare(sql).get(...norm(params)) as T | undefined;
    }
    run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number } {
        const r = this.raw.prepare(sql).run(...norm(params));
        return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    }

    /** 短事务；嵌套调用复用外层事务 */
    tx<T>(fn: () => T): T {
        if (this.inTx) return fn();
        this.exec('BEGIN IMMEDIATE');
        this.inTx = true;
        try {
            const out = fn();
            this.exec('COMMIT');
            return out;
        } catch (e) {
            try { this.exec('ROLLBACK'); } catch { /* 已回滚 */ }
            throw e;
        } finally {
            this.inTx = false;
        }
    }

    migrate(): void {
        const sql = readFileSync(schemaPath(), 'utf8');
        this.exec(sql);
        const row = this.get<{ v: number }>('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations');
        if ((row?.v ?? 0) < 1) {
            this.run('INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES (?,?,?)', 1, 'p1-initial', new Date().toISOString());
        }
    }

    /** 一致性备份：VACUUM INTO。返回备份文件路径。 */
    backupTo(dir: string, label = 'poly-sniper'): string {
        mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const file = join(dir, `${label}-${stamp}.sqlite`);
        this.raw.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
        return file;
    }

    integrityCheck(): string {
        const rows = this.all<{ integrity_check: string }>('PRAGMA integrity_check');
        return rows.map((r) => r.integrity_check).join(';');
    }

    close(): void { this.raw.close(); }
}

export function openDb(path: string): Db {
    const db = new Db(path);
    db.migrate();
    return db;
}
