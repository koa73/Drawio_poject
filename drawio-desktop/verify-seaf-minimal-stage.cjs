#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const stageDir = path.resolve(__dirname, './seaf-minimal-stage');
const requiredPaths = [
	path.join(stageDir, 'seaf.plugin.js'),
	path.join(stageDir, 'seaf_plugin'),
	path.join(stageDir, 'seaf_plugin', 'conf', 'plugin.yaml'),
	path.join(stageDir, 'seaf_plugin', 'runtime', 'version.json')
];

const missing = requiredPaths.filter((p) => !fs.existsSync(p));

if (missing.length > 0)
{
	console.error('[SEAF packaging guard] minimal-stage is missing required artifacts.');
	console.error('[SEAF packaging guard] Expected vendored files under drawio-desktop/seaf-minimal-stage.');
	for (const item of missing)
	{
		console.error(`  missing: ${item}`);
	}
	process.exit(1);
}

const forbiddenPath = path.join(stageDir, 'seaf_plugin', 'keys');
if (fs.existsSync(forbiddenPath))
{
	console.error('[SEAF packaging guard] minimal-stage contains forbidden legacy artifacts.');
	console.error(`  forbidden: ${forbiddenPath}`);
	process.exit(1);
}

console.log('[SEAF packaging guard] minimal-stage verification passed.');
