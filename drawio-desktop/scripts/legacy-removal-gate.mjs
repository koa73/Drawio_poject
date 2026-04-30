import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');
const statusPath = path.join(repoRoot, 'docs', 'validation-status.json');

function fail(message)
{
	console.error(`[legacy-removal-gate] FAIL: ${message}`);
	process.exit(1);
}

async function main()
{
	let status = null;
	try
	{
		const raw = await fs.readFile(statusPath, 'utf8');
		status = JSON.parse(raw);
	}
	catch (e)
	{
		fail(`cannot read ${statusPath}: ${e.message}`);
	}

	const checks = (status && typeof status === 'object' && status.checks && typeof status.checks === 'object') ?
		status.checks : {};
	const required = ['seafStabilitySmoke', 'runtimeBuild', 'linuxDebBuild'];
	for (const key of required)
	{
		if (checks[key] !== true)
		{
			fail(`required check is not passed: ${key}`);
		}
	}

	console.log('[legacy-removal-gate] PASS');
}

main().catch((e) =>
{
	fail(e.message || String(e));
});
