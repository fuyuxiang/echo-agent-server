import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, mkdir, writeFile, rm, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
import { openDb, backupTo, type DB } from '../db/index.js';
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
async function files(root: string, prefix = ''): Promise<string[]> {
    let entries;
    try {
        entries = await readdir(join(root, prefix), { withFileTypes: true });
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT')
            return [];
        throw e;
    }
    const result: string[] = [];
    for (const e of entries) {
        if (e.isSymbolicLink())
            throw new Error('备份目录包含符号链接，无法安全备份');
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory())
            result.push(...await files(root, rel));
        else if (e.isFile())
            result.push(rel);
    }
    return result;
}
function requiredAssets(db: DB): string[] {
    return (db.prepare(`SELECT storage_key AS key FROM documents WHERE storage_key IS NOT NULL
 UNION SELECT COALESCE(published_storage_key,quarantine_storage_key,storage_key) AS key FROM document_submissions WHERE scan_status='passed'
 UNION SELECT COALESCE(published_package_key,quarantine_package_key,package_key) AS key FROM skill_versions WHERE scan_status='passed'`).all() as {
        key: string;
    }[]).map(r => r.key).filter(Boolean);
}
export async function assetCount(storageDir: string): Promise<number> { return (await files(storageDir)).length; }
export async function createFullBackup(db: DB, storageDir: string): Promise<Buffer> {
    const temp = await mkdtemp(join(tmpdir(), 'echo-backup-'));
    try {
        await backupTo(db, join(temp, 'echo.db'));
        const zip = new JSZip(), hashes: Record<string, string> = {};
        const add = (path: string, data: Buffer) => { hashes[path] = digest(data); zip.file(path, data); };
        add('echo.db', await readFile(join(temp, 'echo.db')));
        for (const rel of await files(storageDir))
            add(`storage/${rel}`, await readFile(join(storageDir, rel)));
        const snapshot = openDb({ path: join(temp, 'echo.db'), skipMigrate: true });
        try {
            for (const key of requiredAssets(snapshot))
                if (!hashes[`storage/${key}`])
                    throw new Error(`备份缺少数据库引用的资产: ${key}，请在任务稳定后重试`);
        }
        finally {
            snapshot.close();
        }
        const manifest = { format: 1, createdAt: Date.now(), schemaVersion: db.pragma('user_version', { simple: true }), files: hashes, requiresMasterKey: true };
        zip.file('manifest.json', JSON.stringify(manifest, null, 2));
        zip.file('RESTORE.txt', 'Stop the server. Verify and restore into a NEW empty directory using npm run backup:restore -- BACKUP.zip TARGET. Keep ECHO_MASTER_KEY, ECHO_JWT_SECRET and signing-key configuration separately. Start with ECHO_DB_PATH=TARGET/echo.db and ECHO_STORAGE_DIR=TARGET/storage. This archive contains encrypted credentials and personal knowledge; store securely.\n');
        return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 3 } });
    }
    finally {
        await rm(temp, { recursive: true, force: true });
    }
}
export async function restoreFullBackup(archive: Buffer, destination: string, verifyOnly = false): Promise<{
    files: number;
    schemaVersion: number;
}> {
    const zip = await JSZip.loadAsync(archive, { checkCRC32: true });
    const manifest = JSON.parse(await zip.file('manifest.json')?.async('string') ?? 'null');
    if (!manifest || manifest.format !== 1 || !manifest.files || typeof manifest.files !== 'object')
        throw new Error('备份清单无效');
    const entries = Object.entries(manifest.files) as [
        string,
        string
    ][];
    if (!manifest.files['echo.db'] || entries.length > 100000)
        throw new Error('备份文件列表无效');
    const buffers = new Map<string, Buffer>();
    let size = 0;
    for (const [name, hash] of entries) {
        if ((name !== 'echo.db' && !name.startsWith('storage/')) || name.includes('\\') || name.split('/').some(p => !p || p === '.' || p === '..'))
            throw new Error('备份包含非法路径');
        const entry = zip.file(name);
        if (!entry)
            throw new Error(`文件缺失: ${name}`);
        const data = await entry.async('nodebuffer');
        size += data.length;
        if (size > 4 * 1024 ** 3)
            throw new Error('备份解压体积超过 4GB 限制');
        if (digest(data) !== hash)
            throw new Error(`校验失败: ${name}`);
        buffers.set(name, data);
    }
    const temp = await mkdtemp(join(tmpdir(), 'echo-verify-'));
    try {
        await writeFile(join(temp, 'check.db'), buffers.get('echo.db')!);
        const check = openDb({ path: join(temp, 'check.db'), skipMigrate: true });
        try {
            if (check.pragma('integrity_check', { simple: true }) !== 'ok')
                throw new Error('数据库完整性校验失败');
            for (const key of requiredAssets(check))
                if (!buffers.has(`storage/${key}`))
                    throw new Error(`备份缺少引用资产: ${key}`);
        }
        finally {
            check.close();
        }
    }
    finally {
        await rm(temp, { recursive: true, force: true });
    }
    if (!verifyOnly) {
        const target = resolve(destination);
        try {
            const st = await lstat(target);
            if (st.isSymbolicLink() || !st.isDirectory() || (await readdir(target)).length)
                throw new Error('恢复目标必须为新的空目录');
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
                throw e;
        }
        await mkdir(target, { recursive: true });
        for (const [name, data] of buffers) {
            const path = join(target, name);
            await mkdir(join(path, '..'), { recursive: true });
            await writeFile(path, data, { flag: 'wx', mode: 0o600 });
        }
    }
    return { files: entries.length, schemaVersion: manifest.schemaVersion };
}
