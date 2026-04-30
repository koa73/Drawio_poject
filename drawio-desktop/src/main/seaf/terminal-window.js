(function()
{
	var params = new URLSearchParams(window.location.search);
	var sessionId = params.get('sessionId');
	var xtermJsUrl = params.get('xtermJsUrl');
	var fitAddonJsUrl = params.get('fitAddonJsUrl');
	var xtermCssUrl = params.get('xtermCssUrl');
	var statusEl = document.getElementById('terminalStatus');
	var terminalHost = document.getElementById('terminal');
	var processExited = false;
	var resizeTimer = null;
	var fitAddon = null;
	var term = null;
	var terminalCtor = null;
	var fitAddonCtor = null;

	function logLocal(message, payload)
	{
		try
		{
			console.log('[SEAF terminal]', message, payload || {});
		}
		catch (ignored)
		{
			// ignore local console errors
		}
	}

	function reportRendererEvent(level, eventName, details)
	{
		if (!sessionId || typeof electron === 'undefined' || electron == null || typeof electron.request !== 'function')
		{
			return;
		}

		electron.request({
			action: 'reportSeafInteractiveTerminalRendererEvent',
			sessionId: sessionId,
			level: level || 'info',
			event: eventName || 'unknown',
			details: details || {}
		}, function(){}, function(){});
	}

	function setStatus(text)
	{
		statusEl.textContent = text;
	}

	function setFatalStatus(text)
	{
		setStatus(text);
		terminalHost.style.color = '#ff8080';
		terminalHost.style.whiteSpace = 'pre-wrap';
		terminalHost.textContent = text;
	}

	function ensureXtermCssLoaded()
	{
		if (!xtermCssUrl)
		{
			return false;
		}

		var link = document.createElement('link');
		link.rel = 'stylesheet';
		link.href = xtermCssUrl;
		document.head.appendChild(link);
		return true;
	}

	function loadScript(scriptUrl)
	{
		return new Promise(function(resolve, reject)
		{
			if (!scriptUrl || scriptUrl.length === 0)
			{
				reject(new Error('Missing script URL'));
				return;
			}

			var script = document.createElement('script');
			script.src = scriptUrl;
			script.onload = function()
			{
				resolve();
			};
			script.onerror = function()
			{
				reject(new Error('Failed to load script: ' + scriptUrl));
			};
			document.head.appendChild(script);
		});
	}

	function resolveTerminalCtor()
	{
		if (typeof window.Terminal === 'function')
		{
			return window.Terminal;
		}

		if (window.Xterm && typeof window.Xterm.Terminal === 'function')
		{
			return window.Xterm.Terminal;
		}

		return null;
	}

	function resolveFitAddonCtor()
	{
		if (window.FitAddon && typeof window.FitAddon.FitAddon === 'function')
		{
			return window.FitAddon.FitAddon;
		}

		if (typeof window.FitAddon === 'function')
		{
			return window.FitAddon;
		}

		return null;
	}

	async function ensureTerminalLibrariesLoaded()
	{
		await loadScript(xtermJsUrl);
		await loadScript(fitAddonJsUrl);

		terminalCtor = resolveTerminalCtor();
		fitAddonCtor = resolveFitAddonCtor();

		if (typeof terminalCtor !== 'function' || typeof fitAddonCtor !== 'function')
		{
			throw new Error('Terminal libraries are unavailable in renderer context');
		}
	}

	function writeTerminal(text)
	{
		if (term != null && typeof text === 'string' && text.length > 0)
		{
			term.write(text);
		}
	}

	function notifyResize()
	{
		if (term == null || fitAddon == null || !sessionId)
		{
			return;
		}

		fitAddon.fit();
		electron.request({
			action: 'resizeSeafInteractiveTerminal',
			sessionId: sessionId,
			cols: term.cols,
			rows: term.rows
		}, function(){}, function(){});
	}

	function scheduleResize()
	{
		window.clearTimeout(resizeTimer);
		resizeTimer = window.setTimeout(notifyResize, 30);
	}

	async function bootstrapTerminal()
	{
		if (!sessionId)
		{
			setStatus('Missing interactive session id');
			return;
		}

		try
		{
			await ensureTerminalLibrariesLoaded();
			ensureXtermCssLoaded();
			term = new terminalCtor({
				convertEol: true,
				cursorBlink: true,
				scrollback: 5000,
				fontSize: 14,
				theme: {
					background: '#111111'
				}
			});
			fitAddon = new fitAddonCtor();
			term.loadAddon(fitAddon);
			term.open(terminalHost);
			fitAddon.fit();
			term.focus();
			logLocal('terminal bootstrap complete', {sessionId: sessionId});
			reportRendererEvent('info', 'bootstrap_complete', {});
		}
		catch (e)
		{
			logLocal('terminal bootstrap failed', {sessionId: sessionId, error: e.message});
			reportRendererEvent('error', 'bootstrap_failed', {
				error: e && e.message ? e.message : String(e),
				stack: e && e.stack ? e.stack : null,
				xtermJsUrl: xtermJsUrl || '',
				fitAddonJsUrl: fitAddonJsUrl || '',
				xtermCssUrl: xtermCssUrl || ''
			});
			setFatalStatus('Terminal bootstrap failed: ' + e.message);
			return;
		}

		electron.registerMsgListener('seafInteractiveTerminalData', function(payload)
		{
			if (!payload || payload.sessionId !== sessionId)
			{
				return;
			}

			writeTerminal(payload.data || '');
		});

		electron.registerMsgListener('seafInteractiveTerminalExit', function(payload)
		{
			if (!payload || payload.sessionId !== sessionId)
			{
				return;
			}

			processExited = true;
			term.options.disableStdin = true;
			writeTerminal('\r\n\x1b[1;32m[Interactive process completed. Close this window to return to draw.io.]\x1b[0m\r\n');
			setStatus('Process completed. Close this window to return to draw.io.');
			logLocal('terminal process exit event received', payload);
		});

		term.onData(function(data)
		{
			if (processExited)
			{
				return;
			}

			electron.request({
				action: 'writeSeafInteractiveTerminalInput',
				sessionId: sessionId,
				data: data
			}, function(){}, function(errMsg, errObj)
			{
				logLocal('failed to forward input', {errMsg: errMsg, errObj: errObj});
			});
		});

		window.addEventListener('resize', scheduleResize);

		electron.request({
			action: 'getSeafInteractiveTerminalSnapshot',
			sessionId: sessionId
		}, function(snapshot)
		{
			if (!snapshot || snapshot.status === 'not_found')
			{
				setStatus('Interactive session was not found.');
				logLocal('snapshot indicates not_found', {sessionId: sessionId});
				return;
			}

			if (snapshot.buffer)
			{
				writeTerminal(snapshot.buffer);
			}

			processExited = snapshot.processExited === true;
			if (processExited)
			{
				term.options.disableStdin = true;
				setStatus('Process completed. Close this window to return to draw.io.');
			}
			else
			{
				setStatus('Interactive session is running.');
			}
			logLocal('snapshot loaded', {
				status: snapshot.status,
				processExited: snapshot.processExited === true,
				bufferLength: snapshot.buffer ? snapshot.buffer.length : 0
			});

			window.setTimeout(function()
			{
				scheduleResize();
				term.focus();
			}, 0);
		}, function(err)
		{
			setStatus('Failed to initialize terminal: ' + (err && err.message ? err.message : err));
			logLocal('snapshot request failed', {error: err});
			reportRendererEvent('error', 'snapshot_failed', {
				error: err && err.message ? err.message : String(err)
			});
		});
	}

	bootstrapTerminal();
})();
