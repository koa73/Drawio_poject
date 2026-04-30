#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const stageDir = path.resolve(__dirname, '../seaf-plugin-runtime/release/out/minimal-stage');
const requiredPaths = [
	path.join(stageDir, 'seaf.plugin.js'),
	path.join(stageDir, 'seaf_plugin'),
	path.join(stageDir, 'seaf_plugin', 'conf', 'plugin.yaml'),
	path.join(stageDir, 'seaf_plugin', 'runtime', 'version.json'),
	path.join(stageDir, 'seaf_plugin', 'keys')
];

const missing = requiredPaths.filter((p) => !fs.existsSync(p));

if (missing.length > 0)
{
	console.error('[SEAF packaging guard] minimal-stage is missing required artifacts.');
	console.error('[SEAF packaging guard] Please run:');
	console.error('  /home/oleg/Drawio_poject/seaf-plugin-runtime/release/runtime/build-minimal-runtime.sh');
	for (const item of missing)
	{
		console.error(`  missing: ${item}`);
	}
	process.exit(1);
}

console.log('[SEAF packaging guard] minimal-stage verification passed.');
