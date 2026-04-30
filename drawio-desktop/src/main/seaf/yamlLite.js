function parseScalar(raw)
{
	if (raw === 'true')
	{
		return true;
	}
	else if (raw === 'false')
	{
		return false;
	}
	else if (raw === 'null' || raw === '~')
	{
		return null;
	}
	else if (/^-?\d+$/.test(raw))
	{
		return parseInt(raw, 10);
	}
	else if (/^-?\d+\.\d+$/.test(raw))
	{
		return parseFloat(raw);
	}
	else if ((raw.startsWith('"') && raw.endsWith('"')) ||
		(raw.startsWith("'") && raw.endsWith("'")))
	{
		return raw.substring(1, raw.length - 1);
	}

	return raw;
}

function stripComment(line)
{
	let quote = null;

	for (let i = 0; i < line.length; i++)
	{
		const ch = line[i];

		if ((ch === '"' || ch === "'") && (i === 0 || line[i - 1] !== '\\'))
		{
			quote = (quote === ch) ? null : (quote == null ? ch : quote);
		}
		else if (ch === '#' && quote == null)
		{
			return line.substring(0, i);
		}
	}

	return line;
}

function preprocess(text)
{
	const lines = text.split(/\r?\n/);
	const out = [];

	for (let i = 0; i < lines.length; i++)
	{
		const cleaned = stripComment(lines[i]).replace(/\t/g, '    ');

		if (cleaned.trim().length === 0)
		{
			continue;
		}

		const indentMatch = /^ */.exec(cleaned);
		const indent = indentMatch ? indentMatch[0].length : 0;
		const content = cleaned.trimEnd();
		out.push({indent, content: content.trim()});
	}

	return out;
}

function parseCollection(lines, startIdx, baseIndent)
{
	let idx = startIdx;
	let mode = null;
	let obj = {};
	let arr = [];

	while (idx < lines.length)
	{
		const line = lines[idx];

		if (line.indent < baseIndent)
		{
			break;
		}

		if (line.indent > baseIndent)
		{
			throw new Error(`Invalid indentation near line: ${line.content}`);
		}

		const isList = line.content.startsWith('- ');

		if (mode == null)
		{
			mode = isList ? 'array' : 'object';
		}
		else if ((mode === 'array' && !isList) || (mode === 'object' && isList))
		{
			throw new Error(`Mixed array/object level near line: ${line.content}`);
		}

		if (mode === 'array')
		{
			const item = line.content.substring(2).trim();

			if (item.length === 0)
			{
				const nested = parseCollection(lines, idx + 1, baseIndent + 2);
				arr.push(nested.value);
				idx = nested.nextIdx;
				continue;
			}
			else
			{
				const colonIdx = item.indexOf(':');

				if (colonIdx > 0)
				{
					const key = item.substring(0, colonIdx).trim();
					const rest = item.substring(colonIdx + 1).trim();
					const seed = {};

					if (rest.length > 0)
					{
						seed[key] = parseScalar(rest);
						const nestedInline = parseCollection(lines, idx + 1, baseIndent + 2);

						if (nestedInline.nextIdx > idx + 1)
						{
							Object.assign(seed, nestedInline.value);
							idx = nestedInline.nextIdx;
						}
						else
						{
							idx++;
						}
					}
					else
					{
						const nested = parseCollection(lines, idx + 1, baseIndent + 2);
						seed[key] = nested.value;
						idx = nested.nextIdx;
					}

					arr.push(seed);
					continue;
				}
				else
				{
					arr.push(parseScalar(item));
					idx++;
					continue;
				}
			}
		}
		else
		{
			const colonIdx = line.content.indexOf(':');

			if (colonIdx < 0)
			{
				throw new Error(`Missing ":" in object line: ${line.content}`);
			}

			const key = line.content.substring(0, colonIdx).trim();
			const rest = line.content.substring(colonIdx + 1).trim();

			if (rest.length > 0)
			{
				obj[key] = parseScalar(rest);
				idx++;
			}
			else
			{
				const nested = parseCollection(lines, idx + 1, baseIndent + 2);
				obj[key] = nested.value;
				idx = nested.nextIdx;
			}
		}
	}

	return {value: mode === 'array' ? arr : obj, nextIdx: idx};
}

export function parseYamlLite(text)
{
	if (typeof text !== 'string')
	{
		throw new Error('YAML input must be string');
	}

	const trimmed = text.trim();

	if (trimmed.length === 0)
	{
		return {};
	}

	// YAML is a superset of JSON. If content is JSON, parse directly.
	if (trimmed.startsWith('{') || trimmed.startsWith('['))
	{
		return JSON.parse(trimmed);
	}

	const lines = preprocess(text);

	if (lines.length === 0)
	{
		return {};
	}

	const parsed = parseCollection(lines, 0, lines[0].indent);
	return parsed.value;
}
