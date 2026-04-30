const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

const sessionId = 'smoke-session';
const rootDir = path.resolve(__dirname, '..', '..');
const terminalHtmlPath = path.join(rootDir, 'scripts', 'gui', 'seaf-terminal-ipc-smoke.html');
const preloadPath = path.join(rootDir, 'scripts', 'gui', 'seaf-terminal-smoke-preload.cjs');

let win = null;
let failed = false;
let timeoutId = null;
let lastResize = null;

function fail(message)
{
	if (failed)
	{
		return;
	}

	failed = true;
	console.error(`[SEAF GUI smoke] FAIL: ${message}`);
	clearTimeout(timeoutId);
	app.exit(1);
}

function pass()
{
	if (failed)
	{
		return;
	}

	console.log('[SEAF GUI smoke] PASS');
	clearTimeout(timeoutId);
	app.exit(0);
}

function respond(event, reqId, data, error)
{
	event.reply('mainResp', {
		reqId,
		error: error != null,
		msg: error ? String(error.message || error) : null,
		e: error ? {message: String(error.message || error)} : null,
		data: data || null
	});
}

async function waitFor(conditionScript, timeoutMs)
{
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline)
	{
		if (win == null || win.isDestroyed())
		{
			throw new Error('Window closed while waiting for status');
		}

		const conditionPassed = await win.webContents.executeJavaScript(conditionScript, true);
		if (conditionPassed === true)
		{
			return;
		}

		await new Promise((resolve) => setTimeout(resolve, 100));
	}

	throw new Error(`Timed out waiting for condition: ${conditionScript}`);
}

async function readDebugState()
{
	if (win == null || win.isDestroyed())
	{
		return {status: 'window-closed', terminalText: ''};
	}

	return win.webContents.executeJavaScript(
		"window.__smokeState || null",
		true
	);
}

ipcMain.on('rendererReq', (event, msg) =>
{
	try
	{
		switch (msg.action)
		{
			case 'getSeafInteractiveTerminalSnapshot':
				respond(event, msg.reqId, {
					status: 'running',
					sessionId,
					buffer: '[smoke] snapshot data delivered',
					processExited: false
				});
				break;
			case 'writeSeafInteractiveTerminalInput':
				respond(event, msg.reqId, {ok: true});
				break;
			case 'resizeSeafInteractiveTerminal':
				lastResize = {cols: msg.cols, rows: msg.rows};
				respond(event, msg.reqId, {ok: true});
				break;
			default:
				throw new Error(`Unknown action: ${msg.action}`);
		}
	}
	catch (e)
	{
		respond(event, msg.reqId, null, e);
	}
});

app.whenReady().then(async () =>
{
	timeoutId = setTimeout(() =>
	{
		fail('Global timeout exceeded');
	}, 30000);

	win = new BrowserWindow({
		show: false,
		width: 900,
		height: 600,
		webPreferences: {
			preload: preloadPath,
			contextIsolation: true,
			sandbox: false,
			spellcheck: false
		}
	});

	win.webContents.on('did-fail-load', (evt, errorCode, errorDescription) =>
	{
		fail(`did-fail-load ${errorCode}: ${errorDescription}`);
	});
	win.webContents.on('preload-error', (evt, preloadPath, error) =>
	{
		fail(`preload-error in ${preloadPath}: ${error && error.message ? error.message : error}`);
	});
	win.webContents.on('console-message', (evt, level, message) =>
	{
		if (message && message.indexOf('[SEAF GUI smoke]') >= 0)
		{
			console.error(`[SEAF GUI smoke] renderer level=${level} ${message}`);
		}
	});

	win.webContents.on('render-process-gone', (evt, details) =>
	{
		fail(`render-process-gone: ${details && details.reason ? details.reason : 'unknown'}`);
	});

	try
	{
		await win.loadFile(terminalHtmlPath, {
			query: {sessionId}
		});

		await waitFor(
			"(window.__smokeState && window.__smokeState.snapshotLoaded === true && window.__smokeState.resizeAck === true && window.__smokeState.inputAck === true)",
			10000
		);

		win.webContents.send('seafInteractiveTerminalData', {
			sessionId,
			data: '[smoke] stream chunk'
		});

		win.webContents.send('seafInteractiveTerminalExit', {
			sessionId,
			exitCode: 0
		});

		await waitFor(
			"(window.__smokeState && window.__smokeState.dataReceived === true && window.__smokeState.exitReceived === true)",
			10000
		);

		if (!lastResize || !Number.isFinite(lastResize.cols) || !Number.isFinite(lastResize.rows))
		{
			throw new Error('Renderer did not send terminal resize data');
		}

		pass();
	}
	catch (e)
	{
		try
		{
			const debugState = await readDebugState();
			fail(`${e.message || String(e)} | status=${debugState.status || ''} | terminal=${debugState.terminalText || ''}`);
		}
		catch (ignored)
		{
			fail(e.message || String(e));
		}
	}
}).catch((e) =>
{
	fail(e.message || String(e));
});

app.on('window-all-closed', () =>
{
	if (!failed)
	{
		app.quit();
	}
});
