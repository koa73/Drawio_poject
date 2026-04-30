const DEFAULT_ASYNC_OUTPUT_TAIL_LIMIT = 8192;

export function trimTextTail(value, maxLength = DEFAULT_ASYNC_OUTPUT_TAIL_LIMIT)
{
	if (typeof value !== 'string')
	{
		return '';
	}
	if (value.length <= maxLength)
	{
		return value;
	}
	return value.slice(value.length - maxLength);
}

export function getReducedAsyncMeta(output)
{
	return {
		durationMs: output.durationMs,
		stdoutTail: trimTextTail(output.stdout),
		stderrTail: trimTextTail(output.stderr),
		stdoutSize: typeof output.stdout === 'string' ? output.stdout.length : 0,
		stderrSize: typeof output.stderr === 'string' ? output.stderr.length : 0
	};
}

export function getReducedErrorDetails(errorObj)
{
	if (errorObj == null || typeof errorObj !== 'object')
	{
		return errorObj;
	}

	const reduced = Object.assign({}, errorObj);
	if (typeof reduced.stdout === 'string')
	{
		reduced.stdoutSize = reduced.stdout.length;
		reduced.stdoutTail = trimTextTail(reduced.stdout);
		delete reduced.stdout;
	}
	if (typeof reduced.stderr === 'string')
	{
		reduced.stderrSize = reduced.stderr.length;
		reduced.stderrTail = trimTextTail(reduced.stderr);
		delete reduced.stderr;
	}

	return reduced;
}
