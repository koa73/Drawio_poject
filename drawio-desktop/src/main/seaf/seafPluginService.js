import path from 'path';
import fs from 'fs';
import { promises as fsProm } from 'fs';
import {spawn} from 'child_process';
import { randomUUID } from 'crypto';
import https from 'https';
import { parseYamlLite } from './yamlLite.js';
import { getReducedAsyncMeta, getReducedErrorDetails } from './jobMetaUtils.js';

const runningJobs = new Map();
const manualIndicators = new Map();
const loadedConfigCache = new Map();
const pythonEnvStatusCache = new Map();
let runtimeUpdateLock = false;
const FINISHED_JOB_RETENTION_MS = 5 * 60 * 1000;

function nowIso()
{
	return new Date().toISOString();
}

function resolveConfigPathForCache(configPath, getAppDataFolder)
{
	return resolveConfigPath(configPath, getAppDataFolder);
}

async function getMtimeMsSafe(filePath)
{
	try
	{
		const stat = await fsProm.stat(filePath);
		return Number.isFinite(stat.mtimeMs) ? Math.round(stat.mtimeMs) : 0;
	}
	catch (e)
	{
		return 0;
	}
}

async function getConfigCacheKey(resolvedPath)
{
	const envPath = resolveEnvPath(resolvedPath);
	const dependencyPaths = [resolvedPath, envPath];
	try
	{
		const raw = await fsProm.readFile(resolvedPath, 'utf8');
		const parsed = parseYamlLite(raw);
		const includes = (parsed && typeof parsed.includes === 'object') ? parsed.includes : {};
		const mainMenuPath = resolveMaybeRelative(resolvedPath, includes?.menus?.main);
		const contextMenuPath = resolveMaybeRelative(resolvedPath, includes?.menus?.context);
		const eventCommandsPath = resolveMaybeRelative(resolvedPath, includes?.events?.commands);
		const eventsCfg = (parsed && typeof parsed.events === 'object') ? parsed.events : {};
		const eventConfigPath = resolveMaybeRelative(
			resolvedPath,
			(typeof eventsCfg.configFile === 'string' && eventsCfg.configFile.trim().length > 0) ? eventsCfg.configFile.trim() : 'events.yaml'
		);
		for (const p of [mainMenuPath, contextMenuPath, eventCommandsPath, eventConfigPath])
		{
			if (typeof p === 'string' && p.length > 0 && !dependencyPaths.includes(p))
			{
				dependencyPaths.push(p);
			}
		}
	}
	catch (e)
	{
		// ignore parse errors here; validation will report later
	}
	const mtimes = [];
	for (const dep of dependencyPaths)
	{
		mtimes.push(await getMtimeMsSafe(dep));
	}
	return `${resolvedPath}::${mtimes.join(':')}`;
}

function invalidateConfigCache(configPath, getAppDataFolder)
{
	const resolved = resolveConfigPathForCache(configPath, getAppDataFolder);
	for (const key of loadedConfigCache.keys())
	{
		if (key.startsWith(`${resolved}::`))
		{
			loadedConfigCache.delete(key);
		}
	}
	pythonEnvStatusCache.delete(resolved);
}

function acquireRuntimeUpdateLock()
{
	if (runtimeUpdateLock)
	{
		throw new Error('SEAF runtime update is already in progress');
	}
	runtimeUpdateLock = true;
	return () =>
	{
		runtimeUpdateLock = false;
	};
}

function pruneFinishedJobs()
{
	const nowMs = Date.now();
	for (const [jobId, job] of runningJobs.entries())
	{
		const finishedAt = (job && typeof job.finishedAt === 'string') ? Date.parse(job.finishedAt) : NaN;
		if (Number.isFinite(finishedAt) && (nowMs - finishedAt) > FINISHED_JOB_RETENTION_MS)
		{
			runningJobs.delete(jobId);
		}
	}
}

function maskSensitive(value)
{
	if (value == null || typeof value !== 'object')
	{
		return value;
	}

	if (Array.isArray(value))
	{
		return value.map(maskSensitive);
	}

	const out = {};
	const secretRegex = /(token|secret|password|apikey|api_key|auth|cookie)/i;

	for (const key of Object.keys(value))
	{
		if (secretRegex.test(key))
		{
			out[key] = '***';
		}
		else
		{
			out[key] = maskSensitive(value[key]);
		}
	}

	return out;
}

function normalizeLogConfig(loggingCfg)
{
	const cfg = loggingCfg || {};
	const output = cfg.output || 'console';
	let filePath = null;

	if (typeof output === 'string' && (output === 'file' || output === 'both'))
	{
		filePath = cfg.filePath || cfg.file || null;
	}

	return {
		level: cfg.level || 'info',
		extendedDebug: cfg.extendedDebug === true,
		includePayload: cfg.includePayload === true,
		output: output,
		filePath: filePath
	};
}

function isLogLevelEnabled(activeLevel, messageLevel)
{
	const priority = {
		debug: 10,
		info: 20,
		warn: 30,
		error: 40
	};
	const active = priority[String(activeLevel || '').toLowerCase()] || priority.info;
	const requested = priority[String(messageLevel || '').toLowerCase()] || priority.info;
	return requested >= active;
}

function applyEnvLogLevel(logCfg, env)
{
	const out = Object.assign({}, logCfg || {});
	const rawLevel = (env && typeof env.pluginLogLevel === 'string') ?
		env.pluginLogLevel.trim().toLowerCase() : '';

	if (rawLevel === 'none')
	{
		out.level = 'error';
		out.extendedDebug = false;
		out.includePayload = false;
		out.output = 'console';
	}
	else if (rawLevel === 'info')
	{
		out.level = 'info';
		out.extendedDebug = false;
	}
	else if (rawLevel === 'debug')
	{
		out.level = 'debug';
		out.extendedDebug = true;
	}

	return out;
}

function parseVersionParts(version)
{
	if (typeof version !== 'string')
	{
		return null;
	}

	const cleaned = version.trim().replace(/^v/i, '');
	if (!cleaned)
	{
		return null;
	}

	const parts = cleaned.split('.');
	if (parts.length === 0)
	{
		return null;
	}

	const numbers = [];
	for (const part of parts)
	{
		const match = String(part).match(/^(\d+)/);
		if (!match)
		{
			return null;
		}
		numbers.push(Number(match[1]));
	}

	return numbers;
}

function compareVersions(left, right)
{
	const leftParts = parseVersionParts(left);
	const rightParts = parseVersionParts(right);
	if (!leftParts || !rightParts)
	{
		return null;
	}

	const length = Math.max(leftParts.length, rightParts.length);
	for (let i = 0; i < length; i++)
	{
		const l = leftParts[i] || 0;
		const r = rightParts[i] || 0;
		if (l > r)
		{
			return 1;
		}
		if (l < r)
		{
			return -1;
		}
	}

	return 0;
}

async function appendFileLine(filePath, line)
{
	if (!filePath)
	{
		return;
	}

	await fsProm.mkdir(path.dirname(filePath), {recursive: true});
	await fsProm.appendFile(filePath, `${line}\n`, 'utf8');
}

function logToConsole(level, line)
{
	if (level === 'error')
	{
		console.error(line);
	}
	else if (level === 'warn')
	{
		console.warn(line);
	}
	else
	{
		console.log(line);
	}
}

async function writeLog(logCfg, level, message, data)
{
	if (!isLogLevelEnabled(logCfg.level, level))
	{
		return;
	}

	const payload = (data != null) ? ` ${JSON.stringify(data)}` : '';
	const line = `[SEAF][${nowIso()}][${level}] ${message}${payload}`;

	if (logCfg.output === 'console' || logCfg.output === 'both' || !logCfg.output)
	{
		logToConsole(level, line);
	}

	if (logCfg.output === 'file' || logCfg.output === 'both')
	{
		await appendFileLine(logCfg.filePath, line);
	}
}

function validateConfig(config)
{
	if (config == null || typeof config !== 'object')
	{
		throw new Error('Invalid config format');
	}

	if (!Array.isArray(config.commands))
	{
		throw new Error('Config must contain commands array');
	}

	const ids = new Set();

	for (const cmd of config.commands)
	{
		if (!cmd.id || typeof cmd.id !== 'string')
		{
			throw new Error('Each command must have string id');
		}

		if (ids.has(cmd.id))
		{
			throw new Error(`Duplicate command id: ${cmd.id}`);
		}

		ids.add(cmd.id);

		if (cmd.indicator != null)
		{
			const indicator = cmd.indicator;

			if (typeof indicator !== 'object')
			{
				throw new Error(`Command ${cmd.id} indicator must be object`);
			}

			if (indicator.enabled != null && typeof indicator.enabled !== 'boolean')
			{
				throw new Error(`Command ${cmd.id} indicator.enabled must be boolean`);
			}

			if (indicator.type != null && indicator.type !== 'spinner' && indicator.type !== 'percent')
			{
				throw new Error(`Command ${cmd.id} indicator.type must be spinner or percent`);
			}

			if (indicator.timeoutMs != null && (!Number.isFinite(indicator.timeoutMs) || indicator.timeoutMs <= 0))
			{
				throw new Error(`Command ${cmd.id} indicator.timeoutMs must be positive number`);
			}

			if (indicator.allowStop != null && typeof indicator.allowStop !== 'boolean')
			{
				throw new Error(`Command ${cmd.id} indicator.allowStop must be boolean`);
			}
		}
	}
}

async function readYamlObjectOrEmpty(filePath)
{
	if (typeof filePath !== 'string' || filePath.trim().length === 0)
	{
		return {};
	}
	try
	{
		const raw = await fsProm.readFile(filePath, 'utf8');
		const parsed = parseYamlLite(raw);
		return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
	}
	catch (e)
	{
		if (e && e.code === 'ENOENT')
		{
			return {};
		}
		throw e;
	}
}

function mergeCommandObjects(baseCommand, incomingCommand)
{
	const base = (baseCommand && typeof baseCommand === 'object') ? baseCommand : {};
	const incoming = (incomingCommand && typeof incomingCommand === 'object') ? incomingCommand : {};
	const out = Object.assign({}, base, incoming);

	out.menu = Object.assign({}, (base.menu && typeof base.menu === 'object') ? base.menu : {});
	if (incoming.menu && typeof incoming.menu === 'object')
	{
		out.menu.main = Object.assign({}, out.menu.main || {}, incoming.menu.main || {});
		out.menu.context = Object.assign({}, out.menu.context || {}, incoming.menu.context || {});
	}

	const mergeObjectFields = ['execution', 'input', 'output', 'indicator', 'configEditor'];
	for (const key of mergeObjectFields)
	{
		const baseField = (base[key] && typeof base[key] === 'object') ? base[key] : {};
		const incomingField = (incoming[key] && typeof incoming[key] === 'object') ? incoming[key] : {};
		if (Object.keys(baseField).length > 0 || Object.keys(incomingField).length > 0)
		{
			out[key] = Object.assign({}, baseField, incomingField);
		}
	}

	return out;
}

function mergeCommandsById(chunks)
{
	const order = [];
	const map = new Map();
	for (const chunk of chunks)
	{
		const commands = Array.isArray(chunk) ? chunk : [];
		for (const cmd of commands)
		{
			if (!cmd || typeof cmd !== 'object')
			{
				continue;
			}
			const id = (typeof cmd.id === 'string') ? cmd.id.trim() : '';
			if (!id)
			{
				continue;
			}
			if (!map.has(id))
			{
				order.push(id);
				map.set(id, mergeCommandObjects({}, Object.assign({}, cmd, {id})));
			}
			else
			{
				map.set(id, mergeCommandObjects(map.get(id), Object.assign({}, cmd, {id})));
			}
		}
	}
	return order.map((id) => map.get(id));
}

async function composeConfigWithIncludes(baseConfig, resolvedPath)
{
	const source = (baseConfig && typeof baseConfig === 'object') ? baseConfig : {};
	const includes = (source.includes && typeof source.includes === 'object') ? source.includes : {};
	const mainMenuPath = resolveMaybeRelative(resolvedPath, includes?.menus?.main);
	const contextMenuPath = resolveMaybeRelative(resolvedPath, includes?.menus?.context);
	const eventCommandsPath = resolveMaybeRelative(resolvedPath, includes?.events?.commands);

	const mainMenuCfg = await readYamlObjectOrEmpty(mainMenuPath);
	const contextMenuCfg = await readYamlObjectOrEmpty(contextMenuPath);
	const eventCommandsCfg = await readYamlObjectOrEmpty(eventCommandsPath);

	const composed = Object.assign({}, source);
	const composedCommands = mergeCommandsById([
		source.commands,
		mainMenuCfg.commands,
		contextMenuCfg.commands,
		eventCommandsCfg.commands
	]);
	composed.commands = composedCommands;
	return composed;
}

function resolveConfigPath(configPath, getAppDataFolder)
{
	if (configPath != null && configPath.trim().length > 0)
	{
		return path.resolve(configPath);
	}

	return path.join(getAppDataFolder(), 'plugins', 'seaf_plugin', 'conf', 'plugin.yaml');
}

async function loadConfigInternal(configPath, getAppDataFolder)
{
	const resolvedPath = resolveConfigPath(configPath, getAppDataFolder);
	const cacheKey = await getConfigCacheKey(resolvedPath);
	if (loadedConfigCache.has(cacheKey))
	{
		return loadedConfigCache.get(cacheKey);
	}
	const yamlText = await fsProm.readFile(resolvedPath, 'utf8');
	const parsedBaseConfig = parseYamlLite(yamlText);
	const config = await composeConfigWithIncludes(parsedBaseConfig, resolvedPath);
	validateConfig(config);

	let logCfg = normalizeLogConfig(config.logging);

	if (!logCfg.filePath)
	{
		logCfg.filePath = path.join(path.dirname(resolvedPath), 'seaf-plugin.log');
	}
	else if (!path.isAbsolute(logCfg.filePath))
	{
		logCfg.filePath = path.resolve(path.dirname(resolvedPath), logCfg.filePath);
	}

	const envConfig = await readEnvConfigInternal(resolvedPath, config);
	logCfg = applyEnvLogLevel(logCfg, envConfig.env);

	const loaded = {configPath: resolvedPath, config, logCfg, envConfig};
	loadedConfigCache.set(cacheKey, loaded);
	return loaded;
}

function buildRunnerInput(command, payload)
{
	return {
		commandId: command.id,
		timestamp: nowIso(),
		payload: payload || {},
		io: command.io || {},
		expectedOutput: command.output || {},
		postActions: command.postActions || []
	};
}

function resolveScriptPath(command, config, configPath)
{
	const configured = command.script || command.command?.script;

	if (typeof configured !== 'string' || configured.length === 0)
	{
		throw new Error(`Command ${command.id} has no script path`);
	}

	if (path.isAbsolute(configured))
	{
		return configured;
	}

	const cfgDir = path.dirname(configPath);
	const scriptsDir = (config.python && config.python.scriptsDir) ?
		config.python.scriptsDir : '../python/scripts';
	const resolvedScriptsDir = path.isAbsolute(scriptsDir) ?
		scriptsDir : path.resolve(cfgDir, scriptsDir);
	return path.resolve(resolvedScriptsDir, configured);
}

function resolveScriptsRoot(config, configPath)
{
	const cfgDir = path.dirname(configPath);
	const scriptsDir = (config.python && config.python.scriptsDir) ?
		config.python.scriptsDir : '../python/scripts';
	return path.isAbsolute(scriptsDir) ?
		scriptsDir : path.resolve(cfgDir, scriptsDir);
}

function buildPythonExecutionEnv(baseEnv, scriptsRoot)
{
	const nextEnv = Object.assign({}, process.env, baseEnv || {});
	const existing = (typeof nextEnv.PYTHONPATH === 'string' && nextEnv.PYTHONPATH.trim().length > 0) ?
		nextEnv.PYTHONPATH.split(path.delimiter).filter((v) => v && v.trim().length > 0) : [];
	const merged = [scriptsRoot].concat(existing.filter((v) => v !== scriptsRoot));
	nextEnv.PYTHONPATH = merged.join(path.delimiter);
	nextEnv.SEAF_PYTHON_SCRIPTS_ROOT = scriptsRoot;
	return nextEnv;
}

function resolvePythonRuntimeConfig(config, configPath, envConfig)
{
	const py = (config && config.python && typeof config.python === 'object') ? config.python : {};
	const scriptsRoot = resolveScriptsRoot(config, configPath);
	const envValues = (envConfig && typeof envConfig.env === 'object' && envConfig.env != null) ? envConfig.env : {};
	const requirementsFile = resolveMaybeRelative(configPath, py.requirementsFile) ||
		path.resolve(path.dirname(configPath), '../python/requirements.txt');
	const configuredExecutable = (typeof envValues.pythonExecutable === 'string' && envValues.pythonExecutable.trim().length > 0) ?
		envValues.pythonExecutable.trim() : '';
	const defaultExecutable = (typeof py.executable === 'string' && py.executable.trim().length > 0) ?
		py.executable.trim() : 'python3';
	const requiredModules = Array.isArray(py.requiredModules) && py.requiredModules.length > 0 ?
		py.requiredModules.map((m) => String(m)).filter((m) => m.trim().length > 0) : ['lib.io'];
	const fallbackExecutables = [];

	for (const candidate of [defaultExecutable, 'python3', 'python'])
	{
		if (typeof candidate !== 'string' || candidate.trim().length === 0)
		{
			continue;
		}
		const value = candidate.trim();
		if (!fallbackExecutables.includes(value))
		{
			fallbackExecutables.push(value);
		}
	}

	return {
		requirementsFile,
		configuredExecutable,
		defaultExecutable,
		fallbackExecutables,
		scriptsRoot,
		requiredModules
	};
}

function isLikelyPathValue(value)
{
	if (typeof value !== 'string' || value.trim().length === 0)
	{
		return false;
	}

	return value.includes('/') || value.includes('\\') || value.startsWith('.');
}

function getVenvPythonCandidates(venvDir)
{
	return [
		path.join(venvDir, 'bin', 'python'),
		path.join(venvDir, 'bin', 'python3'),
		path.join(venvDir, 'Scripts', 'python.exe'),
		path.join(venvDir, 'Scripts', 'python'),
		path.join(venvDir, 'python.exe')
	];
}

export async function normalizePythonExecutableCandidates(rawValue, scriptsRoot)
{
	const value = (typeof rawValue === 'string') ? rawValue.trim() : '';
	if (!value)
	{
		return {
			rawValue: '',
			candidates: [],
			isDirectory: false
		};
	}

	if (!isLikelyPathValue(value))
	{
		return {
			rawValue: value,
			candidates: [value],
			isDirectory: false
		};
	}

	const resolvedPath = path.isAbsolute(value) ? value : path.resolve(scriptsRoot, value);
	try
	{
		const stat = await fsProm.stat(resolvedPath);
		if (stat.isDirectory())
		{
			return {
				rawValue: value,
				resolvedPath,
				candidates: getVenvPythonCandidates(resolvedPath),
				isDirectory: true
			};
		}
	}
	catch (e)
	{
		// Keep original value as candidate; probe will produce detailed failure.
	}

	return {
		rawValue: value,
		resolvedPath,
		candidates: [resolvedPath],
		isDirectory: false
	};
}

export async function probePythonExecutable(pythonExe, scriptsRoot)
{
	try
	{
		const result = await runProcessCapture(pythonExe, ['--version'], {
			cwd: scriptsRoot,
			env: buildPythonExecutionEnv({}, scriptsRoot)
		});
		return {
			ok: result.code === 0,
			code: result.code,
			stdout: result.stdout || '',
			stderr: result.stderr || ''
		};
	}
	catch (e)
	{
		return {
			ok: false,
			code: null,
			stdout: '',
			stderr: e && e.message ? String(e.message) : String(e)
		};
	}
}

async function verifyPythonImports({pythonExe, scriptsRoot, modules})
{
	const code = [
		'import importlib, json',
		`mods = json.loads(${JSON.stringify(JSON.stringify(modules || []))})`,
		'missing = []',
		'for m in mods:',
		'    try:',
		'        importlib.import_module(m)',
		'    except Exception:',
		'        missing.append(m)',
		'if missing:',
		'    raise SystemExit("missing:" + ",".join(missing))'
	].join('\n');
	const env = buildPythonExecutionEnv({}, scriptsRoot);
	const result = await runProcessCapture(pythonExe, ['-c', code], {cwd: scriptsRoot, env});
	if (result.code !== 0)
	{
		throw new Error(`Preflight import check failed: ${trimOutput(result.stderr || result.stdout || '')}`);
	}
}

function classifyBootstrapStderr(stderr)
{
	const s = String(stderr || '');
	if (/No module named pip|No module named ensurepip|ensurepip/i.test(s))
	{
		return 'missing_pip';
	}
	if (/spawn failed|command not found|No such file or directory|is not recognized/i.test(s))
	{
		return 'interpreter_not_found';
	}
	if (/CERTIFICATE_VERIFY_FAILED|ssl|tls/i.test(s))
	{
		return 'ssl_cert';
	}
	if (/permission denied|not permitted|eacces/i.test(s))
	{
		return 'permission';
	}
	if (/temporary failure|name or service not known|connection|timed out|could not find a version|No matching distribution/i.test(s))
	{
		return 'network_or_index';
	}
	return 'unknown';
}

function getManagedVenvDir(configPath)
{
	const confDir = path.dirname(configPath);
	const runtimeDir = path.resolve(confDir, '..');
	return path.join(runtimeDir, '.venv');
}

async function resolveFirstWorkingInterpreter(candidates, scriptsRoot)
{
	for (const candidate of candidates || [])
	{
		if (typeof candidate !== 'string' || candidate.trim().length === 0)
		{
			continue;
		}
		const probe = await probePythonExecutable(candidate.trim(), scriptsRoot);
		if (probe.ok)
		{
			return candidate.trim();
		}
	}
	return '';
}

async function ensurePipAvailable({pythonExe, scriptsRoot})
{
	const env = buildPythonExecutionEnv({}, scriptsRoot);
	const pipCheck = await runProcessCapture(pythonExe, ['-m', 'pip', '--version'], {cwd: scriptsRoot, env});
	if (pipCheck.code === 0)
	{
		return {ok: true, stage: 'pip_check'};
	}

	const ensurePip = await runProcessCapture(pythonExe, ['-m', 'ensurepip', '--upgrade'], {cwd: scriptsRoot, env});
	if (ensurePip.code === 0)
	{
		return {ok: true, stage: 'ensurepip'};
	}

	const stderrTail = tailLines(ensurePip.stderr || pipCheck.stderr || ensurePip.stdout || pipCheck.stdout, 25, 2500);
	const category = classifyBootstrapStderr(stderrTail);
	throw new Error(`python_bootstrap_failed:missing_pip:pip_unavailable_for_${pythonExe}:${category}:${stderrTail}`);
}

async function ensureVirtualenvAvailable({basePython, scriptsRoot})
{
	const env = buildPythonExecutionEnv({}, scriptsRoot);
	const check = await runProcessCapture(basePython, ['-m', 'virtualenv', '--version'], {cwd: scriptsRoot, env});
	if (check.code === 0)
	{
		return {ok: true, stage: 'virtualenv_ready'};
	}

	const install = await runProcessCapture(basePython, ['-m', 'pip', 'install', '--user', 'virtualenv'], {cwd: scriptsRoot, env});
	if (install.code === 0)
	{
		return {ok: true, stage: 'virtualenv_install'};
	}

	const stderrTail = tailLines(install.stderr || install.stdout || check.stderr || check.stdout, 25, 2500);
	const category = classifyBootstrapStderr(stderrTail);
	throw new Error(`python_bootstrap_failed:virtualenv_install:failed_for_${basePython}:${category}:${stderrTail}`);
}

async function createManagedVenvWithFallback({basePython, venvDir, scriptsRoot})
{
	await fsProm.rm(venvDir, {recursive: true, force: true}).catch(() => {});
	const env = buildPythonExecutionEnv({}, scriptsRoot);

	const nativeVenv = await runProcessCapture(basePython, ['-m', 'venv', venvDir], {cwd: scriptsRoot, env});
	if (nativeVenv.code === 0)
	{
		return {ok: true, stage: 'venv_created', method: 'venv'};
	}

	await ensureVirtualenvAvailable({basePython, scriptsRoot});
	const virtualenvRun = await runProcessCapture(basePython, ['-m', 'virtualenv', venvDir], {cwd: scriptsRoot, env});
	if (virtualenvRun.code === 0)
	{
		return {ok: true, stage: 'venv_created', method: 'virtualenv'};
	}

	const stderrTail = tailLines(virtualenvRun.stderr || virtualenvRun.stdout || nativeVenv.stderr || nativeVenv.stdout, 25, 2500);
	const category = classifyBootstrapStderr(stderrTail);
	throw new Error(`python_bootstrap_failed:venv_create_failed:unable_to_create_managed_venv:${category}:${stderrTail}`);
}

function isCandidateInsideManagedVenv(candidate, venvDir, scriptsRoot)
{
	const value = String(candidate || '').trim();
	if (value.length < 1 || !isLikelyPathValue(value))
	{
		return false;
	}
	const resolvedCandidate = path.resolve(path.isAbsolute(value) ? value : path.resolve(scriptsRoot, value));
	const resolvedVenvDir = path.resolve(venvDir);
	return resolvedCandidate === resolvedVenvDir || resolvedCandidate.startsWith(resolvedVenvDir + path.sep);
}

async function bootstrapPythonRuntimeOnInstallOrUpdate({
	loaded,
	source,
	allowDependencyInstall = true,
	allowFallback = true,
	persistFallback = true
})
{
	const envConfig = loaded.envConfig || await readEnvConfigInternal(loaded.configPath, loaded.config);
	const pythonCfg = resolvePythonRuntimeConfig(loaded.config, loaded.configPath, envConfig);
	const venvDir = getManagedVenvDir(loaded.configPath);
	const venvDirExists = fs.existsSync(venvDir);
	let branch = 'create_managed_venv';
	let selectedBasePython = '';
	let selectedVenvPython = '';
	const filteredCandidates = [];
	const tried = [];
	let installedRequirements = false;

	if (venvDirExists)
	{
		branch = 'existing_managed_venv';
		selectedVenvPython = await resolveFirstWorkingInterpreter(getVenvPythonCandidates(venvDir), pythonCfg.scriptsRoot);
		if (selectedVenvPython.length > 0)
		{
			try
			{
				await ensurePipAvailable({pythonExe: selectedVenvPython, scriptsRoot: pythonCfg.scriptsRoot});
				await verifyPythonImports({
					pythonExe: selectedVenvPython,
					scriptsRoot: pythonCfg.scriptsRoot,
					modules: pythonCfg.requiredModules
				});
				if (persistFallback)
				{
					const saved = await saveEnvConfigInternal(loaded.configPath, loaded.config, {
						pythonExecutable: selectedVenvPython
					});
					loaded.envConfig = {
						envPath: saved.envPath,
						fields: loaded.envConfig ? loaded.envConfig.fields : extractConfigEditorFields(loaded.config),
						env: saved.env
					};
				}
				await writeLog(loaded.logCfg, 'info', 'Python runtime bootstrap completed', {
					source: source || 'unknown',
					branch,
					venvDirExists,
					selectedBasePython,
					selectedVenvPython,
					triedCandidates: tried,
					filteredCandidates,
					venvDir,
					pythonExecutable: selectedVenvPython,
					stage: 'managed_venv_healthcheck',
					method: 'existing',
					installedRequirements,
					allowDependencyInstall,
					allowFallback,
					persistFallback
				});
				return {
					ok: true,
					source: source || 'unknown',
					stage: 'ready',
					method: 'existing',
					branch,
					basePython: selectedBasePython,
					venvDir,
					pythonExecutable: selectedVenvPython,
					installedRequirements
				};
			}
			catch (e)
			{
				await writeLog(loaded.logCfg, 'warn', 'Managed venv health-check failed, recreating environment', {
					source: source || 'unknown',
					branch,
					venvDir,
					pythonExecutable: selectedVenvPython,
					error: e && e.message ? String(e.message) : String(e)
				});
			}
		}
		else
		{
			await writeLog(loaded.logCfg, 'warn', 'Managed venv interpreter not found, recreating environment', {
				source: source || 'unknown',
				branch,
				venvDir
			});
		}
		branch = 'create_managed_venv';
		selectedVenvPython = '';
	}

	const configured = await normalizePythonExecutableCandidates(pythonCfg.configuredExecutable, pythonCfg.scriptsRoot);
	const configuredCandidates = Array.isArray(configured.candidates) ? configured.candidates : [];
	const fallbackCandidates = Array.isArray(pythonCfg.fallbackExecutables) ? pythonCfg.fallbackExecutables : [];
	const candidates = [];
	for (const row of configuredCandidates.concat(allowFallback ? fallbackCandidates : []))
	{
		const next = String(row || '').trim();
		if (next.length < 1)
		{
			continue;
		}
		if (isCandidateInsideManagedVenv(next, venvDir, pythonCfg.scriptsRoot))
		{
			if (!filteredCandidates.includes(next))
			{
				filteredCandidates.push(next);
			}
			continue;
		}
		if (!candidates.includes(next))
		{
			candidates.push(next);
		}
	}

	let basePython = '';
	for (const candidate of candidates)
	{
		tried.push(candidate);
		const probe = await probePythonExecutable(candidate, pythonCfg.scriptsRoot);
		if (probe.ok)
		{
			basePython = candidate;
			break;
		}
	}
	if (!basePython)
	{
		for (const fallback of ['python3', 'python'])
		{
			if (candidates.includes(fallback))
			{
				continue;
			}
			tried.push(fallback);
			const probe = await probePythonExecutable(fallback, pythonCfg.scriptsRoot);
			if (probe.ok)
			{
				basePython = fallback;
				break;
			}
		}
	}
	if (!basePython)
	{
		return {
			ok: false,
			code: 'python_bootstrap_failed',
			stage: 'probe',
			category: 'interpreter_not_found',
			error: `No working python interpreter. Tried: ${tried.join(', ') || 'none'}. Filtered managed-venv candidates: ${filteredCandidates.join(', ') || 'none'}`
		};
	}
	selectedBasePython = basePython;

	let createResult = null;
	try
	{
		createResult = await createManagedVenvWithFallback({basePython, venvDir, scriptsRoot: pythonCfg.scriptsRoot});
	}
	catch (e)
	{
		return {
			ok: false,
			code: 'python_bootstrap_failed',
			stage: 'venv_create',
			category: 'venv_create_failed',
			error: e && e.message ? String(e.message) : String(e)
		};
	}

	selectedVenvPython = await resolveFirstWorkingInterpreter(getVenvPythonCandidates(venvDir), pythonCfg.scriptsRoot);
	if (!selectedVenvPython)
	{
		return {
			ok: false,
			code: 'python_bootstrap_failed',
			stage: 'venv_interpreter_not_found',
			category: 'interpreter_not_found',
			error: `Managed venv created at ${venvDir}, but no interpreter was found`
		};
	}

	try
	{
		await ensurePipAvailable({pythonExe: selectedVenvPython, scriptsRoot: pythonCfg.scriptsRoot});
	}
	catch (e)
	{
		return {
			ok: false,
			code: 'python_bootstrap_failed',
			stage: 'pip',
			category: 'missing_pip',
			error: e && e.message ? String(e.message) : String(e)
		};
	}

	if (allowDependencyInstall)
	{
		try
		{
			await fsProm.access(pythonCfg.requirementsFile, fs.constants.R_OK);
			const env = buildPythonExecutionEnv({}, pythonCfg.scriptsRoot);
			const install = await runProcessCapture(selectedVenvPython, ['-m', 'pip', 'install', '-r', pythonCfg.requirementsFile], {
				cwd: pythonCfg.scriptsRoot,
				env
			});
			if (install.code !== 0)
			{
				const stderrTail = tailLines(install.stderr || install.stdout, 25, 2500);
				return {
					ok: false,
					code: 'python_bootstrap_failed',
					stage: 'pip_install',
					category: classifyBootstrapStderr(stderrTail),
					error: stderrTail
				};
			}
			installedRequirements = true;
		}
		catch (e)
		{
			if (!(e && e.code === 'ENOENT'))
			{
				return {
					ok: false,
					code: 'python_bootstrap_failed',
					stage: 'pip_install',
					category: 'missing_dependency',
					error: e && e.message ? String(e.message) : String(e)
				};
			}
		}
	}

	try
	{
		await verifyPythonImports({
			pythonExe: selectedVenvPython,
			scriptsRoot: pythonCfg.scriptsRoot,
			modules: pythonCfg.requiredModules
		});
	}
	catch (e)
	{
		return {
			ok: false,
			code: 'python_bootstrap_failed',
			stage: 'verify_imports',
			category: 'script_import_error',
			error: e && e.message ? String(e.message) : String(e)
		};
	}

	if (persistFallback)
	{
		const saved = await saveEnvConfigInternal(loaded.configPath, loaded.config, {
			pythonExecutable: selectedVenvPython
		});
		loaded.envConfig = {
			envPath: saved.envPath,
			fields: loaded.envConfig ? loaded.envConfig.fields : extractConfigEditorFields(loaded.config),
			env: saved.env
		};
	}

	await writeLog(loaded.logCfg, 'info', 'Python runtime bootstrap completed', {
		source: source || 'unknown',
		branch,
		venvDirExists,
		selectedBasePython,
		selectedVenvPython,
		triedCandidates: tried,
		filteredCandidates,
		basePython,
		venvDir,
		pythonExecutable: selectedVenvPython,
		stage: createResult && createResult.stage ? createResult.stage : 'venv_created',
		method: createResult && createResult.method ? createResult.method : 'unknown',
		installedRequirements,
		allowDependencyInstall,
		allowFallback,
		persistFallback
	});

	return {
		ok: true,
		source: source || 'unknown',
		stage: 'ready',
		method: createResult && createResult.method ? createResult.method : 'unknown',
		branch,
		basePython,
		venvDir,
		pythonExecutable: selectedVenvPython,
		installedRequirements
	};
}

async function resolvePythonExecutable({loaded, pythonCfg, source, allowFallback = true, persistFallback = true})
{
	if (pythonCfg.configuredExecutable)
	{
		const normalized = await normalizePythonExecutableCandidates(
			pythonCfg.configuredExecutable,
			pythonCfg.scriptsRoot
		);
		const triedConfigured = [];
		for (const candidate of normalized.candidates)
		{
			triedConfigured.push(candidate);
			const probeConfigured = await probePythonExecutable(candidate, pythonCfg.scriptsRoot);
			if (probeConfigured.ok)
			{
				return {
					pythonExe: candidate,
					persistDefault: false
				};
			}
		}

		if (allowFallback)
		{
			for (const candidate of pythonCfg.fallbackExecutables)
			{
				const probeFallback = await probePythonExecutable(candidate, pythonCfg.scriptsRoot);
				if (!probeFallback.ok)
				{
					continue;
				}
				let saved = null;
				if (persistFallback)
				{
					saved = await saveEnvConfigInternal(loaded.configPath, loaded.config, {
						pythonExecutable: candidate
					});
					loaded.envConfig = {
						envPath: saved.envPath,
						fields: loaded.envConfig ? loaded.envConfig.fields : extractConfigEditorFields(loaded.config),
						env: saved.env
					};
				}
				await writeLog(loaded.logCfg, 'warn', 'Configured python executable is stale; fallback interpreter selected', {
					source: source || 'unknown',
					configuredExecutable: pythonCfg.configuredExecutable,
					pythonExecutable: candidate,
					persisted: persistFallback === true,
					triedConfigured
				});
				return {
					pythonExe: candidate,
					persistDefault: persistFallback === true && !!saved
				};
			}
		}

		const tried = normalized.candidates.join(', ');
		if (normalized.isDirectory)
		{
			throw new Error(
				`python_env_invalid:interpreter_not_found:Configured python path points to directory without valid interpreter. ` +
				`Directory: ${normalized.resolvedPath || pythonCfg.configuredExecutable}. Tried: ${tried}`
			);
		}

		throw new Error(
			`python_env_invalid:interpreter_not_found:Configured python executable is not available: ` +
			`${pythonCfg.configuredExecutable}. Tried: ${tried}`
		);
	}

	for (const candidate of pythonCfg.fallbackExecutables)
	{
		const probe = await probePythonExecutable(candidate, pythonCfg.scriptsRoot);
		if (probe.ok)
		{
			const saved = await saveEnvConfigInternal(loaded.configPath, loaded.config, {
				pythonExecutable: candidate
			});
			loaded.envConfig = {
				envPath: saved.envPath,
				fields: loaded.envConfig ? loaded.envConfig.fields : extractConfigEditorFields(loaded.config),
				env: saved.env
			};

			await writeLog(loaded.logCfg, 'info', 'Python executable initialized in env config', {
				source: source || 'unknown',
				pythonExecutable: candidate
			});

			return {
				pythonExe: candidate,
				persistDefault: true
			};
		}
	}

	throw new Error('python_env_invalid:interpreter_not_found:Python is not installed or not available in PATH. Install Python and set "Python executable" in Edit Config.');
}

async function resolvePythonExecutableForRun({loaded, source})
{
	const envConfig = loaded.envConfig || await readEnvConfigInternal(loaded.configPath, loaded.config);
	const pythonCfg = resolvePythonRuntimeConfig(loaded.config, loaded.configPath, envConfig);
	const resolved = await resolvePythonExecutable({
		loaded,
		pythonCfg,
		source
	});
	return {
		pythonExe: resolved.pythonExe,
		pythonCfg,
		envConfig
	};
}

async function ensurePythonEnvironmentInternal({loaded, source})
{
	const envConfig = loaded.envConfig || await readEnvConfigInternal(loaded.configPath, loaded.config);
	const pythonCfg = resolvePythonRuntimeConfig(loaded.config, loaded.configPath, envConfig);
	const logCfg = loaded.logCfg;
	const resolved = await resolvePythonExecutable({loaded, pythonCfg, source});
	const pythonExe = resolved.pythonExe;
	const details = {
		source: source || 'unknown',
		mode: 'system',
		scriptsRoot: pythonCfg.scriptsRoot,
		pythonExe,
		requirementsFile: pythonCfg.requirementsFile,
		initializedFromSystem: resolved.persistDefault === true
	};

	let installedRequirements = false;
	try
	{
		await fsProm.access(pythonCfg.requirementsFile, fs.constants.R_OK);
		const installResult = await runProcessCapture(pythonExe, ['-m', 'pip', 'install', '-r', pythonCfg.requirementsFile], {
			cwd: pythonCfg.scriptsRoot,
			env: buildPythonExecutionEnv({}, pythonCfg.scriptsRoot)
		});
		if (installResult.code !== 0)
		{
			const stderrTail = tailLines(installResult.stderr || installResult.stdout, 20, 2200);
			const category = classifyBootstrapStderr(stderrTail);
			throw new Error(`missing_dependency:${category}:pip install failed for ${pythonExe}: ${stderrTail}`);
		}
		installedRequirements = true;
	}
	catch (e)
	{
		if (e && typeof e.message === 'string' && e.message.startsWith('missing_dependency:'))
		{
			throw e;
		}
	}
	// requirements file is optional

	await verifyPythonImports({
		pythonExe,
		scriptsRoot: pythonCfg.scriptsRoot,
		modules: pythonCfg.requiredModules
	});

	const result = Object.assign({
		ok: true,
		preflight: 'passed',
		installedRequirements
	}, details);
	await writeLog(logCfg, 'info', 'Python environment preflight passed', result);
	return result;
}

async function ensurePythonEnvironmentCached({loaded, source, force = false})
{
	const key = loaded.configPath;
	if (!force && pythonEnvStatusCache.has(key))
	{
		return pythonEnvStatusCache.get(key);
	}

	const promise = ensurePythonEnvironmentInternal({loaded, source}).catch((e) =>
	{
		pythonEnvStatusCache.delete(key);
		throw e;
	});
	pythonEnvStatusCache.set(key, promise);
	return promise;
}

function resolveEnvPath(configPath)
{
	return path.join(path.dirname(configPath), 'env.yaml');
}

function resolveEventConfigPath(configPath, config)
{
	const eventsCfg = (config && typeof config.events === 'object' && config.events != null) ? config.events : {};
	const configured = (typeof eventsCfg.configFile === 'string' && eventsCfg.configFile.trim().length > 0) ?
		eventsCfg.configFile.trim() : 'events.yaml';
	return path.isAbsolute(configured) ? configured : path.resolve(path.dirname(configPath), configured);
}

function resolveStencilConfigPath(configPath)
{
	return path.join(path.dirname(configPath), 'stencils', 'config.yaml');
}

async function readStencilConfigInternal(configPath)
{
	const stencilPath = resolveStencilConfigPath(configPath);
	let parsed = {};
	try
	{
		const raw = await fsProm.readFile(stencilPath, 'utf8');
		parsed = parseYamlLite(raw);
	}
	catch (e)
	{
		if (!e || e.code !== 'ENOENT')
		{
			throw e;
		}
	}

	if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed))
	{
		parsed = {};
	}
	if (parsed.schemas == null || typeof parsed.schemas !== 'object' || Array.isArray(parsed.schemas))
	{
		parsed.schemas = {};
	}

	return {
		stencilPath,
		config: parsed
	};
}

function normalizeEventConfig(raw)
{
	const source = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
	const schemaPrefix = (typeof source.schemaPrefix === 'string' && source.schemaPrefix.trim().length > 0) ?
		source.schemaPrefix.trim() : 'seaf.';
	const lists = Array.isArray(source.stencilLists) ? source.stencilLists : [];
	const normalizedLists = [];
	const listSeen = new Set();
	for (const item of lists)
	{
		if (!item || typeof item !== 'object')
		{
			continue;
		}
		const id = typeof item.id === 'string' ? item.id.trim() : '';
		if (!id || listSeen.has(id))
		{
			continue;
		}
		listSeen.add(id);
		normalizedLists.push({id});
	}

	const rulesRaw = Array.isArray(source.rules) ? source.rules : [];
	const ruleSeen = new Set();
	const normalizedRules = [];
	for (const rule of rulesRaw)
	{
		if (!rule || typeof rule !== 'object')
		{
			continue;
		}
		const id = typeof rule.id === 'string' ? rule.id.trim() : '';
		if (!id || ruleSeen.has(id))
		{
			continue;
		}
		const handlersSrc = (rule.handlers && typeof rule.handlers === 'object') ? rule.handlers : {};
		const handlers = {};
		for (const key of ['add', 'remove', 'modify', 'reparent', 'connect', 'disconnect'])
		{
			const cmd = typeof handlersSrc[key] === 'string' ? handlersSrc[key].trim() : '';
			if (cmd.length > 0)
			{
				handlers[key] = cmd;
			}
		}
		if (Object.keys(handlers).length === 0)
		{
			continue;
		}
		const normalizedSchema = (typeof rule.schema === 'string' && rule.schema.trim().length > 0) ?
			rule.schema.trim() : (rule.all === true ? 'all' : '');
		if (!normalizedSchema)
		{
			continue;
		}
		const execution = (typeof rule.execution === 'string' && rule.execution.trim().length > 0) ?
			rule.execution.trim().toLowerCase() : 'sync';
		const listId = typeof rule.listId === 'string' ? rule.listId.trim() : '';
		if (listId.length === 0)
		{
			continue;
		}
		ruleSeen.add(id);
		normalizedRules.push({
			id,
			listId,
			schema: normalizedSchema,
			execution: execution === 'async' ? 'async' : 'sync',
			handlers
		});
	}

	return {
		version: Number.isFinite(source.version) ? Number(source.version) : 1,
		enabled: source.enabled !== false,
		schemaPrefix,
		defaultRuleId: typeof source.defaultRuleId === 'string' ? source.defaultRuleId.trim() : 'all',
		stencilLists: normalizedLists,
		rules: normalizedRules
	};
}

async function readEventConfigInternal(configPath, config)
{
	const eventPath = resolveEventConfigPath(configPath, config);
	let parsed = {};
	try
	{
		const raw = await fsProm.readFile(eventPath, 'utf8');
		parsed = parseYamlLite(raw);
	}
	catch (e)
	{
		if (e && e.code !== 'ENOENT')
		{
			throw e;
		}
	}

	return {
		eventPath,
		config: normalizeEventConfig(parsed)
	};
}

function toYamlScalar(value)
{
	if (typeof value === 'string')
	{
		return JSON.stringify(value);
	}
	if (typeof value === 'boolean' || typeof value === 'number')
	{
		return String(value);
	}
	if (value == null)
	{
		return '""';
	}
	return JSON.stringify(String(value));
}

function stringifyFlatYaml(obj)
{
	const lines = [];
	for (const key of Object.keys(obj))
	{
		lines.push(`${key}: ${toYamlScalar(obj[key])}`);
	}
	return `${lines.join('\n')}\n`;
}

function extractConfigEditorFields(config)
{
	if (!config || !Array.isArray(config.commands))
	{
		return [];
	}
	for (const command of config.commands)
	{
		if (command && command.clientAction === 'editConfig' &&
			command.configEditor && Array.isArray(command.configEditor.fields))
		{
			return command.configEditor.fields;
		}
	}
	return [];
}

function normalizeEnvFromSchema(envRaw, fields)
{
	const normalized = {};
	const safeRaw = (envRaw && typeof envRaw === 'object') ? envRaw : {};

	for (const field of fields)
	{
		if (!field || typeof field !== 'object')
		{
			continue;
		}

		const envKey = typeof field.envKey === 'string' ? field.envKey.trim() : '';
		if (!envKey)
		{
			continue;
		}

		const method = typeof field.inputMethod === 'string' ? field.inputMethod : 'text';
		const rawValue = safeRaw[envKey];

		if (method === 'checkbox')
		{
			normalized[envKey] = rawValue === true;
		}
		else if (method === 'list' || method === 'radio')
		{
			const options = Array.isArray(field.options) ? field.options.map((item) => String(item)) : [];
			const fallback = options.length > 0 ? options[0] : '';
			const candidate = rawValue == null ? fallback : String(rawValue);
			normalized[envKey] = options.length > 0 && options.indexOf(candidate) < 0 ? fallback : candidate;
		}
		else
		{
			normalized[envKey] = rawValue == null ? '' : String(rawValue);
		}
	}

	return normalized;
}

function asPlainObject(value)
{
	return (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
}

function collectSchemaKeys(fields, sourceRaw)
{
	if (Array.isArray(fields) && fields.length > 0)
	{
		return fields
			.map((field) => (field && typeof field.envKey === 'string') ? field.envKey.trim() : '')
			.filter((key) => key.length > 0);
	}

	return Object.keys(asPlainObject(sourceRaw));
}

export function mergeEnvByPolicy({localRaw, sourceRaw, fields})
{
	const safeLocalRaw = asPlainObject(localRaw);
	const safeSourceRaw = asPlainObject(sourceRaw);
	const schemaKeys = collectSchemaKeys(fields, safeSourceRaw);
	const mergeKeys = Object.keys(safeLocalRaw);

	for (const key of schemaKeys)
	{
		if (!Object.prototype.hasOwnProperty.call(safeLocalRaw, key))
		{
			mergeKeys.push(key);
		}
	}

	for (const key of Object.keys(safeSourceRaw))
	{
		if (!Object.prototype.hasOwnProperty.call(safeLocalRaw, key) &&
			mergeKeys.indexOf(key) < 0)
		{
			mergeKeys.push(key);
		}
	}

	const merged = {};
	for (const key of mergeKeys)
	{
		if (Object.prototype.hasOwnProperty.call(safeLocalRaw, key))
		{
			merged[key] = safeLocalRaw[key];
		}
		else if (Object.prototype.hasOwnProperty.call(safeSourceRaw, key))
		{
			merged[key] = safeSourceRaw[key];
		}
		else
		{
			merged[key] = null;
		}
	}

	let normalized = merged;
	if (Array.isArray(fields) && fields.length > 0)
	{
		const schemaPart = {};
		for (const key of schemaKeys)
		{
			if (Object.prototype.hasOwnProperty.call(merged, key))
			{
				schemaPart[key] = merged[key];
			}
		}
		const normalizedSchemaPart = normalizeEnvFromSchema(schemaPart, fields);
		normalized = Object.assign({}, merged, normalizedSchemaPart);
	}

	return {
		schemaKeys,
		env: normalized
	};
}

async function readEnvConfigInternal(configPath, config)
{
	const fields = extractConfigEditorFields(config);
	const envPath = resolveEnvPath(configPath);
	let parsed = {};

	try
	{
		const envText = await fsProm.readFile(envPath, 'utf8');
		parsed = parseYamlLite(envText);
	}
	catch (e)
	{
		if (e && e.code !== 'ENOENT')
		{
			throw e;
		}
	}

	return {
		envPath,
		fields,
		env: mergeEnvByPolicy({
			localRaw: parsed,
			sourceRaw: {},
			fields
		}).env
	};
}

async function saveEnvConfigInternal(configPath, config, updates)
{
	const fields = extractConfigEditorFields(config);
	const envPath = resolveEnvPath(configPath);
	let currentRaw = {};
	try
	{
		const envText = await fsProm.readFile(envPath, 'utf8');
		currentRaw = parseYamlLite(envText);
	}
	catch (e)
	{
		if (!e || e.code !== 'ENOENT')
		{
			throw e;
		}
	}

	const mergedLocalRaw = Object.assign({}, asPlainObject(currentRaw), asPlainObject(updates));
	const normalized = mergeEnvByPolicy({
		localRaw: mergedLocalRaw,
		sourceRaw: {},
		fields
	}).env;
	const text = stringifyFlatYaml(normalized);
	const tempPath = `${envPath}.tmp-${randomUUID()}`;
	await fsProm.writeFile(tempPath, text, 'utf8');
	await fsProm.rename(tempPath, envPath);
	return {
		envPath,
		env: normalized
	};
}

async function mergeEnvFileWithSchema(sourceEnvPath, localEnvPath, targetEnvPath, fields)
{
	const tempPath = `${targetEnvPath}.tmp-${randomUUID()}`;
	const sourceRawText = await fsProm.readFile(sourceEnvPath, 'utf8');
	const sourceRaw = parseYamlLite(sourceRawText);
	let localRaw = {};

	try
	{
		if (typeof localEnvPath === 'string' && localEnvPath.length > 0)
		{
			const localRawText = await fsProm.readFile(localEnvPath, 'utf8');
			localRaw = parseYamlLite(localRawText);
		}
	}
	catch (e)
	{
		if (!e || e.code !== 'ENOENT')
		{
			throw e;
		}
	}

	if (!localRaw || typeof localRaw !== 'object' || Object.keys(localRaw).length === 0)
	{
		await fsProm.copyFile(sourceEnvPath, tempPath);
		await fsProm.rename(tempPath, targetEnvPath);
		return;
	}

	const normalized = mergeEnvByPolicy({
		localRaw,
		sourceRaw,
		fields
	}).env;
	await fsProm.writeFile(tempPath, stringifyFlatYaml(normalized), 'utf8');
	await fsProm.rename(tempPath, targetEnvPath);
}

function runPythonProcessTask({pythonExe, scriptPath, inputObj, timeoutSec, onProgress, onStderrLine, cwd, env})
{
	let childRef = null;
	let externalCancelReason = null;
	const promise = new Promise((resolve, reject) =>
	{
		const child = spawn(pythonExe, [scriptPath], {
			stdio: ['pipe', 'pipe', 'pipe'],
			cwd: cwd || process.cwd(),
			env: env || process.env
		});
		childRef = child;

		let stdout = '';
		let stderr = '';
		let stderrLineBuffer = '';
		let done = false;
		let timeoutId = null;
		let timedOut = false;
		const started = Date.now();

		const finish = (result, isError) =>
		{
			if (done)
			{
				return;
			}

			done = true;
			childRef = null;

			if (timeoutId != null)
			{
				clearTimeout(timeoutId);
			}

			if (isError)
			{
				reject(result);
			}
			else
			{
				resolve(result);
			}
		};

		if (timeoutSec > 0)
		{
			timeoutId = setTimeout(() =>
			{
				timedOut = true;
				try
				{
					child.kill('SIGKILL');
				}
				catch (e)
				{
					// Ignore kill errors
				}

				finish({
					error: 'timeout',
					message: `Python script timeout after ${timeoutSec}s`,
					stdout,
					stderr,
					durationMs: Date.now() - started
				}, true);
			}, timeoutSec * 1000);
		}

		child.stdout.on('data', (chunk) =>
		{
			stdout += chunk.toString('utf8');
		});

		child.stderr.on('data', (chunk) =>
		{
			const text = chunk.toString('utf8');
			stderr += text;
			stderrLineBuffer += text;
			const lines = stderrLineBuffer.split(/\r?\n/);
			stderrLineBuffer = lines.pop() || '';

			for (const lineRaw of lines)
			{
				const line = lineRaw.trim();
				if (line.length === 0)
				{
					continue;
				}
				if (!line.startsWith('SEAF_PROGRESS '))
				{
					if (typeof onStderrLine === 'function')
					{
						try
						{
							onStderrLine(line);
						}
						catch (e)
						{
							// ignore stderr callback failures
						}
					}
					continue;
				}

				try
				{
					const parsedProgress = JSON.parse(line.substring('SEAF_PROGRESS '.length));
					if (typeof onProgress === 'function')
					{
						onProgress(parsedProgress);
					}
				}
				catch (e)
				{
					// ignore malformed progress
				}
			}
		});

		child.on('error', (err) =>
		{
			if (timedOut)
			{
				finish({
					error: 'timeout',
					message: `Python script timeout after ${timeoutSec}s`,
					stdout,
					stderr,
					durationMs: Date.now() - started
				}, true);
				return;
			}

			finish({
				error: externalCancelReason === 'cancelled' ? 'cancelled' : 'spawn_error',
				message: externalCancelReason === 'cancelled' ? 'Command cancelled by user' : err.message,
				stdout,
				stderr,
				durationMs: Date.now() - started
			}, true);
		});

		child.on('close', (code) =>
		{
			if (stderrLineBuffer.trim().length > 0 && typeof onStderrLine === 'function')
			{
				try
				{
					onStderrLine(stderrLineBuffer.trim());
				}
				catch (e)
				{
					// ignore stderr callback failures
				}
			}
			let parsed = null;
			const trimmed = stdout.trim();

			if (trimmed.length > 0)
			{
				try
				{
					parsed = JSON.parse(trimmed);
				}
				catch (e)
				{
					// Ignore parse failure; returned below
				}
			}

			if (externalCancelReason === 'cancelled')
			{
				finish({
					error: 'cancelled',
					message: 'Command cancelled by user',
					code,
					stdout,
					stderr,
					durationMs: Date.now() - started
				}, true);
				return;
			}

			if (code !== 0)
			{
				if (parsed != null && typeof parsed === 'object')
				{
					finish({
						code,
						exitCode: code,
						result: parsed,
						stdout,
						stderr,
						durationMs: Date.now() - started
					}, false);
				}
				else
				{
					finish({
						error: 'script_failed',
						message: `Python exited with code ${code}`,
						code,
						stdout,
						stderr,
						parsed,
						durationMs: Date.now() - started
					}, true);
				}
				return;
			}

			if (parsed == null || typeof parsed !== 'object')
			{
				finish({
					error: 'invalid_output',
					message: 'Script must return JSON object to stdout',
					stdout,
					stderr,
					durationMs: Date.now() - started
				}, true);
				return;
			}

			finish({
				code,
				result: parsed,
				stdout,
				stderr,
				durationMs: Date.now() - started
			}, false);
		});

		try
		{
			child.stdin.write(JSON.stringify(inputObj));
			child.stdin.end();
		}
		catch (e)
		{
			finish({
				error: 'stdin_write_failed',
				message: e.message,
				stdout,
				stderr,
				durationMs: Date.now() - started
			}, true);
		}
	});

	return {
		promise,
		cancel(reason = 'cancelled')
		{
			externalCancelReason = reason;
			if (childRef != null)
			{
				try
				{
					childRef.kill('SIGKILL');
				}
				catch (e)
				{
					// Ignore kill errors for already exited process
				}
			}
		}
	};
}

function runPythonProcess(params)
{
	const task = runPythonProcessTask(params);
	return task.promise;
}

function parseScriptLogEntry(stderrLine)
{
	const line = String(stderrLine || '').trim();
	if (!line)
	{
		return null;
	}
	if (line.startsWith('SEAF_ERROR '))
	{
		return {
			level: 'error',
			message: line.substring('SEAF_ERROR '.length).trim(),
			data: null
		};
	}
	if (line.startsWith('SEAF_INFO '))
	{
		return {
			level: 'info',
			message: line.substring('SEAF_INFO '.length).trim(),
			data: null
		};
	}
	if (line.startsWith('SEAF_LOG '))
	{
		const raw = line.substring('SEAF_LOG '.length).trim();
		try
		{
			const parsed = JSON.parse(raw);
			const levelRaw = typeof parsed.level === 'string' ? parsed.level.trim().toLowerCase() : 'info';
			return {
				level: levelRaw === 'error' ? 'error' : 'info',
				message: (typeof parsed.message === 'string' && parsed.message.trim().length > 0) ? parsed.message.trim() : raw,
				data: parsed.data
			};
		}
		catch (e)
		{
			return {
				level: 'error',
				message: raw,
				data: null
			};
		}
	}
	return {
		level: 'error',
		message: line,
		data: null
	};
}

function isScriptInfoLoggingEnabled(envConfig)
{
	const env = (envConfig && envConfig.env && typeof envConfig.env === 'object') ? envConfig.env : {};
	const raw = typeof env.scriptLogLevel === 'string' ? env.scriptLogLevel.trim().toLowerCase() : '';
	return raw === 'info' || raw === 'debug' || raw === 'on' || raw === 'true' || raw === '1';
}

function createPythonStderrLogger({logCfg, envConfig, scriptPath})
{
	const infoEnabled = isScriptInfoLoggingEnabled(envConfig);
	const scriptName = path.basename(scriptPath || 'python-script');
	return (stderrLine) =>
	{
		const entry = parseScriptLogEntry(stderrLine);
		if (entry == null)
		{
			return;
		}
		if (entry.level === 'info' && !infoEnabled)
		{
			return;
		}
		const level = entry.level === 'error' ? 'error' : 'info';
		const prefix = `[PYTHON][${scriptName}][${entry.level === 'error' ? 'ERROR' : 'INFO'}]`;
		const message = `${prefix} ${entry.message || ''}`.trim();
		const data = logCfg.includePayload ? maskSensitive(entry.data) : undefined;
		writeLog(logCfg, level, message, data).catch(() => {});
	};
}

function normalizeErrorMessage(err)
{
	if (err == null)
	{
		return 'Command execution failed';
	}

	if (typeof err === 'string')
	{
		return err;
	}

	if (err.parsed != null && typeof err.parsed.message === 'string' && err.parsed.message.trim().length > 0)
	{
		return err.parsed.message;
	}

	if (typeof err.message === 'string' && err.message.trim().length > 0)
	{
		return err.message;
	}

	if (typeof err.stderr === 'string' && err.stderr.trim().length > 0)
	{
		return err.stderr.trim();
	}

	return 'Command execution failed';
}

function classifyPythonFailure(err)
{
	const stderr = (err && typeof err.stderr === 'string') ? err.stderr : '';
	const noModuleMatch = stderr.match(/No module named ['"]([^'"]+)['"]/);

	if (noModuleMatch)
	{
		return {
			category: 'missing_dependency',
			message: `Missing Python module: ${noModuleMatch[1]}`
		};
	}

	if (/ModuleNotFoundError|ImportError/i.test(stderr))
	{
		return {
			category: 'script_import_error',
			message: 'Python import error'
		};
	}

	if (err && err.error === 'spawn_error')
	{
		return {
			category: 'python_env_invalid',
			message: 'Python interpreter is not available'
		};
	}

	return {
		category: null,
		message: null
	};
}

function normalizeErrorPayload(err)
{
	if (err == null || typeof err !== 'object')
	{
		return err;
	}

	const normalized = Object.assign({}, err);
	normalized.message = normalizeErrorMessage(err);
	const classified = classifyPythonFailure(err);
	normalized.errorCategory = classified.category;
	if (classified.message && (!normalized.message || normalized.message === 'Command execution failed'))
	{
		normalized.message = classified.message;
	}

	if (normalized.parsed && typeof normalized.parsed === 'object')
	{
		if (typeof normalized.parsed.message === 'string' && normalized.parsed.message.trim().length > 0)
		{
			normalized.message = normalized.parsed.message;
		}
	}

	return normalized;
}

function buildPythonDependencyInstruction({pythonExe, requirementsFile})
{
	const exe = (typeof pythonExe === 'string' && pythonExe.trim().length > 0) ? pythonExe.trim() : 'python3';
	const req = (typeof requirementsFile === 'string' && requirementsFile.trim().length > 0) ? requirementsFile.trim() : 'requirements.txt';
	return `${exe} -m pip install -r ${req}`;
}

function findCommand(config, commandId)
{
	return config.commands.find((cmd) => cmd.id === commandId) || null;
}

function normalizeCommandExecution(command)
{
	const execution = command.execution || {};
	return {
		mode: execution.mode === 'async' ? 'async' : 'sync',
		timeoutSec: Number.isFinite(execution.timeoutSec) ? execution.timeoutSec : 30,
		pollIntervalMs: Number.isFinite(execution.pollIntervalMs) ? execution.pollIntervalMs : 1000,
		maxPollAttempts: Number.isFinite(execution.maxPollAttempts) ? execution.maxPollAttempts : 120
	};
}

function normalizeIndicatorConfig(command)
{
	const cfg = command && typeof command.indicator === 'object' ? command.indicator : {};
	return {
		enabled: cfg.enabled === true,
		type: cfg.type === 'percent' ? 'percent' : 'spinner',
		timeoutMs: Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0 ? Math.round(cfg.timeoutMs) : null,
		allowStop: cfg.allowStop === true
	};
}

function isInteractiveTerminalCommand(command)
{
	return command != null && (command.clientAction === 'interactiveTerminal' ||
		command.execution?.mode === 'interactive_terminal');
}

function toEnvVarName(key)
{
	return String(key || '')
		.replace(/[^a-zA-Z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.toUpperCase();
}

function buildInteractiveProcessEnv(baseEnv, command, loaded, envConfig, payload)
{
	const nextEnv = Object.assign({}, process.env, baseEnv || {});
	const envValues = (envConfig && typeof envConfig.env === 'object' && envConfig.env != null) ? envConfig.env : {};
	nextEnv.PYTHONUNBUFFERED = '1';
	nextEnv.SEAF_INTERACTIVE_TERMINAL = '1';
	nextEnv.SEAF_COMMAND_ID = command.id;
	nextEnv.SEAF_COMMAND_TITLE = command.title || command.id;
	nextEnv.SEAF_RUNTIME_CONFIG_PATH = loaded.configPath;
	nextEnv.SEAF_RUNTIME_ENV_PATH = resolveEnvPath(loaded.configPath);
	nextEnv.SEAF_RUNTIME_ENV_JSON = JSON.stringify(envValues);
	nextEnv.SEAF_PAYLOAD_JSON = JSON.stringify(payload || {});

	for (const key of Object.keys(envValues))
	{
		const envVarName = toEnvVarName(key);
		if (!envVarName)
		{
			continue;
		}

		nextEnv[`SEAF_ENV_${envVarName}`] = String(envValues[key]);
	}

	return nextEnv;
}

function runProcessCapture(command, args, options = {})
{
	return new Promise((resolve, reject) =>
	{
		const started = Date.now();
		const child = spawn(command, args, {
			cwd: options.cwd || process.cwd(),
			env: options.env || process.env,
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let stdout = '';
		let stderr = '';

		child.stdout.on('data', (chunk) =>
		{
			stdout += chunk.toString('utf8');
		});
		child.stderr.on('data', (chunk) =>
		{
			stderr += chunk.toString('utf8');
		});
		child.on('error', (err) =>
		{
			reject(new Error(`${command} spawn failed: ${err.message}`));
		});
		child.on('close', (code) =>
		{
			resolve({
				code,
				stdout,
				stderr,
				durationMs: Date.now() - started
			});
		});
	});
}

function trimOutput(output, maxLen = 600)
{
	if (typeof output !== 'string')
	{
		return '';
	}
	const normalized = output.trim();
	return normalized.length > maxLen ? `${normalized.substring(0, maxLen)}...` : normalized;
}

function tailLines(output, maxLines = 20, maxLen = 2000)
{
	if (typeof output !== 'string')
	{
		return '';
	}

	const normalized = output.replace(/\r/g, '').trim();
	if (!normalized)
	{
		return '';
	}

	const lines = normalized.split('\n');
	const tail = lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
	return tail.length > maxLen ? `...${tail.slice(tail.length - maxLen)}` : tail;
}

function resolveMaybeRelative(baseFilePath, candidate)
{
	if (typeof candidate !== 'string' || candidate.trim().length === 0)
	{
		return null;
	}
	if (path.isAbsolute(candidate))
	{
		return candidate;
	}
	return path.resolve(path.dirname(baseFilePath), candidate);
}

async function readRuntimeVersionFromDir(runtimeDir)
{
	try
	{
		const raw = await fsProm.readFile(path.join(runtimeDir, 'version.json'), 'utf8');
		const parsed = JSON.parse(raw);
		return (parsed && typeof parsed.version === 'string' && parsed.version.trim().length > 0) ?
			parsed.version.trim() : null;
	}
	catch (e)
	{
		return null;
	}
}

async function ensureGitAvailable(logCfg)
{
	let result = null;
	try
	{
		result = await runProcessCapture('git', ['--version']);
	}
	catch (e)
	{
		await writeLog(logCfg, 'error', 'git client not installed', {
			error: e && e.message ? e.message : String(e)
		});
		throw new Error('На ПК не установлен клиент git');
	}
	await writeLog(logCfg, result.code === 0 ? 'info' : 'error', 'git --version executed', {
		code: result.code,
		stdout: trimOutput(result.stdout),
		stderr: trimOutput(result.stderr)
	});
	if (result.code !== 0)
	{
		throw new Error('На ПК не установлен клиент git');
	}
}

async function validateUpdatePrerequisites({cfgPath, updateCfg, privateKeyPath, logCfg})
{
	const assetPath = String(updateCfg.assetPath || '').trim();
	if (assetPath.length === 0)
	{
		throw new Error('Не задан путь к asset update.assetPath');
	}

	if (assetPath.includes('..') || assetPath.startsWith('/'))
	{
		throw new Error(`Некорректный update.assetPath: ${assetPath}`);
	}

	if (!privateKeyPath)
	{
		throw new Error('Не задан путь к приватному ключу update.ssh.privateKeyPath');
	}

	await fsProm.access(privateKeyPath, fs.constants.R_OK)
		.catch(() => Promise.reject(new Error(`Не найден приватный ключ SSH: ${privateKeyPath}`)));

	const keyStat = await fsProm.stat(privateKeyPath);
	const keyMode = keyStat.mode & 0o777;
	if ((keyMode & 0o077) !== 0)
	{
		await writeLog(logCfg, 'warn', 'Private key has overly broad permissions', {
			privateKeyPath,
			mode: keyMode.toString(8)
		});
	}

	const publicKeyPath = resolveMaybeRelative(cfgPath, updateCfg?.ssh?.publicKeyPath);
	if (publicKeyPath)
	{
		await fsProm.access(publicKeyPath, fs.constants.R_OK)
			.catch(() => Promise.reject(new Error(`Не найден публичный ключ SSH: ${publicKeyPath}`)));
	}
}

async function createGitSshWrapper(tempRoot, privateKeyPath)
{
	const wrapperPath = path.join(tempRoot, 'git_ssh_wrapper.sh');
	const escaped = privateKeyPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
	const script = `#!/usr/bin/env sh\nexec ssh -i "${escaped}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new "$@"\n`;
	await fsProm.writeFile(wrapperPath, script, 'utf8');
	await fsProm.chmod(wrapperPath, 0o700);
	return wrapperPath;
}

async function fetchArchiveFromSshGit({
	repoSsh,
	ref,
	assetPath,
	tempRoot,
	gitSshCommand,
	logCfg
})
{
	const env = Object.assign({}, process.env, {
		GIT_SSH_COMMAND: gitSshCommand
	});
	const lsRemote = await runProcessCapture('git', ['ls-remote', repoSsh, ref], {env, cwd: tempRoot});
	await writeLog(logCfg, lsRemote.code === 0 ? 'info' : 'error', 'git ls-remote finished', {
		repoSsh,
		ref,
		code: lsRemote.code,
		stdout: trimOutput(lsRemote.stdout),
		stderr: trimOutput(lsRemote.stderr)
	});
	if (lsRemote.code !== 0)
	{
		throw new Error(`Нет доступа к репозиторию по SSH (${repoSsh}, ref=${ref}): ${trimOutput(lsRemote.stderr) || 'unknown error'}`);
	}

	const cloneDir = path.join(tempRoot, 'repo');
	const clone = await runProcessCapture('git', ['clone', '--depth', '1', '--branch', ref, repoSsh, cloneDir], {env, cwd: tempRoot});
	await writeLog(logCfg, clone.code === 0 ? 'info' : 'error', 'git clone finished', {
		repoSsh,
		ref,
		code: clone.code,
		stdout: trimOutput(clone.stdout),
		stderr: trimOutput(clone.stderr)
	});
	if (clone.code !== 0)
	{
		throw new Error(`Не удалось скачать обновление из репозитория (${repoSsh}, ref=${ref}): ${trimOutput(clone.stderr) || 'unknown error'}`);
	}

	const sourceArchive = path.resolve(cloneDir, assetPath);
	try
	{
		await fsProm.access(sourceArchive, fs.constants.R_OK);
	}
	catch (e)
	{
		throw new Error(`Файл обновления не найден в репозитории: ${assetPath}`);
	}

	const archivePath = path.join(tempRoot, path.basename(assetPath));
	await fsProm.copyFile(sourceArchive, archivePath);
	await writeLog(logCfg, 'info', 'SSH update asset prepared', {
		assetPath,
		archivePath
	});
	return archivePath;
}

function ensureHttps(urlString)
{
	const parsed = new URL(urlString);

	if (parsed.protocol !== 'https:')
	{
		throw new Error('Only https URLs are allowed for runtime update');
	}

	return parsed;
}

function httpGetJson(urlString, headers = {}, redirectsLeft = 5)
{
	return new Promise((resolve, reject) =>
	{
		const parsed = ensureHttps(urlString);
		const req = https.request({
			protocol: parsed.protocol,
			hostname: parsed.hostname,
			port: parsed.port || 443,
			path: parsed.pathname + parsed.search,
			method: 'GET',
			headers: Object.assign({
				'User-Agent': 'drawio-seaf-plugin-updater',
				'Accept': 'application/vnd.github+json'
			}, headers)
		}, (res) =>
		{
			if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0)
			{
				resolve(httpGetJson(res.headers.location, headers, redirectsLeft - 1));
				return;
			}

			let body = '';
			res.setEncoding('utf8');
			res.on('data', (chunk) => { body += chunk; });
			res.on('end', () =>
			{
				if (res.statusCode < 200 || res.statusCode >= 300)
				{
					reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
					return;
				}

				try
				{
					resolve(JSON.parse(body));
				}
				catch (e)
				{
					reject(new Error(`Invalid JSON response: ${e.message}`));
				}
			});
		});

		req.on('error', reject);
		req.end();
	});
}

function downloadToFile(urlString, targetFile, headers = {}, redirectsLeft = 5)
{
	return new Promise((resolve, reject) =>
	{
		const parsed = ensureHttps(urlString);
		const req = https.request({
			protocol: parsed.protocol,
			hostname: parsed.hostname,
			port: parsed.port || 443,
			path: parsed.pathname + parsed.search,
			method: 'GET',
			headers: Object.assign({
				'User-Agent': 'drawio-seaf-plugin-updater',
				'Accept': 'application/octet-stream'
			}, headers)
		}, (res) =>
		{
			if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0)
			{
				resolve(downloadToFile(res.headers.location, targetFile, headers, redirectsLeft - 1));
				return;
			}

			if (res.statusCode < 200 || res.statusCode >= 300)
			{
				reject(new Error(`Asset download failed with HTTP ${res.statusCode}`));
				return;
			}

			const ws = fs.createWriteStream(targetFile);
			res.pipe(ws);
			ws.on('finish', () =>
			{
				ws.close(() => resolve({ok: true}));
			});
			ws.on('error', (err) => reject(err));
		});

		req.on('error', reject);
		req.end();
	});
}

function runTarExtract(archivePath, outputDir)
{
	return new Promise((resolve, reject) =>
	{
		const tarProc = spawn('tar', ['-xzf', archivePath, '-C', outputDir], {stdio: ['ignore', 'pipe', 'pipe']});
		let stderr = '';

		tarProc.stderr.on('data', (chunk) =>
		{
			stderr += chunk.toString('utf8');
		});

		tarProc.on('error', (err) =>
		{
			reject(new Error(`Tar execution failed: ${err.message}`));
		});

		tarProc.on('close', (code) =>
		{
			if (code !== 0)
			{
				reject(new Error(`Tar extraction failed with code ${code}: ${stderr}`));
				return;
			}

			resolve({ok: true});
		});
	});
}

async function pickExtractRoot(extractDir)
{
	const entries = await fsProm.readdir(extractDir, {withFileTypes: true});
	const visible = entries.filter((e) => !e.name.startsWith('.'));

	if (visible.length === 1 && visible[0].isDirectory())
	{
		return path.join(extractDir, visible[0].name);
	}

	return extractDir;
}

export async function applyRuntimeFromExtractRoot(extractRoot, pluginsDir)
{
	const sourcePluginFile = path.join(extractRoot, 'seaf.plugin.js');
	const sourceBulkModuleFile = path.join(extractRoot, 'seaf-bulk-edit-data-module.js');
	const sourceRuntimeDir = path.join(extractRoot, 'seaf_plugin');
	const targetPluginFile = path.join(pluginsDir, 'seaf.plugin.js');
	const targetBulkModuleFile = path.join(pluginsDir, 'seaf-bulk-edit-data-module.js');
	const targetRuntimeDir = path.join(pluginsDir, 'seaf_plugin');
	const sourceEnvFile = path.join(sourceRuntimeDir, 'conf', 'env.yaml');
	const sourceBulkExists = fs.existsSync(sourceBulkModuleFile);

	await fsProm.access(sourcePluginFile, fs.constants.R_OK);
	await fsProm.access(sourceRuntimeDir, fs.constants.R_OK);
	await fsProm.access(sourceEnvFile, fs.constants.R_OK);
	if (!sourceBulkExists)
	{
		throw new Error(`Runtime archive is missing required file: ${sourceBulkModuleFile}`);
	}

	const tempPluginFile = path.join(pluginsDir, `.seaf.plugin.js.new-${randomUUID()}`);
	const tempBulkModuleFile = path.join(pluginsDir, `.seaf-bulk-edit-data-module.js.new-${randomUUID()}`);
	const tempRuntimeDir = path.join(pluginsDir, `.seaf_plugin.new-${randomUUID()}`);
	const backupPluginFile = path.join(pluginsDir, `.seaf.plugin.js.bak-${randomUUID()}`);
	const backupBulkModuleFile = path.join(pluginsDir, `.seaf-bulk-edit-data-module.js.bak-${randomUUID()}`);
	const backupRuntimeDir = path.join(pluginsDir, `.seaf_plugin.bak-${randomUUID()}`);
	let hadPluginBefore = false;
	let hadBulkModuleBefore = false;
	let hadRuntimeBefore = false;
	let localEnvPath = null;
	let migratedVenv = false;

	await fsProm.copyFile(sourcePluginFile, tempPluginFile);
	await fsProm.copyFile(sourceBulkModuleFile, tempBulkModuleFile);
	await fsProm.cp(sourceRuntimeDir, tempRuntimeDir, {recursive: true, force: true});

	try
	{
		if (fs.existsSync(targetPluginFile))
		{
			hadPluginBefore = true;
			await fsProm.rename(targetPluginFile, backupPluginFile);
		}
		if (fs.existsSync(targetBulkModuleFile))
		{
			hadBulkModuleBefore = true;
			await fsProm.rename(targetBulkModuleFile, backupBulkModuleFile);
		}

		await fsProm.rename(tempPluginFile, targetPluginFile);
		await fsProm.rename(tempBulkModuleFile, targetBulkModuleFile);

		if (fs.existsSync(targetRuntimeDir))
		{
			hadRuntimeBefore = true;
			await fsProm.rename(targetRuntimeDir, backupRuntimeDir);
			localEnvPath = path.join(backupRuntimeDir, 'conf', 'env.yaml');
		}

		await fsProm.rename(tempRuntimeDir, targetRuntimeDir);
		const targetConfigPath = path.join(targetRuntimeDir, 'conf', 'plugin.yaml');
		let targetConfig = null;
		try
		{
			const targetConfigRaw = await fsProm.readFile(targetConfigPath, 'utf8');
			targetConfig = parseYamlLite(targetConfigRaw);
		}
		catch (e)
		{
			targetConfig = null;
		}
		const fields = extractConfigEditorFields(targetConfig);
		const targetEnvPath = path.join(targetRuntimeDir, 'conf', 'env.yaml');
		await mergeEnvFileWithSchema(sourceEnvFile, localEnvPath, targetEnvPath, fields);
		const backupVenvDir = path.join(backupRuntimeDir, '.venv');
		const targetVenvDir = path.join(targetRuntimeDir, '.venv');
		if (fs.existsSync(backupVenvDir) && !fs.existsSync(targetVenvDir))
		{
			await fsProm.cp(backupVenvDir, targetVenvDir, {recursive: true, force: true});
			migratedVenv = true;
		}
		return {
			migratedVenv
		};
	}
	catch (e)
	{
		// Best-effort rollback without leaving partially switched runtime.
		try
		{
			if (fs.existsSync(backupPluginFile))
			{
				if (fs.existsSync(targetPluginFile))
				{
					await fsProm.rm(targetPluginFile, {force: true});
				}
				await fsProm.rename(backupPluginFile, targetPluginFile);
			}
			else if (!hadPluginBefore && fs.existsSync(targetPluginFile))
			{
				await fsProm.rm(targetPluginFile, {force: true});
			}
			if (fs.existsSync(backupBulkModuleFile))
			{
				if (fs.existsSync(targetBulkModuleFile))
				{
					await fsProm.rm(targetBulkModuleFile, {force: true});
				}
				await fsProm.rename(backupBulkModuleFile, targetBulkModuleFile);
			}
			else if (!hadBulkModuleBefore && fs.existsSync(targetBulkModuleFile))
			{
				await fsProm.rm(targetBulkModuleFile, {force: true});
			}
		}
		catch (rollbackErr)
		{
			// ignore rollback error
		}

		try
		{
			if (fs.existsSync(backupRuntimeDir))
			{
				if (fs.existsSync(targetRuntimeDir))
				{
					await fsProm.rm(targetRuntimeDir, {recursive: true, force: true});
				}
				await fsProm.rename(backupRuntimeDir, targetRuntimeDir);
			}
			else if (!hadRuntimeBefore && fs.existsSync(targetRuntimeDir))
			{
				await fsProm.rm(targetRuntimeDir, {recursive: true, force: true});
			}
		}
		catch (rollbackErr)
		{
			// ignore rollback error
		}

		throw e;
	}
	finally
	{
		// Always cleanup leftovers.
		await fsProm.rm(tempPluginFile, {force: true}).catch(() => {});
		await fsProm.rm(tempBulkModuleFile, {force: true}).catch(() => {});
		await fsProm.rm(tempRuntimeDir, {recursive: true, force: true}).catch(() => {});
		await fsProm.rm(backupPluginFile, {force: true}).catch(() => {});
		await fsProm.rm(backupBulkModuleFile, {force: true}).catch(() => {});
		await fsProm.rm(backupRuntimeDir, {recursive: true, force: true}).catch(() => {});
	}
}

async function cleanupLegacyNestedRuntime(pluginsDir, logCfg)
{
	const legacyNestedDir = path.join(pluginsDir, 'seaf_plugin', 'seaf_plugin');
	const legacyNestedPlugin = path.join(pluginsDir, 'seaf_plugin', 'seaf.plugin.js');

	if (fs.existsSync(legacyNestedDir))
	{
		await fsProm.rm(legacyNestedDir, {recursive: true, force: true});
		await writeLog(logCfg, 'warn', 'Removed legacy nested runtime directory', {
			path: legacyNestedDir
		});
	}

	if (fs.existsSync(legacyNestedPlugin))
	{
		await fsProm.rm(legacyNestedPlugin, {force: true});
		await writeLog(logCfg, 'warn', 'Removed legacy misplaced runtime plugin file', {
			path: legacyNestedPlugin
		});
	}
}

async function runNativeSshRuntimeUpdate({loaded, commandId, onProgress})
{
	const reportProgress = (progress, phase, message) =>
	{
		if (typeof onProgress === 'function')
		{
			onProgress({
				progress,
				phase,
				message
			});
		}
	};

	const cfgPath = loaded.configPath;
	const configDir = path.dirname(cfgPath);
	const pluginsDir = path.resolve(configDir, '..', '..');
	const updateCfg = (loaded.config && typeof loaded.config.update === 'object') ? loaded.config.update : {};
	const mode = String(updateCfg.mode || 'ssh_git').trim();

	if (updateCfg.enabled === false)
	{
		throw new Error('SEAF runtime update is disabled in plugin.yaml (update.enabled=false)');
	}

	if (mode !== 'ssh_git')
	{
		throw new Error(`Unsupported update.mode: ${mode}. Only ssh_git is allowed`);
	}

	const repoSsh = String(updateCfg.gitRepoSsh || '').trim();
	const ref = String(updateCfg.gitRef || 'master').trim() || 'master';
	const assetPath = String(updateCfg.assetPath || 'release/out/seaf-plugin-runtime.tar.gz').trim();
	const expectedMinVersion = String(updateCfg.expectedMinVersion || '').trim();
	const privateKeyPath = resolveMaybeRelative(cfgPath, updateCfg?.ssh?.privateKeyPath);

	if (!repoSsh)
	{
		throw new Error('Не задан update.gitRepoSsh в plugin.yaml');
	}

	await validateUpdatePrerequisites({
		cfgPath,
		updateCfg,
		privateKeyPath,
		logCfg: loaded.logCfg
	});
	reportProgress(5, 'precheck', 'Проверка параметров обновления');

	await ensureGitAvailable(loaded.logCfg);
	await cleanupLegacyNestedRuntime(pluginsDir, loaded.logCfg);
	reportProgress(20, 'precheck_done', 'Проверки завершены');

	const beforeVersion = await readRuntimeVersionFromDir(path.join(pluginsDir, 'seaf_plugin', 'runtime'));
	const tempRoot = path.join(pluginsDir, `.seaf_runtime_update_${Date.now()}_${Math.round(Math.random() * 99999)}`);
	await fsProm.mkdir(tempRoot, {recursive: true});

	try
	{
		const gitSshWrapper = await createGitSshWrapper(tempRoot, privateKeyPath);
		reportProgress(30, 'fetch', 'Загрузка архива обновления');
		const archivePath = await fetchArchiveFromSshGit({
			repoSsh,
			ref,
			assetPath,
			tempRoot,
			gitSshCommand: gitSshWrapper,
			logCfg: loaded.logCfg
		});
		const extractDir = path.join(tempRoot, 'extract');
		await fsProm.mkdir(extractDir, {recursive: true});
		reportProgress(55, 'extract', 'Распаковка runtime архива');
		await runTarExtract(archivePath, extractDir);
		const extractRoot = await pickExtractRoot(extractDir);
		const newVersion = await readRuntimeVersionFromDir(path.join(extractRoot, 'seaf_plugin', 'runtime'));
		if (expectedMinVersion && newVersion)
		{
			const cmp = compareVersions(newVersion, expectedMinVersion);
			if (cmp == null)
			{
				throw new Error(`Невозможно сравнить версии runtime asset (${newVersion}) и expectedMinVersion (${expectedMinVersion})`);
			}
			if (cmp < 0)
			{
				throw new Error(`Получен устаревший runtime asset: ${newVersion} < ${expectedMinVersion}`);
			}
		}
		else if (expectedMinVersion && !newVersion)
		{
			throw new Error(`Не удалось определить версию runtime asset при expectedMinVersion=${expectedMinVersion}`);
		}

		if (beforeVersion && newVersion && beforeVersion === newVersion)
		{
			await writeLog(loaded.logCfg, 'info', 'Runtime update skipped: already up to date', {
				commandId,
				version: beforeVersion
			});
			return {
				status: 'success',
				message: `Установлена актуальная версия ${beforeVersion}`,
				payload: {
					status: 'already_up_to_date',
					requiresRestart: false,
					version: beforeVersion,
					source: {
						mode: 'ssh_git',
						repoSsh,
						ref,
						assetPath
					}
				},
				commands: []
			};
		}

		reportProgress(80, 'apply', 'Применение новой версии runtime');
		const applyInfo = await applyRuntimeFromExtractRoot(extractRoot, pluginsDir);
		reportProgress(86, 'python_bootstrap', 'Подготовка Python окружения');
		const pythonBootstrap = await bootstrapPythonRuntimeOnInstallOrUpdate({
			loaded,
			source: 'runtime_update',
			allowDependencyInstall: true,
			allowFallback: true,
			persistFallback: true
		});
		if (pythonBootstrap && pythonBootstrap.ok !== true)
		{
			await writeLog(loaded.logCfg, 'warn', 'Runtime updated, but Python bootstrap failed', {
				commandId,
				pythonBootstrap
			});
		}
		let runtimeHealth = {ok: true, stage: 'postcheck'};
		try
		{
			const postcheck = await ensurePythonEnvironmentCached({
				loaded,
				source: 'runtime_update_postcheck',
				force: true
			});
			runtimeHealth = Object.assign({ok: true, stage: 'postcheck'}, postcheck || {});
		}
		catch (postErr)
		{
			const rawPostErr = postErr && postErr.message ? String(postErr.message) : String(postErr);
			runtimeHealth = {
				ok: false,
				stage: 'postcheck',
				reason: 'python_env_invalid',
				error: rawPostErr,
				hint: 'Откройте SEAF → Edit Config и проверьте Python executable, затем выполните Диагностику/Повторить bootstrap.'
			};
			await writeLog(loaded.logCfg, 'warn', 'Runtime updated, but Python post-check failed', {
				commandId,
				runtimeHealth
			});
		}
		reportProgress(90, 'verification', 'Проверка установленной версии');
		const installedVersion = await readRuntimeVersionFromDir(path.join(pluginsDir, 'seaf_plugin', 'runtime'));
		const finalVersion = installedVersion || newVersion || beforeVersion || 'unknown';
		await writeLog(loaded.logCfg, 'info', 'Runtime updated successfully', {
			commandId,
			version: finalVersion,
			source: {
				mode: 'ssh_git',
				repoSsh,
				ref,
				assetPath
			}
		});

		const degraded = !!(runtimeHealth && runtimeHealth.ok === false);
		return {
			status: 'success',
			message: degraded ?
				`Версия плагина обновлена до версии ${finalVersion}, но Python post-check завершился с ошибкой` :
				`Версия плагина обновлена до версии ${finalVersion}`,
			payload: {
				status: degraded ? 'updated_degraded' : 'updated',
				degradedMessage: degraded ? 'Плагин обновлен, но проверка Python окружения после обновления не пройдена.' : '',
				requiresRestart: true,
				version: finalVersion,
				pythonBootstrap,
				runtimeHealth,
				runtimeApply: {
					migratedVenv: !!(applyInfo && applyInfo.migratedVenv)
				},
				source: {
					mode: 'ssh_git',
					repoSsh,
					ref,
					assetPath
				}
			},
			commands: []
		};
	}
	finally
	{
		reportProgress(100, 'finalize', 'Завершение обновления');
		await fsProm.rm(tempRoot, {recursive: true, force: true}).catch(() => {});
	}
}

export function createSeafPluginService({getAppDataFolder})
{
	return {
		async loadConfig(configPath)
		{
			const loaded = await loadConfigInternal(configPath, getAppDataFolder);
			await writeLog(loaded.logCfg, 'info', 'Plugin config loaded', {
				configPath: loaded.configPath,
				commandsCount: loaded.config.commands.length
			});

			return {
				configPath: loaded.configPath,
				config: loaded.config
			};
		},

		async writeClientLog(args)
		{
			const loaded = await loadConfigInternal(args?.configPath || null, getAppDataFolder);
			const level = args?.level || 'info';
			const data = args?.data || null;
			await writeLog(loaded.logCfg, level, args?.message || 'client log', data);
			return {ok: true};
		},

		async readRuntimeFile(args)
		{
			const loaded = await loadConfigInternal(args?.configPath || null, getAppDataFolder);
			const relPath = (typeof args?.relativePath === 'string') ? args.relativePath.trim() : '';
			if (!relPath)
			{
				throw new Error('relativePath is required');
			}

			const normalized = relPath.replace(/\\/g, '/');
			if (normalized.startsWith('/') || normalized.includes('..'))
			{
				throw new Error(`Unsafe relativePath: ${relPath}`);
			}

			const confDir = path.dirname(loaded.configPath);
			const targetPath = path.resolve(confDir, normalized);
			if (!targetPath.startsWith(confDir + path.sep))
			{
				throw new Error(`Path escapes runtime conf directory: ${relPath}`);
			}

			const encoding = (typeof args?.encoding === 'string' && args.encoding.trim().length > 0) ?
				args.encoding.trim() : 'utf8';
			return await fsProm.readFile(targetPath, encoding);
		},

		async ensurePythonEnvironment(args)
		{
			const loaded = await loadConfigInternal(args?.configPath || null, getAppDataFolder);
			try
			{
				return await ensurePythonEnvironmentCached({
					loaded,
					source: args?.source || 'manual',
					force: args?.force === true
				});
			}
			catch (e)
			{
				const envConfig = loaded.envConfig || await readEnvConfigInternal(loaded.configPath, loaded.config);
				const pythonCfg = resolvePythonRuntimeConfig(loaded.config, loaded.configPath, envConfig);
				const chosenPython = (envConfig && envConfig.env && typeof envConfig.env.pythonExecutable === 'string' &&
					envConfig.env.pythonExecutable.trim().length > 0) ?
					envConfig.env.pythonExecutable.trim() : pythonCfg.defaultExecutable;
				const manualCommand = buildPythonDependencyInstruction({
					pythonExe: chosenPython,
					requirementsFile: pythonCfg.requirementsFile
				});
				const rawMsg = e && e.message ? String(e.message) : String(e);
				const firstColon = rawMsg.indexOf(':');
				const secondColon = firstColon >= 0 ? rawMsg.indexOf(':', firstColon + 1) : -1;
				const thirdColon = secondColon >= 0 ? rawMsg.indexOf(':', secondColon + 1) : -1;
				const topCategory = firstColon > 0 ? rawMsg.slice(0, firstColon) : 'python_env_invalid';
				const subCategory = (firstColon > 0 && secondColon > firstColon) ?
					rawMsg.slice(firstColon + 1, secondColon) : 'unknown';
				const userMessage = thirdColon > secondColon ?
					rawMsg.slice(secondColon + 1).trim() :
					rawMsg.replace(/^[a-z_]+:/i, '').trim();
				await writeLog(loaded.logCfg, 'error', 'Python environment bootstrap failed', {
					errorCategory: topCategory,
					errorSubCategory: subCategory,
					error: rawMsg,
					pythonExecutable: chosenPython,
					requirementsFile: pythonCfg.requirementsFile,
					manualInstallCommand: manualCommand
				});
				let hint = '';
				if (topCategory === 'python_env_invalid' && subCategory === 'interpreter_not_found')
				{
					hint = ' Установите Python и задайте путь в Edit Config -> Python executable.';
				}
				else if (topCategory === 'missing_dependency')
				{
					hint = ` Выполните: ${manualCommand}`;
				}
				throw new Error(`[${topCategory}/${subCategory}] ${userMessage}${hint}`);
			}
		},

		async bootstrapPythonRuntime(args)
		{
			const loaded = await loadConfigInternal(args?.configPath || null, getAppDataFolder);
			const options = {
				allowDependencyInstall: true,
				allowFallback: true,
				persistFallback: true
			};
			if (args && typeof args === 'object')
			{
				if (args.allowDependencyInstall === true)
				{
					options.allowDependencyInstall = true;
				}
				if (args.allowFallback === true)
				{
					options.allowFallback = true;
				}
				if (args.persistFallback === true)
				{
					options.persistFallback = true;
				}
			}
			const pythonBootstrap = await bootstrapPythonRuntimeOnInstallOrUpdate({
				loaded,
				source: args?.source || 'manual_bootstrap',
				allowDependencyInstall: options.allowDependencyInstall,
				allowFallback: options.allowFallback,
				persistFallback: options.persistFallback
			});
			if (pythonBootstrap && pythonBootstrap.ok !== true)
			{
				await writeLog(loaded.logCfg, 'warn', 'Python runtime bootstrap finished with error', {
					source: args?.source || 'manual_bootstrap',
					pythonBootstrap
				});
			}
			return pythonBootstrap;
		},

		async runCommand(args)
		{
			const loaded = await loadConfigInternal(args?.configPath || null, getAppDataFolder);
			const command = findCommand(loaded.config, args?.commandId);

			if (command == null)
			{
				throw new Error(`Unknown command id: ${args?.commandId}`);
			}

			const execution = normalizeCommandExecution(command);

			if (command.id === 'seafUpdatePlugin')
			{
				const releaseLock = acquireRuntimeUpdateLock();
				let result = null;
				try
				{
					result = await runNativeSshRuntimeUpdate({
						loaded,
						commandId: command.id
					});
				}
				finally
				{
					releaseLock();
					invalidateConfigCache(loaded.configPath, getAppDataFolder);
				}

				return {
					accepted: true,
					mode: 'sync',
					result,
					meta: {
						nativeUpdate: true
					}
				};
			}

			await ensurePythonEnvironmentCached({
				loaded,
				source: `command:${command.id}`
			});

			const scriptPath = resolveScriptPath(command, loaded.config, loaded.configPath);
			const envConfig = loaded.envConfig || await readEnvConfigInternal(loaded.configPath, loaded.config);
			const pythonRuntime = resolvePythonRuntimeConfig(loaded.config, loaded.configPath, envConfig);
			const resolvedPython = await resolvePythonExecutable({
				loaded,
				pythonCfg: pythonRuntime,
				source: `command-run:${command.id}`
			});
			const pythonExe = resolvedPython.pythonExe;
			const pythonProcessEnv = buildPythonExecutionEnv({}, pythonRuntime.scriptsRoot);
			const payload = args?.payload && typeof args.payload === 'object' ? Object.assign({}, args.payload) : {};
			payload.env = Object.assign({}, envConfig.env);
			payload.arguments = Object.assign({}, payload.arguments || {}, envConfig.env);
			const inputObj = buildRunnerInput(command, payload);
			const safeInput = loaded.logCfg.includePayload ?
				maskSensitive(inputObj) : {commandId: command.id};
			const onPythonStderrLine = createPythonStderrLogger({
				logCfg: loaded.logCfg,
				envConfig,
				scriptPath
			});

			await writeLog(loaded.logCfg, 'info', 'Command started', {
				commandId: command.id,
				mode: execution.mode,
				timeoutSec: execution.timeoutSec,
				scriptPath,
				input: safeInput
			});

			if (execution.mode === 'async')
			{
				const indicator = normalizeIndicatorConfig(command);
				const timeoutMs = indicator.enabled ?
					(indicator.timeoutMs != null ? indicator.timeoutMs : null) :
					(Math.max(0, execution.timeoutSec) * 1000);
				const timeoutSec = timeoutMs != null ? timeoutMs / 1000 : 0;
				const jobId = randomUUID();
				const createdAt = nowIso();
				runningJobs.set(jobId, {
					status: 'running',
					commandId: command.id,
					createdAt,
					startedAt: createdAt,
					updatedAt: createdAt,
					indicator: {
						enabled: indicator.enabled,
						type: indicator.type,
						timeoutMs: timeoutMs,
						allowStop: indicator.allowStop
					},
					progress: null,
					phase: 'running',
					message: null,
					cancelRequested: false,
					finishReason: null,
					timeoutAt: timeoutMs != null ? new Date(Date.now() + timeoutMs).toISOString() : null
				});

				const task = runPythonProcessTask({
					pythonExe,
					scriptPath,
					inputObj,
					timeoutSec,
					cwd: pythonRuntime.scriptsRoot,
					env: pythonProcessEnv,
					onStderrLine: onPythonStderrLine,
					onProgress: (progressEvent) =>
					{
						const current = runningJobs.get(jobId);
						if (current == null || current.status !== 'running')
						{
							return;
						}

						const next = Object.assign({}, current, {
							updatedAt: nowIso()
						});

						if (Number.isFinite(progressEvent?.progress))
						{
							next.progress = Math.max(0, Math.min(100, Math.round(progressEvent.progress)));
						}

						if (typeof progressEvent?.phase === 'string' && progressEvent.phase.trim().length > 0)
						{
							next.phase = progressEvent.phase.trim();
						}

						if (typeof progressEvent?.message === 'string' && progressEvent.message.trim().length > 0)
						{
							next.message = progressEvent.message.trim();
						}

						runningJobs.set(jobId, next);
					}
				});

				const currentJob = runningJobs.get(jobId);
				if (currentJob != null)
				{
					currentJob.cancel = task.cancel;
					runningJobs.set(jobId, currentJob);
				}

				task.promise.then(async (output) =>
				{
					runningJobs.set(jobId, {
						status: 'completed',
						commandId: command.id,
						createdAt: runningJobs.get(jobId)?.createdAt || createdAt,
						startedAt: runningJobs.get(jobId)?.startedAt || createdAt,
						updatedAt: nowIso(),
						finishedAt: nowIso(),
						finishReason: 'completed',
						indicator: runningJobs.get(jobId)?.indicator || null,
						progress: 100,
						phase: 'completed',
						result: output.result,
						meta: getReducedAsyncMeta(output)
					});

					await writeLog(loaded.logCfg, 'info', 'Async command completed', {
						commandId: command.id,
						jobId,
						durationMs: output.durationMs
					});
				}).catch(async (err) =>
				{
					const normalizedErr = normalizeErrorPayload(err);
					const errorCode = normalizedErr && normalizedErr.error ? normalizedErr.error : null;
					const status = errorCode === 'timeout' ? 'timed_out' :
						(errorCode === 'cancelled' ? 'cancelled' : 'failed');
					runningJobs.set(jobId, {
						status: status,
						commandId: command.id,
						createdAt: runningJobs.get(jobId)?.createdAt || createdAt,
						startedAt: runningJobs.get(jobId)?.startedAt || createdAt,
						updatedAt: nowIso(),
						finishedAt: nowIso(),
						finishReason: status,
						indicator: runningJobs.get(jobId)?.indicator || null,
						error: normalizeErrorMessage(normalizedErr),
						errorDetails: getReducedErrorDetails(normalizedErr)
					});

					await writeLog(loaded.logCfg, status === 'cancelled' ? 'warn' : 'error', 'Async command failed', {
						commandId: command.id,
						jobId,
						errorCategory: normalizedErr.errorCategory || null,
						error: normalizeErrorMessage(normalizedErr),
						status
					});
				});

				return {
					accepted: true,
					mode: 'async',
					jobId,
					indicator: indicator.enabled ? indicator : null,
					execution: {
						pollIntervalMs: execution.pollIntervalMs,
						maxPollAttempts: execution.maxPollAttempts
					}
				};
			}

			try
			{
				const output = await runPythonProcess({
					pythonExe,
					scriptPath,
					inputObj,
					timeoutSec: execution.timeoutSec,
					cwd: pythonRuntime.scriptsRoot,
					env: pythonProcessEnv,
					onStderrLine: onPythonStderrLine
				});

				await writeLog(loaded.logCfg, 'info', 'Command finished', {
					commandId: command.id,
					mode: execution.mode,
					durationMs: output.durationMs,
					response: loaded.logCfg.includePayload ? maskSensitive(output.result) : {status: output.result?.status || 'ok'}
				});

				return {
					accepted: true,
					mode: 'sync',
					result: output.result,
					meta: loaded.logCfg.extendedDebug ? {
						durationMs: output.durationMs,
						stdout: output.stdout,
						stderr: output.stderr
					} : {
						durationMs: output.durationMs
					}
				};
			}
			catch (err)
			{
				const normalizedErr = normalizeErrorPayload(err);
				await writeLog(loaded.logCfg, 'error', 'Command failed', {
					commandId: command.id,
					errorCategory: normalizedErr.errorCategory || null,
					error: normalizeErrorMessage(normalizedErr),
					details: loaded.logCfg.extendedDebug ? maskSensitive(normalizedErr) : undefined
				});
				throw new Error(normalizeErrorMessage(normalizedErr));
			}
		},

		async updateRuntime(args)
		{
			const loaded = await loadConfigInternal(args?.configPath || null, getAppDataFolder);
			const releaseLock = acquireRuntimeUpdateLock();
			const jobId = randomUUID();
			const createdAt = nowIso();
			runningJobs.set(jobId, {
				status: 'running',
				commandId: 'seafUpdatePlugin',
				createdAt,
				startedAt: createdAt,
				updatedAt: createdAt,
				indicator: {
					enabled: true,
					type: 'percent',
					timeoutMs: 120000,
					allowStop: false
				},
				progress: 0,
				phase: 'starting',
				message: 'Запуск обновления runtime',
				cancelRequested: false,
				finishReason: null,
				timeoutAt: null
			});

			try
			{
				runNativeSshRuntimeUpdate({
					loaded,
					commandId: 'seafUpdatePlugin',
					onProgress: (progressEvent) =>
					{
						const current = runningJobs.get(jobId);
						if (current == null || current.status !== 'running')
						{
							return;
						}

						const next = Object.assign({}, current, {
							updatedAt: nowIso()
						});

						if (Number.isFinite(progressEvent?.progress))
						{
							next.progress = Math.max(0, Math.min(100, Math.round(progressEvent.progress)));
						}
						if (typeof progressEvent?.phase === 'string' && progressEvent.phase.trim().length > 0)
						{
							next.phase = progressEvent.phase.trim();
						}
						if (typeof progressEvent?.message === 'string' && progressEvent.message.trim().length > 0)
						{
							next.message = progressEvent.message.trim();
						}

						runningJobs.set(jobId, next);
					}
				}).then(async (result) =>
				{
					runningJobs.set(jobId, {
						status: 'completed',
						commandId: 'seafUpdatePlugin',
						createdAt,
						startedAt: createdAt,
						updatedAt: nowIso(),
						finishedAt: nowIso(),
						finishReason: 'completed',
						indicator: {
							enabled: true,
							type: 'percent',
							timeoutMs: 120000,
							allowStop: false
						},
						progress: 100,
						phase: 'completed',
						result
					});
					await writeLog(loaded.logCfg, 'info', 'Async native runtime update completed', {
						jobId
					});
					releaseLock();
					invalidateConfigCache(loaded.configPath, getAppDataFolder);
				}).catch(async (err) =>
				{
					const normalizedErr = normalizeErrorPayload(err);
					runningJobs.set(jobId, {
						status: 'failed',
						commandId: 'seafUpdatePlugin',
						createdAt,
						startedAt: createdAt,
						updatedAt: nowIso(),
						finishedAt: nowIso(),
						finishReason: 'failed',
						indicator: {
							enabled: true,
							type: 'percent',
							timeoutMs: 120000,
							allowStop: false
						},
						error: normalizeErrorMessage(normalizedErr),
						errorDetails: normalizedErr
					});
					await writeLog(loaded.logCfg, 'error', 'Async native runtime update failed', {
						jobId,
						error: normalizeErrorMessage(normalizedErr)
					});
					releaseLock();
					invalidateConfigCache(loaded.configPath, getAppDataFolder);
				});
			}
			catch (e)
			{
				releaseLock();
				invalidateConfigCache(loaded.configPath, getAppDataFolder);
				throw e;
			}

			return {
				accepted: true,
				mode: 'async',
				jobId,
				indicator: {
					enabled: true,
					type: 'percent',
					timeoutMs: 120000,
					allowStop: false
				},
				execution: {
					pollIntervalMs: 1000,
					maxPollAttempts: 180
				},
				meta: {
					nativeUpdate: true
				}
			};
		},

		async prepareInteractiveTerminalCommand(args)
		{
			const loaded = await loadConfigInternal(args?.configPath || null, getAppDataFolder);
			const command = findCommand(loaded.config, args?.commandId);

			if (command == null)
			{
				throw new Error(`Unknown command id: ${args?.commandId}`);
			}

			if (!isInteractiveTerminalCommand(command))
			{
				throw new Error(`Command ${command.id} is not configured for interactive terminal mode`);
			}

			await ensurePythonEnvironmentCached({
				loaded,
				source: `interactive:${command.id}`
			});

			const scriptPath = resolveScriptPath(command, loaded.config, loaded.configPath);
			const payload = args?.payload && typeof args.payload === 'object' ? Object.assign({}, args.payload) : {};
			const envConfig = loaded.envConfig || await readEnvConfigInternal(loaded.configPath, loaded.config);
			const pythonRuntime = resolvePythonRuntimeConfig(loaded.config, loaded.configPath, envConfig);
			const resolvedPython = await resolvePythonExecutable({
				loaded,
				pythonCfg: pythonRuntime,
				source: `interactive-run:${command.id}`
			});
			const pythonExe = resolvedPython.pythonExe;
			payload.env = Object.assign({}, envConfig.env);
			payload.arguments = Object.assign({}, payload.arguments || {}, envConfig.env);
			const interactiveEnv = buildInteractiveProcessEnv(
				buildPythonExecutionEnv({}, pythonRuntime.scriptsRoot),
				command,
				loaded,
				envConfig,
				payload
			);
			const cwd = pythonRuntime.scriptsRoot;

			await writeLog(loaded.logCfg, 'info', 'Interactive terminal command prepared', {
				commandId: command.id,
				scriptPath,
				cwd
			});

			return {
				configPath: loaded.configPath,
				commandId: command.id,
				title: command.title || command.id,
				scriptPath,
				cwd,
				pythonExe,
				args: [scriptPath],
				env: interactiveEnv
			};
		},

		async getEnvConfig(args)
		{
			const loaded = await loadConfigInternal(args?.configPath || null, getAppDataFolder);
			const envConfig = loaded.envConfig || await readEnvConfigInternal(loaded.configPath, loaded.config);
			return {
				configPath: loaded.configPath,
				envPath: envConfig.envPath,
				fields: envConfig.fields,
				env: envConfig.env
			};
		},

		async getEventConfig(args)
		{
			const loaded = await loadConfigInternal(args?.configPath || null, getAppDataFolder);
			const eventCfg = await readEventConfigInternal(loaded.configPath, loaded.config);
			return {
				configPath: loaded.configPath,
				eventPath: eventCfg.eventPath,
				events: eventCfg.config
			};
		},

		async getStencilConfig(args)
		{
			const loaded = await loadConfigInternal(args?.configPath || null, getAppDataFolder);
			const stencilCfg = await readStencilConfigInternal(loaded.configPath);
			return {
				configPath: loaded.configPath,
				stencilPath: stencilCfg.stencilPath,
				stencils: stencilCfg.config
			};
		},

		async saveEnvConfig(args)
		{
			const loaded = await loadConfigInternal(args?.configPath || null, getAppDataFolder);
			const saved = await saveEnvConfigInternal(loaded.configPath, loaded.config, args?.env || {});
			invalidateConfigCache(loaded.configPath, getAppDataFolder);
			return {
				configPath: loaded.configPath,
				envPath: saved.envPath,
				env: saved.env
			};
		},

		pollJob(jobId)
		{
			pruneFinishedJobs();
			if (!runningJobs.has(jobId))
			{
				return {status: 'not_found'};
			}
			const raw = runningJobs.get(jobId);
			const out = Object.assign({}, raw);
			delete out.cancel;
			return out;
		},

		cancelJob(jobId)
		{
			pruneFinishedJobs();
			if (!runningJobs.has(jobId))
			{
				return {status: 'not_found'};
			}

			const current = runningJobs.get(jobId);
			if (current.status !== 'running')
			{
				const out = Object.assign({}, current);
				delete out.cancel;
				return out;
			}

			current.cancelRequested = true;
			current.updatedAt = nowIso();
			runningJobs.set(jobId, current);

			if (typeof current.cancel === 'function')
			{
				current.cancel('cancelled');
			}

			const out = Object.assign({}, current, {status: 'cancelling'});
			delete out.cancel;
			return out;
		},

		startManualIndicator(args)
		{
			const indicatorId = randomUUID();
			const now = nowIso();
			const entry = {
				indicatorId,
				status: 'started',
				createdAt: now,
				updatedAt: now,
				params: {
					type: args?.type === 'percent' ? 'percent' : 'spinner',
					label: args?.label || '',
					timeoutMs: Number.isFinite(args?.timeoutMs) && args.timeoutMs > 0 ? Math.round(args.timeoutMs) : null,
					allowStop: args?.allowStop === true
				}
			};
			manualIndicators.set(indicatorId, entry);
			return entry;
		},

		finishManualIndicator(args)
		{
			const indicatorId = args?.indicatorId;
			if (!indicatorId || !manualIndicators.has(indicatorId))
			{
				return {status: 'not_found', indicatorId: indicatorId || null};
			}

			const entry = manualIndicators.get(indicatorId);
			entry.status = 'finished';
			entry.updatedAt = nowIso();
			entry.finishReason = typeof args?.reason === 'string' && args.reason.trim().length > 0 ?
				args.reason.trim() : 'completed';
			manualIndicators.set(indicatorId, entry);
			return entry;
		}
	};
}
