import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import { mergeEnvByPolicy, normalizePythonExecutableCandidates, probePythonExecutable } from '../src/main/seaf/seafPluginService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

function assert(condition, message)
{
	if (!condition)
	{
		throw new Error(message);
	}
}

function testMergeContract()
{
	const fields = [
		{envKey: 'a', inputMethod: 'text'},
		{envKey: 'flag', inputMethod: 'checkbox'}
	];
	const localRaw = {
		a: 'user-a',
		flag: true,
		customOnly: 'keep-me'
	};
	const sourceRaw = {
		a: 'default-a',
		flag: false,
		b: 'new-default'
	};
	const result = mergeEnvByPolicy({localRaw, sourceRaw, fields}).env;
	assert(result.a === 'user-a', 'merge invariant failed: local schema value must win');
	assert(result.flag === true, 'merge invariant failed: local checkbox value must win');
	assert(result.customOnly === 'keep-me', 'merge invariant failed: unknown local key must be preserved');
	assert(result.b === 'new-default', 'merge invariant failed: missing key from source must be added');
}

async function testPluginContracts()
{
	const pluginPath = path.join(repoRoot, 'seaf-plugin-runtime', 'plugin', 'seaf.plugin.js');
	const pluginText = await fs.readFile(pluginPath, 'utf8');
	assert(pluginText.includes('function normalizeCustomEntriesConfig'),
		'custom entries adapter contract missing');
	assert(pluginText.includes('function applySeafCustomEntriesPipeline'),
		'post-inject pipeline contract missing');
	assert(pluginText.includes('function normalizeLocalizedResource'),
		'localized title contract missing');
}

async function testPythonExecutableScenarios()
{
	const scriptsRoot = path.join(repoRoot, 'seaf-plugin-runtime', 'python', 'scripts');
	const tempRoot = path.join(repoRoot, '.tmp-seaf-python-smoke');
	const venvDir = path.join(tempRoot, '.venv');
	const venvBinDir = path.join(venvDir, 'bin');
	const fakePython = path.join(venvBinDir, 'python');

	await fs.rm(tempRoot, {recursive: true, force: true});
	await fs.mkdir(venvBinDir, {recursive: true});
	await fs.writeFile(fakePython, '#!/usr/bin/env sh\necho "Python 3.11.9"\n', 'utf8');
	await fs.chmod(fakePython, 0o755);

	const globalNorm = await normalizePythonExecutableCandidates('python3', scriptsRoot);
	assert(Array.isArray(globalNorm.candidates) && globalNorm.candidates[0] === 'python3',
		'python3 candidate normalization failed');

	const venvNorm = await normalizePythonExecutableCandidates(venvDir, scriptsRoot);
	assert(venvNorm.isDirectory === true, 'venv directory must be recognized as directory');
	assert(venvNorm.candidates.includes(path.join(venvDir, 'bin', 'python')),
		'venv candidate list must include bin/python');
	const venvProbe = await probePythonExecutable(venvNorm.candidates[0], scriptsRoot);
	assert(venvProbe.ok === true, 'venv directory scenario must resolve to runnable interpreter');

	const venvBinaryNorm = await normalizePythonExecutableCandidates(fakePython, scriptsRoot);
	assert(venvBinaryNorm.candidates[0] === fakePython,
		'venv binary path must be preserved as executable candidate');
	const venvBinaryProbe = await probePythonExecutable(venvBinaryNorm.candidates[0], scriptsRoot);
	assert(venvBinaryProbe.ok === true, 'venv binary scenario must probe successfully');

	const invalidNorm = await normalizePythonExecutableCandidates('/definitely/missing/python-or-venv', scriptsRoot);
	const invalidProbe = await probePythonExecutable(invalidNorm.candidates[0], scriptsRoot);
	assert(invalidProbe.ok === false, 'invalid python path must fail probe');

	await fs.rm(tempRoot, {recursive: true, force: true});
}

async function main()
{
	testMergeContract();
	await testPluginContracts();
	await testPythonExecutableScenarios();
	console.log('SEAF stability smoke: PASS');
}

main().catch((err) =>
{
	console.error('SEAF stability smoke: FAIL');
	console.error(err && err.stack ? err.stack : String(err));
	process.exit(1);
});
