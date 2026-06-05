/**
 * SEAF minimal plugin for draw.io desktop bootstrap.
 * Runtime script version: 0.0.7
 */
Draw.loadPlugin(function(ui)
{
	var state = {
		configPath: null,
		runtimeVersion: '0.0.7',
		updateInProgress: false,
		actionRegistered: false,
		menuRegistered: false
	};
	async function writeClientLog(level, message, data)
	{
		try
		{
			await requestAsync({
				action: 'writeSeafPluginLog',
				configPath: state.configPath,
				level: level || 'info',
				message: message || 'minimal plugin log',
				data: data || null
			});
		}
		catch (e)
		{
			// do not break UX if logger is unavailable
		}
	}


	function requestAsync(msg)
	{
		if (typeof electron === 'undefined' || electron == null || typeof electron.request !== 'function')
		{
			return Promise.reject(new Error('Electron IPC bridge is unavailable'));
		}

		return new Promise(function(resolve, reject)
		{
			electron.request(msg, function(data)
			{
				resolve(data);
			}, function(errMsg, errObj)
			{
				reject(errObj || new Error(errMsg));
			});
		});
	}

	async function detectRuntimeVersion()
	{
		if (!state.configPath || typeof state.configPath !== 'string')
		{
			return state.runtimeVersion;
		}

		try
		{
			var runtimeVersionPath = state.configPath.replace(/[\\\/]conf[\\\/]plugin\.yaml$/i, '/runtime/version.json');
			var raw = await requestAsync({
				action: 'readFile',
				filename: runtimeVersionPath,
				encoding: 'utf8'
			});
			var parsed = JSON.parse(raw);
			if (parsed && typeof parsed.version === 'string' && parsed.version.trim().length > 0)
			{
				return parsed.version.trim();
			}
		}
		catch (e)
		{
			// keep default
		}

		return state.runtimeVersion;
	}

	function ensureSeafMenu()
	{
		if (ui.menus.get('seaf') != null)
		{
			return;
		}

		ui.menus.put('seaf', new Menu(function(){}));
		mxResources.parse('seaf=SEAF');
		if (Array.isArray(ui.menus.defaultMenuItems))
		{
			var items = ui.menus.defaultMenuItems.slice();
			if (mxUtils.indexOf(items, 'seaf') < 0)
			{
				var helpIdx = mxUtils.indexOf(items, 'help');
				if (helpIdx >= 0)
				{
					items.splice(helpIdx, 0, 'seaf');
				}
				else
				{
					items.push('seaf');
				}
				ui.menus.defaultMenuItems = items;
			}
		}
	}

	function createUpdateIndicator()
	{
		var overlay = document.createElement('div');
		overlay.style.position = 'fixed';
		overlay.style.left = '16px';
		overlay.style.bottom = '16px';
		overlay.style.minWidth = '300px';
		overlay.style.padding = '10px 12px';
		overlay.style.background = '#ffffff';
		overlay.style.border = '1px solid #d0d0d0';
		overlay.style.borderRadius = '6px';
		overlay.style.boxShadow = '0 2px 8px rgba(0,0,0,0.2)';
		overlay.style.zIndex = '99999';
		overlay.style.fontFamily = 'Arial, sans-serif';
		overlay.style.fontSize = '12px';

		var title = document.createElement('div');
		title.style.fontWeight = 'bold';
		title.style.marginBottom = '6px';
		title.textContent = 'Обновление плагина SEAF';
		overlay.appendChild(title);

		var statusLine = document.createElement('div');
		statusLine.textContent = 'Подготовка...';
		statusLine.style.marginBottom = '8px';
		overlay.appendChild(statusLine);

		var progressWrap = document.createElement('div');
		progressWrap.style.height = '6px';
		progressWrap.style.background = '#efefef';
		progressWrap.style.borderRadius = '3px';
		progressWrap.style.overflow = 'hidden';
		var progressFill = document.createElement('div');
		progressFill.style.height = '100%';
		progressFill.style.width = '0%';
		progressFill.style.background = '#4c8bf5';
		progressWrap.appendChild(progressFill);
		overlay.appendChild(progressWrap);

		document.body.appendChild(overlay);

		return {
			update: function(message, progress)
			{
				if (typeof message === 'string' && message.trim().length > 0)
				{
					statusLine.textContent = message.trim();
				}
				if (Number.isFinite(progress))
				{
					progressFill.style.width = Math.max(0, Math.min(100, Math.round(progress))) + '%';
				}
			},
			stop: function()
			{
				if (overlay.parentNode != null)
				{
					overlay.parentNode.removeChild(overlay);
				}
			}
		};
	}

	function buildRestartRequiredMessage(result)
	{
		var version = null;
		if (result && result.payload && typeof result.payload.version === 'string' && result.payload.version.trim().length > 0)
		{
			version = result.payload.version.trim();
		}
		var line1 = version ? ('Плагин обновлен до версии ' + version) : 'Плагин успешно обновлен';
		return line1 + '\nИзменения вступят в силу после перезапуска приложения draw.io';
	}

	function getUpdateUiMessage(result)
	{
		var payload = (result && typeof result.payload === 'object' && result.payload != null) ? result.payload : {};
		var status = (typeof payload.status === 'string' && payload.status.trim().length > 0) ?
			payload.status.trim() : (typeof result.status === 'string' ? result.status.trim() : '');
		if (status === 'already_up_to_date')
		{
			if (typeof result.message === 'string' && result.message.trim().length > 0)
			{
				return result.message.trim();
			}
			if (typeof payload.version === 'string' && payload.version.trim().length > 0)
			{
				return 'Установлена актуальная версия ' + payload.version.trim();
			}
			return 'Установлена актуальная версия плагина';
		}
		return buildRestartRequiredMessage(result);
	}

	async function pollUpdateJob(jobId, executionCfg)
	{
		var maxAttempts = Math.max(1, (executionCfg && executionCfg.maxPollAttempts) || 180);
		var intervalMs = Math.max(200, (executionCfg && executionCfg.pollIntervalMs) || 1000);
		var indicator = createUpdateIndicator();

		try
		{
			for (var i = 0; i < maxAttempts; i++)
			{
				var status = await requestAsync({
					action: 'pollSeafPluginJob',
					jobId: jobId
				});
				indicator.update(status.message || status.phase || 'Выполняется...', status.progress);

				if (status.status === 'completed')
				{
					var result = status.result || {};
					indicator.update('Обновление завершено', 100);
					await new Promise(function(resolve)
					{
						window.setTimeout(resolve, 300);
					});
					indicator.stop();
					mxUtils.alert(getUpdateUiMessage(result));
					return;
				}
				if (status.status === 'failed' || status.status === 'timed_out' || status.status === 'cancelled')
				{
					var msg = status.status === 'cancelled' ? 'Операция остановлена' : (status.error || 'unknown error');
					throw new Error(msg);
				}

				await new Promise(function(resolve)
				{
					window.setTimeout(resolve, intervalMs);
				});
			}
		}
		finally
		{
			if (indicator != null)
			{
				indicator.stop();
			}
		}

		throw new Error('async timeout');
	}

	async function runSystemUpdate()
	{
		if (state.updateInProgress === true)
		{
			mxUtils.alert('Обновление уже выполняется. Подождите завершения.');
			return;
		}

		state.updateInProgress = true;
		await writeClientLog('info', 'Minimal update button clicked', {
			configPath: state.configPath
		});

		try
		{
			var response = await requestAsync({
				action: 'updateSeafPluginRuntime',
				configPath: state.configPath
			});
			if (response && response.mode === 'async' && response.jobId)
			{
				await pollUpdateJob(response.jobId, response.execution || null);
				return;
			}

			var result = response && response.result ? response.result : {};
			if (result && result.status !== 'error')
			{
				mxUtils.alert(getUpdateUiMessage(result));
			}
			else if (result && typeof result.message === 'string' && result.message.trim().length > 0)
			{
				mxUtils.alert(result.message.trim());
			}
		}
		catch (e)
		{
			await writeClientLog('error', 'Minimal update failed', {
				error: e && e.message ? e.message : String(e)
			});
			mxUtils.alert('seafUpdatePlugin: ' + e.message);
		}
		finally
		{
			state.updateInProgress = false;
		}
	}

	function registerSystemUpdateAction()
	{
		if (state.actionRegistered)
		{
			return;
		}
		mxResources.parse('seafSystemUpdatePlugin=Обновить плагин');
		if (ui.actions.get('seafSystemUpdatePlugin') == null)
		{
			var action = ui.actions.addAction('seafSystemUpdatePlugin', function()
			{
				runSystemUpdate();
			});
			if (action != null && typeof action.setEnabled === 'function')
			{
				action.setEnabled(true);
			}
		}
		else
		{
			var existing = ui.actions.get('seafSystemUpdatePlugin');
			if (existing != null && typeof existing.setEnabled === 'function')
			{
				existing.setEnabled(true);
			}
		}
		state.actionRegistered = true;
	}

	function registerSeafMenu()
	{
		if (state.menuRegistered)
		{
			return;
		}
		ensureSeafMenu();
		var menu = ui.menus.get('seaf');
		if (menu == null)
		{
			return;
		}

		var oldFunct = menu.funct;
		menu.funct = function(menuObj, parent)
		{
			oldFunct.apply(this, arguments);
			ui.menus.addMenuItems(menuObj, ['-', 'seafSystemUpdatePlugin'], parent);
			menuObj.addSeparator(parent);
			menuObj.addItem('SEAF Runtime v' + (state.runtimeVersion || '0.0.5'), null, null, parent, null, false);
		};
		state.menuRegistered = true;
	}

	async function init()
	{
		try
		{
			var loaded = await requestAsync({
				action: 'getSeafPluginConfig',
				configPath: (window.SEAF_PLUGIN_CONFIG_PATH || '')
			});
			state.configPath = loaded && loaded.configPath ? loaded.configPath : null;
			state.runtimeVersion = await detectRuntimeVersion();
		}
		catch (e)
		{
			// minimal plugin still should show update action
		}

		registerSystemUpdateAction();
		registerSeafMenu();
	}

	init();
});
