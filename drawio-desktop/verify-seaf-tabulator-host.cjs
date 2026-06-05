#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const drawioRoot = path.resolve(__dirname, 'drawio', 'src', 'main', 'webapp', 'js', 'vendor', 'tabulator');
const requiredPaths = [
	path.join(drawioRoot, 'tabulator.min.js'),
	path.join(drawioRoot, 'tabulator.min.css')
];

const missing = requiredPaths.filter((p) => !fs.existsSync(p));

if (missing.length > 0)
{
	console.error('[SEAF packaging guard] Tabulator host vendor is missing from draw.io webapp.');
	console.error('[SEAF packaging guard] Expected files under drawio/src/main/webapp/js/vendor/tabulator/');
	for (const item of missing)
	{
		console.error(`  missing: ${item}`);
	}
	process.exit(1);
}

console.log('[SEAF packaging guard] Tabulator host vendor verification passed.');
