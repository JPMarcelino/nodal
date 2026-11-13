import json, re, sys
cat = json.load(open(sys.argv[1]))
ver = json.load(open(sys.argv[2]))['version']

def ptype(desc):
    t, _, note = desc.partition(' — ')
    t = t.strip()
    s = {}
    if '|' in t:
        opts = [o.strip() for o in t.split('|')]
        if all(re.fullmatch(r'-?\d+(\.\d+)?', o) for o in opts):
            s = {'type': 'number', 'enum': [float(o) if '.' in o else int(o) for o in opts]}
        elif all(re.fullmatch(r'[\w.-]+', o) and o not in ('string','number','boolean','object') for o in opts):
            s = {'type': 'string', 'enum': opts}
        else:
            s = {}
    elif t in ('string', 'number', 'boolean', 'object', 'integer'):
        s = {'type': t}
    elif t.endswith('[]'):
        inner = t[:-2]
        s = {'type': 'array', 'items': {'type': inner} if inner in ('string','number','boolean','object') else {}}
    else:
        s = {}
    d = desc if not s else note.strip()
    if d: s['description'] = d
    elif not s: s['description'] = desc
    return s

schemas, examples, refs, names = {}, {}, [], []
for m in cat['methods']:
    name = m['name']; names.append(name)
    props, req = {}, []
    for k, v in (m.get('params') or {}).items():
        opt = k.endswith('?'); key = k.rstrip('?')
        props[key] = ptype(v) if isinstance(v, str) else {'description': json.dumps(v)}
        if not opt: req.append(key)
    params = {'type': 'object', 'properties': props, 'additionalProperties': True}
    if req: params['required'] = req
    sid = 'Call_' + name.replace('.', '_')
    schemas[sid] = {
        'type': 'object', 'title': name,
        'description': m['summary'] + (' (Changes the circuit; undoable with history.undo.)' if m.get('mutates') else ''),
        'required': ['method'],
        'properties': {'method': {'type': 'string', 'enum': [name]}, 'params': params},
    }
    refs.append({'$ref': f'#/components/schemas/{sid}'})
    ex = {k: (0 if 'number' in str(props[k].get('type')) else 'string') for k in req}
    examples[name.replace('.', '_')] = {'summary': f'{name}: {m["summary"][:80]}', 'value': {'method': name, 'params': ex}}

err = {'type': 'object', 'properties': {'error': {'type': 'object', 'properties': {'code': {'type': 'string'}, 'message': {'type': 'string'}}}}}
spec = {
  'openapi': '3.0.3',
  'info': {
    'title': 'Nodal Agent Bridge API',
    'version': ver,
    'description': 'Local HTTP API of the Nodal agent bridge (`nodal-agent.mjs`). It lets AI agents, scripts and other programs drive a running Nodal window (web or desktop): place and wire parts, draw, manage pages and symbols, run the electrical rules check, read nets, export and take screenshots. Each change shows up live on the canvas with the agent\'s own cursor and stays off the user\'s undo history.\n\nThe bridge listens on 127.0.0.1 only. Start it with `node nodal-agent.mjs` (download: https://jpmarcelino.github.io/nodal/nodal-agent.mjs), then open Nodal and choose File -> AI agent link. All circuit operations are JSON-RPC style calls to `POST /rpc` with `{method, params}`; pick a method from the examples list. The same methods are available as MCP tools (`claude mcp add nodal -- node nodal-agent.mjs mcp`).\n\n' + cat['guide'][:6000],
    'license': {'name': 'MIT', 'url': 'https://github.com/JPMarcelino/nodal/blob/main/LICENSE'},
  },
  'externalDocs': {'description': 'Agent bridge README', 'url': 'https://github.com/JPMarcelino/nodal/blob/main/agent-bridge/README.md'},
  'servers': [{'url': 'http://127.0.0.1:{port}', 'description': 'Local agent bridge', 'variables': {'port': {'default': '47821', 'description': 'NODAL_AGENT_PORT / --port'}}}],
  'tags': [{'name': 'Bridge', 'description': 'Status and discovery'}, {'name': 'Circuit', 'description': 'Drive the linked Nodal window'}],
  'paths': {
    '/health': {'get': {'tags': ['Bridge'], 'summary': 'Bridge status and whether a Nodal window is linked', 'operationId': 'health', 'security': [],
      'responses': {'200': {'description': 'Status', 'content': {'application/json': {'schema': {'type': 'object', 'properties': {
        'ok': {'type': 'boolean'}, 'bridge': {'type': 'string', 'description': 'Bridge version'}, 'app': {'type': 'boolean', 'description': 'A Nodal window is linked'},
        'appInfo': {'type': 'object', 'nullable': True, 'properties': {'version': {'type': 'string'}, 'doc': {'type': 'object'}}}}}}}}}}},
    '/methods': {'get': {'tags': ['Bridge'], 'summary': 'The method catalog (guide and every method with its parameters)', 'operationId': 'methods', 'security': [],
      'responses': {'200': {'description': 'Catalog', 'content': {'application/json': {'schema': {'type': 'object', 'properties': {
        'version': {'type': 'integer'}, 'guide': {'type': 'string'},
        'methods': {'type': 'array', 'items': {'type': 'object', 'properties': {'name': {'type': 'string'}, 'summary': {'type': 'string'}, 'params': {'type': 'object', 'additionalProperties': {'type': 'string'}}, 'mutates': {'type': 'boolean'}}}}}}}}}}}},
    '/rpc': {'post': {'tags': ['Circuit'], 'summary': 'Call a method on the linked Nodal window', 'operationId': 'rpc',
      'description': f'Runs one of the {len(names)} methods. Calls run one at a time, in order. Use `batch` to apply several calls in one go (later calls can refer to earlier results as `$0.id`). Waits up to NODAL_AGENT_WAIT_MS (15 s) for a Nodal window to link.',
      'requestBody': {'required': True, 'content': {'application/json': {'schema': {'oneOf': refs}, 'examples': examples}}},
      'responses': {
        '200': {'description': '`{result}` on success or `{error}` if the method failed', 'content': {'application/json': {'schema': {'type': 'object', 'properties': {'result': {}, 'error': err['properties']['error']}}}}},
        '400': {'description': 'Body is not JSON or has no method', 'content': {'application/json': {'schema': err}}},
        '401': {'description': 'Missing or wrong bearer token', 'content': {'application/json': {'schema': err}}},
        '403': {'description': 'Request from a web origin that is not allowed', 'content': {'application/json': {'schema': err}}},
        '413': {'description': 'Request too large', 'content': {'application/json': {'schema': err}}}}}},
    '/events': {'get': {'tags': ['Bridge'], 'summary': 'Activity feed (server-sent events)', 'operationId': 'events',
      'description': 'Server-sent events: the user marking work done, blocked edits, connects. Each event is `data: {kind, text, ...}`.',
      'responses': {'200': {'description': 'Event stream', 'content': {'text/event-stream': {'schema': {'type': 'string'}}}}, '401': {'description': 'Missing or wrong bearer token', 'content': {'application/json': {'schema': err}}}}}},
  },
  'security': [{'bearerAuth': []}],
  'components': {'securitySchemes': {'bearerAuth': {'type': 'http', 'scheme': 'bearer', 'description': 'Token created on first run in ~/.config/nodal-agent/token (print it with `node nodal-agent.mjs token`).'}},
    'schemas': schemas},
}
json.dump(spec, open(sys.argv[3], 'w'), indent=2, ensure_ascii=False)
print(len(names), 'methods')
