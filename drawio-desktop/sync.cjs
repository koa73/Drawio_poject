const fs = require('fs')
const path = require('path')

const appjsonpath = path.join(__dirname, 'package.json')
const disableUpdatePath = path.join(__dirname, 'src/main', 'disableUpdate.js')
const versionPath = path.join(__dirname, 'drawio', 'VERSION')
const customVersionStatePath = path.join(__dirname, '.custom-version-state.json')
const cliArgs = process.argv.slice(2)
const forkBaseVersion = process.env.DRAWIO_BASE_VERSION || '29.6.10'

let ver = forkBaseVersion;
if (fs.existsSync(versionPath))
{
	try
	{
		const upstreamVersion = fs.readFileSync(versionPath, 'utf8').trim();
		if (upstreamVersion !== forkBaseVersion)
		{
			console.warn('Using fork base version', forkBaseVersion, 'instead of upstream', upstreamVersion);
		}
	}
	catch (e)
	{
		// ignore read errors and continue with fixed fork version
	}
}

if (!/^\d+\.\d+\.\d+$/.test(ver))
{
	console.error('Error: drawio/VERSION contains invalid version: "' + ver + '"')
	process.exit(1)
}

let pj = require(appjsonpath)

function isValidSuffix(suffix)
{
	return /^[a-zA-Z][0-9]{2}$/.test(suffix);
}

function incrementSuffix(suffix)
{
	const normalized = suffix.toLowerCase();
	let letterCode = normalized.charCodeAt(0);
	let number = parseInt(normalized.substring(1), 10);

	if (Number.isNaN(number))
	{
		throw new Error('Invalid suffix counter: ' + suffix);
	}

	number += 1;

	if (number > 99)
	{
		number = 1;
		letterCode += 1;
	}

	if (letterCode > 'z'.charCodeAt(0))
	{
		throw new Error('Custom version suffix overflow (past z99)');
	}

	return String.fromCharCode(letterCode) + String(number).padStart(2, '0');
}

function resolveCustomSuffix(baseVersion)
{
	const envOverride = process.env.DRAWIO_CUSTOM_SUFFIX;
	const argOverride = cliArgs.find(arg => arg.startsWith('--custom-suffix='));
	const cliOverride = argOverride ? argOverride.substring('--custom-suffix='.length) : null;
	const override = (cliOverride || envOverride || '').trim();

	if (override.length > 0)
	{
		if (!isValidSuffix(override))
		{
			throw new Error('Invalid custom suffix override "' + override + '". Expected [a-z][0-9][0-9]');
		}

		return override.toLowerCase();
	}

	let state = {};
	if (fs.existsSync(customVersionStatePath))
	{
		try
		{
			state = JSON.parse(fs.readFileSync(customVersionStatePath, 'utf8')) || {};
		}
		catch (e)
		{
			state = {};
		}
	}

	let nextSuffix = 'a01';
	if (state.baseVersion === baseVersion && isValidSuffix(state.suffix || ''))
	{
		nextSuffix = incrementSuffix(state.suffix);
	}

	fs.writeFileSync(customVersionStatePath, JSON.stringify({
		baseVersion: baseVersion,
		suffix: nextSuffix
	}, null, 2), 'utf8');

	return nextSuffix;
}

const customSuffix = resolveCustomSuffix(ver);
pj.version = `${ver}-${customSuffix}`

fs.writeFileSync(appjsonpath, JSON.stringify(pj, null, 2), 'utf8')

function injectDesktopUiVersion(desktopVersion)
{
	const uiVersion = `v${desktopVersion}`;
	const targets = [
		path.join(__dirname, 'drawio', 'src', 'main', 'webapp', 'js', 'diagramly', 'EditorUi.js'),
		path.join(__dirname, 'drawio', 'src', 'main', 'webapp', 'js', 'grapheditor', 'EditorUi.js'),
		path.join(__dirname, 'drawio', 'src', 'main', 'webapp', 'js', 'diagramly', 'Menus.js')
	];

	for (const filePath of targets)
	{
		if (!fs.existsSync(filePath))
		{
			continue;
		}

		let text = fs.readFileSync(filePath, 'utf8');

		// Primary: replace placeholder.
		if (text.indexOf('@DRAWIO-VERSION@') >= 0)
		{
			text = text.replace(/@DRAWIO-VERSION@/g, uiVersion);
			fs.writeFileSync(filePath, text, 'utf8');
			continue;
		}

		// Fallback: replace existing EditorUi.VERSION assignment.
		const re = /(EditorUi\.VERSION\s*=\s*)['"][^'"]*['"]\s*;/;
		if (re.test(text))
		{
			text = text.replace(re, `$1'${uiVersion}';`);
			fs.writeFileSync(filePath, text, 'utf8');
		}
	}
}

injectDesktopUiVersion(pj.version);
//Enable/disable updates
const disableUpdateEnabled = cliArgs.includes('disableUpdate');
fs.writeFileSync(disableUpdatePath, 'export function disableUpdate() { return ' + (disableUpdateEnabled ? 'true' : 'false') + ';}', 'utf8');
