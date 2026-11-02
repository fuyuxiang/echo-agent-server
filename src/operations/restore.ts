import { readFile } from 'node:fs/promises';
import { restoreFullBackup } from './backup.js';
const [archive, target, flag] = process.argv.slice(2);
if (!archive || !target) {
    console.error('Usage: npm run backup:restore -- BACKUP.zip NEW_EMPTY_DIRECTORY [--verify-only]');
    process.exitCode = 1;
}
else {
    try {
        const result = await restoreFullBackup(await readFile(archive), target, flag === '--verify-only');
        console.log(JSON.stringify({ ok: true, ...result, mode: flag === '--verify-only' ? 'verified' : 'restored' }));
    }
    catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
    }
}
