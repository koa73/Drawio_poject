/**
 * SEAF standalone demo plugin.
 * Uses local HTTP bridge (python) for config + command execution.
 */
Draw.loadPlugin(function(ui)
{
	var bridgeUrl = window.SEAF_BRIDGE_URL || localStorage.getItem('seafBridgeUrl') || 'http://127.0.0.1:8765';
	var state = {
		config: null,
		commands: []
	};

	function notify(msg)
	{
		mxUtils.alert(msg);
	}

	async function requestJson(url, options)
	{
		var resp = await fetch(url, options || {});

		if (!resp.ok)
		{
			throw new Error('HTTP ' + resp.status + ' at ' + url);
		}

		return resp.json();
	}

	function getSelectionPayload()
	{
		var graph = ui.editor.graph;
		var cells = graph.getSelectionCells();
		var out = [];

		for (var i = 0; i < cells.length; i++)
		{
			var c = cells[i];
			out.push({
				id: c.id,
				isVertex: graph.model.isVertex(c),
				isEdge: graph.model.isEdge(c),
				label: graph.convertValueToString(c)
			});
		}

		return out;
	}

	function executeUiCommand(cmd)
	{
		var graph = ui.editor.graph;
		var args = cmd.args || {};

		switch (cmd.name)
		{
		case 'reloadDocument':
			window.location.reload();
			break;
		case 'refreshGraph':
			graph.refresh();
			break;
		case 'selectCells':
			if (Array.isArray(args.cellIds))
			{
				var selected = [];

				for (var i = 0; i < args.cellIds.length; i++)
				{
					var cell = graph.model.getCell(args.cellIds[i]);

					if (cell != null)
					{
						selected.push(cell);
					}
				}

				if (selected.length > 0)
				{
					graph.setSelectionCells(selected);
				}
			}
			break;
		case 'showMessage':
			notify(args.text || 'SEAF message');
			break;
		default:
			console.warn('Unknown SEAF command:', cmd.name);
			break;
		}
	}

	function executeCommands(result)
	{
		if (result == null || !Array.isArray(result.commands))
		{
			return;
		}

		for (var i = 0; i < result.commands.length; i++)
		{
			executeUiCommand(result.commands[i]);
		}
	}

	async function pollJob(jobId, title)
	{
		for (var i = 0; i < 120; i++)
		{
			var status = await requestJson(bridgeUrl + '/job/' + encodeURIComponent(jobId));

			if (status.status === 'completed')
			{
				executeCommands(status.result || {});
				notify((status.result && status.result.message) || ('Command "' + title + '" completed'));
				return;
			}
			else if (status.status === 'failed')
			{
				notify('Command "' + title + '" failed: ' + (status.error || 'unknown error'));
				return;
			}

			await new Promise(function(resolve)
			{
				window.setTimeout(resolve, 1000);
			});
		}

		notify('Timeout while waiting async command result');
	}

	async function invokeCommand(cmd, source)
	{
		try
		{
			var payload = {
				commandId: cmd.id,
				source: source,
				timestamp: new Date().toISOString(),
				selection: getSelectionPayload()
			};
			var runResp = await requestJson(bridgeUrl + '/run', {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({
					commandId: cmd.id,
					payload: payload
				})
			});

			if (runResp.mode === 'async' && runResp.jobId)
			{
				notify('Command "' + cmd.title + '" started in background');
				pollJob(runResp.jobId, cmd.title);
				return;
			}

			var result = runResp.result || {};
			executeCommands(result);
			notify(result.message || ('Command "' + cmd.title + '" completed'));
		}
		catch (e)
		{
			notify('SEAF command error: ' + e.message);
		}
	}

	function registerActions()
	{
		for (var i = 0; i < state.commands.length; i++)
		{
			(function(cmd)
			{
				ui.actions.addAction(cmd.id, function()
				{
					invokeCommand(cmd, 'menu');
				});
			})(state.commands[i]);
		}
	}

	function ensureMenuSection(sectionId, title)
	{
		if (ui.menus.get(sectionId) != null)
		{
			return;
		}

		ui.menus.put(sectionId, new Menu(function(){}));
		mxResources.parse(sectionId + '=' + (title || sectionId));
	}

	function registerMainMenu()
	{
		var grouped = {};

		for (var i = 0; i < state.commands.length; i++)
		{
			var cmd = state.commands[i];
			var mainCfg = (cmd.menu && cmd.menu.main) ? cmd.menu.main : {};

			if (mainCfg.enabled === false)
			{
				continue;
			}

			var section = mainCfg.section || 'extras';
			var sectionTitle = mainCfg.sectionTitle || section;
			ensureMenuSection(section, sectionTitle);

			if (grouped[section] == null)
			{
				grouped[section] = [];
			}

			grouped[section].push(cmd.id);
		}

		for (var menuId in grouped)
		{
			if (!Object.prototype.hasOwnProperty.call(grouped, menuId))
			{
				continue;
			}

			(function(sectionId, ids)
			{
				var menu = ui.menus.get(sectionId);
				var oldFunct = menu.funct;

				menu.funct = function(menuObj, parent)
				{
					oldFunct.apply(this, arguments);
					ui.menus.addMenuItems(menuObj, ['-'].concat(ids), parent);
				};
			})(menuId, grouped[menuId]);
		}
	}

	function contextMatches(cmd)
	{
		var graph = ui.editor.graph;
		var selection = graph.getSelectionCells();
		var first = graph.getSelectionCell();
		var ctx = (cmd.menu && cmd.menu.context) ? cmd.menu.context : {};
		var target = ctx.target || 'any';

		if (ctx.enabled === false)
		{
			return false;
		}

		if (target === 'selection_non_empty')
		{
			return selection.length > 0;
		}
		else if (target === 'selection_single')
		{
			return selection.length === 1;
		}
		else if (target === 'vertex')
		{
			return first != null && graph.model.isVertex(first);
		}
		else if (target === 'edge')
		{
			return first != null && graph.model.isEdge(first);
		}

		return true;
	}

	function registerContextMenu()
	{
		var oldCreatePopupMenu = ui.menus.createPopupMenu;

		ui.menus.createPopupMenu = function(menu, cell, evt)
		{
			oldCreatePopupMenu.apply(this, arguments);
			var inserted = false;

			for (var i = 0; i < state.commands.length; i++)
			{
				var cmd = state.commands[i];

				if (contextMatches(cmd))
				{
					if (!inserted)
					{
						this.addMenuItems(menu, ['-'], null, evt);
						inserted = true;
					}

					this.addMenuItems(menu, [cmd.id], null, evt);
				}
			}
		};
	}

	async function init()
	{
		try
		{
			var configResp = await requestJson(bridgeUrl + '/config');
			state.config = configResp.config || {};
			state.commands = state.config.commands || [];
			registerActions();
			registerMainMenu();
			registerContextMenu();
			console.log('SEAF standalone plugin initialized with', state.commands.length, 'commands');
		}
		catch (e)
		{
			notify('SEAF plugin init failed: ' + e.message + '\nBridge: ' + bridgeUrl);
		}
	}

	init();
});
