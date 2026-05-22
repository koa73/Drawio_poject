import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

function fail(message)
{
	console.error(`[test-edit-data-ipc-contract] FAIL: ${message}`);
	process.exit(1);
}

async function main()
{
	const electronPath = path.join(repoRoot, 'drawio-desktop', 'src', 'main', 'electron.js');
	const servicePath = path.join(repoRoot, 'drawio-desktop', 'src', 'main', 'seaf', 'seafPluginService.js');
	const runtimePath = path.join(repoRoot, 'seaf-plugin-runtime', 'plugin', 'seaf.plugin.js');
	const stencilConfigPath = path.join(repoRoot, 'seaf-plugin-runtime', 'conf', 'stencils', 'config.yaml');

	const [electronSrc, serviceSrc, runtimeSrc, stencilConfigSrc] = await Promise.all([
		fs.readFile(electronPath, 'utf8'),
		fs.readFile(servicePath, 'utf8'),
		fs.readFile(runtimePath, 'utf8'),
		fs.readFile(stencilConfigPath, 'utf8')
	]);

	const checks = [
		[electronSrc, "case 'getSeafStencilConfig':"],
		[electronSrc, 'ret = await seafPluginService.getStencilConfig(args);'],
		[serviceSrc, 'async function readStencilConfigInternal(configPath)'],
		[serviceSrc, 'async getStencilConfig(args)'],
		[runtimeSrc, "action: 'getSeafStencilConfig'"],
		[runtimeSrc, "source: (state.features.ipcStencilConfigV2 === true ? 'getSeafStencilConfig' : 'readSeafPluginFile')"],
		[runtimeSrc, 'function getDataHiddenForSchema(schema)'],
		[stencilConfigSrc, 'data_hidden:']
	];

	for (const [text, needle] of checks)
	{
		if (!text.includes(needle))
		{
			fail(`missing IPC contract element: ${needle}`);
		}
	}

	console.log('[test-edit-data-ipc-contract] PASS');
}

main().catch((e) =>
{
	fail(e.message || String(e));
});
