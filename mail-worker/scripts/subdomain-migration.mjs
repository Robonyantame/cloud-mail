import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { subdomainSchema } from '../src/init/subdomain-schema.js';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--existing-column') || args.length > 1) {
	console.error('Usage: npm run subdomain:migration -- [--existing-column]');
	process.exitCode = 1;
} else {
	const statements = args.includes('--existing-column') ? []
		: ['ALTER TABLE account ADD COLUMN mailbox_kind INTEGER NOT NULL DEFAULT 0'];
	const directory = resolve('.wrangler');
	await mkdir(directory, { recursive: true });
	const path = resolve(directory, 'subdomain-migration.sql');
	await writeFile(path, [...statements, ...subdomainSchema].join(';\n\n') + ';\n');
	console.log(`Generated ${path}; no database was modified.`);
}
