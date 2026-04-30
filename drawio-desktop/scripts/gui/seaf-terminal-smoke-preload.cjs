const { contextBridge, ipcRenderer } = require('electron');

let reqId = 1;
const reqInfo = {};

function MockTerminal(options)
{
	this.options = options || {};
	this.cols = 80;
	this.rows = 24;
	this._onData = null;
}

MockTerminal.prototype.loadAddon = function(addon)
{
	if (addon != null)
	{
		addon._terminal = this;
	}
};

MockTerminal.prototype.open = function(host)
{
	this._host = host;
};

MockTerminal.prototype.focus = function()
{
	// no-op in smoke mode
};

MockTerminal.prototype.write = function(text)
{
	if (this._host && typeof text === 'string')
	{
		this._host.textContent = (this._host.textContent || '') + text;
	}
};

MockTerminal.prototype.onData = function(callback)
{
	this._onData = callback;
};

function MockFitAddon()
{
}

MockFitAddon.prototype.fit = function()
{
	if (this._terminal)
	{
		this._terminal.cols = 100;
		this._terminal.rows = 30;
	}
};

ipcRenderer.on('mainResp', (event, resp) =>
{
	const callbacks = reqInfo[resp.reqId];

	if (!callbacks)
	{
		return;
	}

	if (resp.error)
	{
		callbacks.error(resp.msg, resp.e);
	}
	else
	{
		callbacks.callback(resp.data);
	}

	delete reqInfo[resp.reqId];
});

contextBridge.exposeInMainWorld('electron', {
	request: (msg, callback, error) =>
	{
		msg.reqId = reqId++;
		reqInfo[msg.reqId] = {callback: callback || function(){}, error: error || function(){}};
		ipcRenderer.send('rendererReq', msg);
	},
	registerMsgListener: function(action, callback)
	{
		ipcRenderer.on(action, function(event, args)
		{
			callback(args);
		});
	}
});

contextBridge.exposeInMainWorld('seafTerminal', {
	Terminal: MockTerminal,
	FitAddon: MockFitAddon,
	xtermCssHref: ''
});
