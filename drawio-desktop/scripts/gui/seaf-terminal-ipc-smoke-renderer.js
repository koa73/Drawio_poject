(function()
{
	var params = new URLSearchParams(window.location.search);
	var sessionId = params.get('sessionId');
	var stateEl = document.getElementById('state');

	window.__smokeState = {
		sessionId: sessionId,
		snapshotLoaded: false,
		resizeAck: false,
		inputAck: false,
		dataReceived: false,
		exitReceived: false,
		lastData: '',
		lastError: ''
	};

	function setState(text)
	{
		stateEl.textContent = text;
	}

	function markError(message)
	{
		window.__smokeState.lastError = message;
		setState('error:' + message);
	}

	if (!window.electron || !sessionId)
	{
		markError('missing-electron-or-session');
		return;
	}

	window.electron.registerMsgListener('seafInteractiveTerminalData', function(payload)
	{
		if (!payload || payload.sessionId !== sessionId)
		{
			return;
		}

		window.__smokeState.dataReceived = true;
		window.__smokeState.lastData = String(payload.data || '');
		setState('data-received');
	});

	window.electron.registerMsgListener('seafInteractiveTerminalExit', function(payload)
	{
		if (!payload || payload.sessionId !== sessionId)
		{
			return;
		}

		window.__smokeState.exitReceived = true;
		setState('exit-received');
	});

	window.electron.request({
		action: 'getSeafInteractiveTerminalSnapshot',
		sessionId: sessionId
	}, function(resp)
	{
		window.__smokeState.snapshotLoaded = !!resp && resp.status === 'running';
		setState('snapshot-loaded');
	}, function(errMsg)
	{
		markError('snapshot:' + errMsg);
	});

	window.electron.request({
		action: 'resizeSeafInteractiveTerminal',
		sessionId: sessionId,
		cols: 100,
		rows: 30
	}, function()
	{
		window.__smokeState.resizeAck = true;
	}, function(errMsg)
	{
		markError('resize:' + errMsg);
	});

	window.electron.request({
		action: 'writeSeafInteractiveTerminalInput',
		sessionId: sessionId,
		data: 'help\n'
	}, function()
	{
		window.__smokeState.inputAck = true;
	}, function(errMsg)
	{
		markError('input:' + errMsg);
	});
})();
