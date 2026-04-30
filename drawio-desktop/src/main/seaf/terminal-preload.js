import { contextBridge, ipcRenderer } from 'electron';

let reqId = 1;
const reqInfo = {};

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
		reqInfo[msg.reqId] = {callback: callback, error: error};
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
