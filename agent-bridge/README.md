# Nodal agent bridge

Lets AI agents drive a running Nodal window, web or desktop. Agents connect over **MCP**, **HTTP** or the **command line**. Everything an agent does shows up live on the user's canvas: its own cursor with its name and messages, an outline around what it just changed, and an activity log in the agent panel.

```
agent ──MCP / HTTP / CLI──▶ nodal-agent.mjs (127.0.0.1:47821) ──WebSocket──▶ Nodal (File → AI agent link)
```

There are no dependencies. It needs Node 18 or newer.

## Quick start

1. In Nodal: **File → AI agent link**. You can also open the app with `?agent` in the address, or `?agent=<port>` for another port. The agent panel appears at the top right and waits for the bridge.
2. Hook up your agent:

   **Claude Code** (or any MCP client):
   ```bash
   claude mcp add nodal -- node /path/to/nodal/agent-bridge/nodal-agent.mjs mcp
   ```
   The MCP server starts the bridge itself, or uses one that is already running. Each method below becomes a tool: `components_place`, `wires_connect`, `doc_screenshot`, and so on. The server's instructions carry the guide (coordinates, item model, wiring tips, the symbol DSL).

   **Anything else:** run the bridge, then call it.
   ```bash
   node agent-bridge/nodal-agent.mjs            # or: npm run agent
   node agent-bridge/nodal-agent.mjs call components.place '{"symbol":"resistor","x":100,"y":100,"value":"10k"}'
   curl -s localhost:47821/rpc -H "authorization: Bearer $(node agent-bridge/nodal-agent.mjs token)" \
        -d '{"method":"doc.summary","params":{}}'
   ```

## How agent work relates to the user

- **Independent of the user's input.** Calls never use the user's selection, tool, page or viewport. They take explicit ids, references (`R1`), coordinates and pages. Each call, or a whole `batch`, is applied in one go, the same way a live-session collaborator's edit is. It does not interrupt a drag the user is in the middle of, and it lands in neither the user's undo stack nor their selection. The agent has its own undo (`history.undo` / `history.redo`). That undo refuses to run over items the user has changed since, unless you pass `force`.
- **Its own page.** `session.setPage` picks the page the agent works on. The user can keep looking at another page; the panel tells them where the agent is working.
- **Visible.** Every call is written to the activity log; clicking an entry selects what it touched. The agent's cursor moves to each edit. `session.say` shows a message beside it. `session.progress` fills the progress bar. With **Follow** on (the default), the user's view frames the agent's drawing. Follow pauses for a few seconds after the user moves the view.
- **Guard.** Between `session.start` and `session.done`, the user's own edits can be kept off the agent's drawing. The user picks the mode in the panel:
  - **Its work** (default): the user can't change items the agent made or changed.
  - **Everything**: the circuit is read-only for the user.
  - **Off**: no protection.

  Blocked edits explain themselves. The guard lifts when the agent calls `session.done`, or when the user presses **Mark done**. It is never stored, so reloading the app clears it.
- **Questions.** `session.waitForUser {question, choices?}` shows a reply box in the panel and waits for the user's answer.
- **Safe replacement.** `doc.new`, `doc.load` and `versions.restore` first save the open circuit as a version in its history.
- **Read-only respected.** A guest in a view-only live session, or the user's View mode, makes every edit fail with `read_only`.

## Methods

`nodal.describe` returns the guide and every method with its parameters. `node nodal-agent.mjs methods` lists them, and `schema` prints the MCP tool schemas.

**nodal**: `describe`, `ping`

**session**: `start`, `status`, `say`, `progress`, `done`, `setPage`, `pointAt`, `log`, `waitForUser`

**app**: `state` (what the user is doing), `prefs`, `setPrefs`, `toast`, `commands`, `runCommand` (any menu or palette command)

**user** (acts on the user's view, on purpose): `select`, `show`, `setPage`, `setFollow`

**doc**: `get`, `summary`, `new`, `load`, `rename`, `settings`, `setSettings`, `insert`, `save`, `export` (svg / png / dxf / spice / kicad / bom / json), `screenshot` (PNG, which MCP clients receive as an image), `stats`

**pages**: `list`, `add`, `rename`, `delete`, `duplicate`, `move`

**items**: `list`, `get`, `create` (raw items, full control), `update`, `delete`, `move`, `moveTo`, `rotate`, `rotateShape`, `flip`, `scale`, `align`, `distribute`, `matchSize`, `restack`, `duplicate`, `moveToPage`, `lock`, `hide`, `style`, `getStyle`, `find`, `template`

**groups**: `list`, `create`, `ungroup`, `rename`

**components**: `place`, `placeMany`, `ports`, `setSymbol`, `annotate`

**wires**: `connect` (pin to pin, routed around parts), `connectMany`, `path` (exact points), `reroute`, `junction`, `unsolder`, `label`, `deletePart`

**shapes**: `add` (rect, zone, ellipse, polygon, line, arrow, text, image, ink, callout, frame), `presets`, `addPreset`, `connect` (glued connector), `note`, `toPath`

**symbols**: `list`, `categories`, `get`, `create` (symbol DSL), `fromSvg`, `fromItems`, `delete`, `importLibrary`, `exportLibrary`

**nets**: `list`, `of` · **check**: `run`, `ignore` · **history**: `undo`, `redo`, `steps` · **versions**: `save`, `list`, `restore` · **symbolEditor**: `open`, `close`

**batch** `{calls: [{method, params}], label?}` runs many calls as one step. Strings like `"$0.id"` or `"$1.pins.0.x"` refer to earlier results. If any call fails, the whole batch is rolled back.

Errors come back as `{"error": {"code", "message"}}`. The codes are `bad_params`, `not_found`, `read_only`, `conflict`, `no_app`, `timeout`, `unknown_method` and `degenerate`.

### Example: an RC low-pass filter

```json
{"method": "batch", "params": {"label": "RC filter", "calls": [
  {"method": "components.place", "params": {"symbol": "dc-source", "x": 100, "y": 200, "value": "5V"}},
  {"method": "components.place", "params": {"symbol": "resistor", "x": 220, "y": 120, "value": "10k"}},
  {"method": "components.place", "params": {"symbol": "capacitor", "x": 340, "y": 200, "rot": 90, "value": "100n"}},
  {"method": "components.place", "params": {"symbol": "gnd", "x": 100, "y": 300}},
  {"method": "components.place", "params": {"symbol": "gnd", "x": 340, "y": 300}},
  {"method": "wires.connect", "params": {"from": {"comp": "$0.id", "port": "+"}, "to": {"comp": "$1.id", "port": "1"}}},
  {"method": "wires.connect", "params": {"from": {"comp": "$1.id", "port": "2"}, "to": {"comp": "$2.id", "port": "1"}, "label": "OUT"}},
  {"method": "wires.connect", "params": {"from": {"comp": "$0.id", "port": "-"}, "to": {"comp": "$3.id", "port": "GND"}}},
  {"method": "wires.connect", "params": {"from": {"comp": "$2.id", "port": "2"}, "to": {"comp": "$4.id", "port": "GND"}}}
]}}
```

## HTTP

The server listens on `127.0.0.1` only.

| Route | Token | |
| --- | --- | --- |
| `GET /health` | no | `{ok, app}`: whether a Nodal window is linked |
| `GET /methods` | no | the catalog (guide and methods) |
| `POST /rpc` `{method, params}` | yes | `{result}` or `{error}` |
| `GET /events` | yes | server-sent events: the activity feed (the user marking work done, blocked edits, connects) |

The token is created on first run in `~/.config/nodal-agent/token` (mode 600). Send it as `Authorization: Bearer <token>`. Requests from web pages whose origin isn't allowed are refused, so a website can't drive Nodal through the bridge.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `NODAL_AGENT_PORT` (or `--port`) | `47821` | port for HTTP and the app's socket |
| `NODAL_AGENT_ORIGINS` | | extra origins allowed to connect as the app, comma-separated (e.g. a self-hosted copy) |
| `NODAL_AGENT_HOME` | `~/.config/nodal-agent` | where the token lives |
| `NODAL_AGENT_WAIT_MS` | `15000` | how long a call waits for a Nodal window to link |

The app accepts connections from local dev servers, the desktop app and the published web app. In the panel you can point the app at another bridge URL.

The published web app reaches the bridge at `ws://127.0.0.1`. Browsers treat that address as secure, so it works from the HTTPS page. Chrome may first ask the user to allow access to devices on the local network.

## Wire protocol (bridge ↔ app)

The app sends `{type:"hello", version, doc}` when it connects. The bridge sends `{type:"call", id, method, params}`, and the app answers `{type:"result", id, result | error}`. The app also sends `{type:"event", entry}` for the activity feed. The bridge sends `{type:"clients", count}` and, when another window takes the link, `{type:"standby"}`. Calls are run one at a time, in order.

The app side lives in `src/agent/`:

| File | Role |
| --- | --- |
| `catalog.json` | the methods (shared with this bridge) |
| `api.ts` | the handlers |
| `run.ts` | transactions, logging, follow |
| `tx.ts` | diffs and the agent's undo |
| `guard.ts` | the guard |
| `link.ts` | the WebSocket |
| `AgentPanel.tsx`, `AgentPresence.tsx` | the UI |
