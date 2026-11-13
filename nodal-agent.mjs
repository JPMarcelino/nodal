#!/usr/bin/env node
/**
 * Nodal agent bridge — lets AI agents drive a running Nodal (web or desktop).
 *
 *   node nodal-agent.mjs [serve]          run the bridge (HTTP + the app's WebSocket) on 127.0.0.1:47821
 *   node nodal-agent.mjs mcp              MCP server over stdio (starts the bridge too, or uses a running one)
 *   node nodal-agent.mjs call <method> [json-params | @file.json | -]
 *   node nodal-agent.mjs methods          list every method
 *   node nodal-agent.mjs events           stream the activity feed
 *   node nodal-agent.mjs token            print the HTTP token
 *
 * In Nodal: File → AI agent link (or open the app with ?agent / #agent). The
 * app connects to ws://127.0.0.1:<port>/app and runs each call it is sent.
 *
 * HTTP (127.0.0.1 only; every route but /health and /methods needs
 * "Authorization: Bearer <token>", the token is in ~/.config/nodal-agent/token):
 *   GET  /health                      { ok, app }
 *   GET  /methods                     the catalog (guide + methods)
 *   POST /rpc  {method, params}       → {result} | {error:{code,message}}
 *   GET  /events                      server-sent events: the app's activity feed
 *
 * No dependencies; Node 18+.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, chmodSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.NODAL_AGENT_PORT || argValue('--port') || 47821);
const HOST = '127.0.0.1';
const CONFIG_DIR = process.env.NODAL_AGENT_HOME || join(homedir(), '.config', 'nodal-agent');
const TOKEN_FILE = join(CONFIG_DIR, 'token');
const CALL_TIMEOUT = 120_000;
const MAX_BODY = 64 * 1024 * 1024;
const VERSION = '1.0.0';

/** Pages allowed to connect as the app: local dev servers, the desktop app, the published web app, and NODAL_AGENT_ORIGINS. */
const ORIGINS = [
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/,
  /^tauri:\/\/localhost$/,
  /^https?:\/\/tauri\.localhost$/,
  /^https:\/\/jpmarcelino\.github\.io$/,
  ...(process.env.NODAL_AGENT_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((o) => new RegExp(`^${o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)),
];

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const log = (...a) => process.stderr.write(`[nodal-agent] ${a.join(' ')}\n`);

/* ------------------------------------------------------------------ */
/* Catalog and JSON schemas                                            */
/* ------------------------------------------------------------------ */

function loadCatalog() {
  for (const p of [join(HERE, '..', 'src', 'agent', 'catalog.json'), join(HERE, 'catalog.json')]) {
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  }
  return { version: 0, guide: '', methods: [] };
}
/** The catalog baked in by the web app's build (the downloadable single-file bridge); null in the repo. */
const EMBEDDED_CATALOG = {"version":1,"guide":"Nodal agent API. You drive a live Nodal window: every edit appears on the user's canvas as you make it, with your own cursor and an activity log. Your work is independent of the user's selection, tool, page and viewport: always pass explicit ids, coordinates and (optionally) a page; nothing here reads what the user clicked. Edits you make are not on the user's undo stack (use history.undo for yours).\n\nWorkflow: session.start {name, goal} first, then build, then session.done {summary}. While you are working the user may be prevented from editing what you made (the guard; the user decides). Use session.say to narrate, doc.screenshot to look at the result, check.run to verify wiring.\n\nCoordinates: world pixels, x right, y DOWN. The grid is doc.settings.grid (default 10); keep parts and wire points on it. A typical 2-pin part (resistor) is 60–80 px long. Rotation is 0/90/180/270 clockwise.\n\nItems (doc.items, keyed by id): component (a placed symbol: symbol, x, y = its centre, rot, flipX, ref like R1, value like 10k, props), wire (a, b endpoints + pts bends), junction (solder dot x, y), shape (kind rect|zone|ellipse|polygon|line|arrow|text|image|ink|callout|frame, box x y w h, styling). Wire endpoints: {kind:'port', comp, port} | {kind:'junction', id} | {kind:'free', x, y}.\n\nWiring: prefer wires.connect with port targets ({ref:'R1', port:'2'} or {comp:id, port:'name or id'}); it routes orthogonally around parts and makes junctions where you land on a wire. components.ports tells you each pin's id, name and absolute position. Nets also join by name: place 'net-label' / 'gnd' / 'vcc' symbols with the same value on several pins.\n\nPages: a document has one or more pages; methods taking 'page' default to your working page (session.setPage), never the user's page.\n\nSymbols: symbols.list / symbols.get give the library (ids like 'resistor', 'capacitor', 'dc-source', 'gnd', 'vcc', 'net-label', 'opamp'). symbols.create adds a custom symbol drawn in the symbol DSL: one command per line — W w (stroke width), SC colour, FC colour, DA 1|0 (dashed), L x1 y1 x2 y2 … (polyline), G … (closed polygon, GF filled, GB background-filled), R x y w h [rx] (RF, RB), C cx cy r (CF, CB), E cx cy rx ry, A cx cy r a1 a2 (arc, degrees clockwise from +x), P <svg path> (PF, PB), T x y size s|m|e text. Ports: 'name:x,y name2:x,y' in symbol-local px (origin top-left).\n\nBatching: batch {calls:[{method, params}]} runs many edits as ONE step (one undo, one repaint); later calls can use ids from earlier ones via \"$0.id\" / \"$2.ids.0\" strings (result of call #n, dotted path).\n\nErrors come back as {error:{code, message}}. Read-only methods never change anything.","methods":[{"name":"nodal.describe","summary":"This guide plus every method with its parameters.","params":{"method?":"string — only this method"}},{"name":"nodal.ping","summary":"Checks the app is connected; returns its version and the open document's id and name.","params":{}},{"name":"session.start","summary":"Starts (or restarts) your work session: shows you in the app as working, with your name and goal. Call before editing.","params":{"name?":"string — how you are shown (e.g. 'Claude')","goal?":"string — one line on what you are about to do","color?":"string — CSS colour of your cursor"},"mutates":false},{"name":"session.status","summary":"Your session (status, guard mode chosen by the user, working page, items you own, follow mode) and whether the circuit can be edited at all.","params":{}},{"name":"session.say","summary":"Shows a message to the user (activity log and a bubble at your cursor).","params":{"text":"string","kind?":"info|success|warning|error"}},{"name":"session.progress","summary":"Updates the progress shown in the agent panel.","params":{"text?":"string — what you are doing now","fraction?":"number — 0…1"}},{"name":"session.done","summary":"Marks your work finished: the guard is lifted and the user gets a notification with your summary.","params":{"summary?":"string"}},{"name":"session.setPage","summary":"Sets your working page (default target of every edit). Does not change what the user looks at.","params":{"page":"string — page id or name"}},{"name":"session.pointAt","summary":"Moves your cursor (what the user sees you looking at) to a point or to items.","params":{"x?":"number","y?":"number","ids?":"string[]","page?":"string"}},{"name":"session.log","summary":"Recent entries of the activity log the user sees.","params":{"limit?":"integer — default 50"}},{"name":"session.waitForUser","summary":"Waits until the user replies in the agent panel (or the timeout passes) and returns their reply. Use for questions that need a human decision.","params":{"question":"string — shown in the panel with a reply box","timeoutMs?":"integer — default 120000, max 600000","choices?":"string[] — optional quick answers shown as buttons"}},{"name":"app.state","summary":"What the user is doing: page in view, selection, tool, viewport, theme, open dialog, read-only modes, file path, unsaved changes, live-session status, symbol editor open.","params":{}},{"name":"app.prefs","summary":"Reads the app preferences.","params":{}},{"name":"app.setPrefs","summary":"Changes app preferences (theme, wireAvoid, wireAngle, showMinimap, autosave…). Affects the user's UI.","params":{"patch":"object — keys of app.prefs"}},{"name":"app.toast","summary":"Shows a short notification at the bottom of the window.","params":{"text":"string","kind?":"info|success|error"}},{"name":"app.commands","summary":"Lists the app's UI commands (menu / palette entries) with ids and shortcuts.","params":{"query?":"string — filter by words"}},{"name":"app.runCommand","summary":"Runs a UI command exactly as the user would (it acts on the USER's selection, page and view — prefer the dedicated methods for edits).","params":{"id":"string — from app.commands"}},{"name":"user.select","summary":"Selects items for the user (switching the user's page if needed) — e.g. to show them what you mean.","params":{"ids":"string[]"}},{"name":"user.show","summary":"Moves the user's view to items or a rectangle (switching page if needed).","params":{"ids?":"string[]","rect?":"object — {x,y,w,h}","page?":"string"}},{"name":"user.setPage","summary":"Switches the page the user is looking at.","params":{"page":"string"}},{"name":"user.setFollow","summary":"Turns 'follow the agent' on or off (the user's view tracks your edits). The user can change it too.","params":{"on":"boolean"}},{"name":"doc.get","summary":"The whole document as JSON (format 'nodal'), or one page of it.","params":{"page?":"string — only this page's items","symbols?":"boolean — include custom symbol definitions (default true)"}},{"name":"doc.summary","summary":"Compact overview: name, pages with item counts, bounds, every part (ref, symbol, value, position) and how many wires / shapes / nets there are.","params":{"page?":"string — one page only"}},{"name":"doc.new","summary":"Replaces the open circuit with a new empty one (the old one is kept as a version in history first).","params":{"name?":"string"},"mutates":true},{"name":"doc.load","summary":"Replaces the open circuit with the given document (object or JSON text). The old one is kept as a version first.","params":{"doc":"any — a Nodal document object or its JSON text"},"mutates":true},{"name":"doc.rename","summary":"Renames the circuit.","params":{"name":"string"},"mutates":true},{"name":"doc.settings","summary":"Reads the document settings (grid, wire style, hops, junction size, colours, title block, sheet…).","params":{}},{"name":"doc.setSettings","summary":"Changes document settings; nested objects (wire, sheet) are merged.","params":{"patch":"object — keys of doc.settings"},"mutates":true},{"name":"doc.insert","summary":"Inserts another circuit or fragment (its items get new ids) offset by dx, dy on a page. Returns the new ids.","params":{"doc":"any — Nodal document, fragment ({format:'nodal-fragment', items, groups, symbols}) or template, object or JSON text","dx?":"number","dy?":"number","page?":"string"},"mutates":true},{"name":"doc.save","summary":"Saves the circuit: desktop app writes to its file (or 'path'); the web app downloads it.","params":{"path?":"string — desktop only: file to write"}},{"name":"doc.export","summary":"Exports and returns the content: svg / dxf / spice / kicad / bom / json as text, png as base64.","params":{"format":"svg|png|dxf|spice|kicad|bom|json","page?":"string","ids?":"string[] — only these items","rect?":"object — {x,y,w,h} world area","theme?":"light|dark","background?":"boolean","scale?":"number — png resolution (default 2)"}},{"name":"doc.screenshot","summary":"Renders a page (or items / an area) to a PNG so you can see the drawing. Returns base64 PNG plus its world bounds.","params":{"page?":"string","ids?":"string[]","rect?":"object — {x,y,w,h}","theme?":"light|dark","maxSize?":"integer — longest side in px (default 1600)"}},{"name":"doc.stats","summary":"Counts of parts, wires, junctions, shapes, nets and pages.","params":{}},{"name":"pages.list","summary":"Pages in tab order with item counts; marks your working page and the user's page.","params":{}},{"name":"pages.add","summary":"Adds a page; returns its id.","params":{"name?":"string","after?":"string — page id"},"mutates":true},{"name":"pages.rename","summary":"Renames a page.","params":{"page":"string","name":"string"},"mutates":true},{"name":"pages.delete","summary":"Deletes a page and everything on it (not the last page).","params":{"page":"string"},"mutates":true},{"name":"pages.duplicate","summary":"Copies a page with all its items; returns the new page id.","params":{"page":"string","name?":"string"},"mutates":true},{"name":"pages.move","summary":"Moves a page to a position in the tab row (0 = first).","params":{"page":"string","to":"integer"},"mutates":true},{"name":"items.list","summary":"Lists items compactly, filtered. Components show ref / symbol / value; wires their ends; shapes kind and text.","params":{"page?":"string — default your working page; 'all' for every page","type?":"component|wire|junction|shape","kind?":"string — shape kind","symbol?":"string","rect?":"object — {x,y,w,h}: only items touching it","text?":"string — matches ref, value, label or text","limit?":"integer — default 500"}},{"name":"items.get","summary":"Full items by id (or component ref), with bounds; components also get their pins' positions.","params":{"ids":"string[] — ids or refs"}},{"name":"items.create","summary":"Creates raw items (any type, full control of fields). Missing ids are generated; components get default ref / value / props from their symbol when omitted. Wire endpoints may name parts by ref.","params":{"items":"object[] — partial Item objects with at least type","page?":"string"},"mutates":true},{"name":"items.update","summary":"Changes fields of items (shallow merge; nested objects like style / labelStyle / props are merged). 'unset' removes fields.","params":{"ids":"string[] — ids or refs","patch":"object","unset?":"string[]"},"mutates":true},{"name":"items.delete","summary":"Deletes items; wires attached to deleted parts keep their shape.","params":{"ids":"string[]"},"mutates":true},{"name":"items.move","summary":"Moves items by dx, dy; connected wires follow (like dragging).","params":{"ids":"string[]","dx":"number","dy":"number","detach?":"boolean — leave connections behind instead"},"mutates":true},{"name":"items.moveTo","summary":"Moves items so the first one's position (x, y) lands at the given point; the rest keep their offsets.","params":{"ids":"string[]","x":"number","y":"number"},"mutates":true},{"name":"items.rotate","summary":"Turns items a quarter (or half) turn about their common centre (or 'pivot'); wires follow.","params":{"ids":"string[]","deg":"90|-90|180","pivot?":"object — {x,y}"},"mutates":true},{"name":"items.rotateShape","summary":"Turns one shape by any angle about its centre (or a pivot).","params":{"id":"string","deg":"number","pivot?":"object — {x,y}"},"mutates":true},{"name":"items.flip","summary":"Mirrors items left-right (x) or up-down (y).","params":{"ids":"string[]","axis":"x|y"},"mutates":true},{"name":"items.scale","summary":"Scales items about a pivot (default their centre).","params":{"ids":"string[]","factor":"number","pivot?":"object — {x,y}"},"mutates":true},{"name":"items.align","summary":"Aligns items' edges or centres.","params":{"ids":"string[]","mode":"left|hcenter|right|top|vcenter|bottom"},"mutates":true},{"name":"items.distribute","summary":"Spaces items evenly along an axis.","params":{"ids":"string[]","axis":"x|y"},"mutates":true},{"name":"items.matchSize","summary":"Gives shapes the size of the first one.","params":{"ids":"string[]","mode":"width|height|both"},"mutates":true},{"name":"items.restack","summary":"Changes stacking order.","params":{"ids":"string[]","dir":"forward|backward|front|back"},"mutates":true},{"name":"items.duplicate","summary":"Copies items (with the wires between them) offset by dx, dy, optionally onto another page; returns new ids.","params":{"ids":"string[]","dx?":"number — default 2 grid steps","dy?":"number — default 2 grid steps","page?":"string"},"mutates":true},{"name":"items.moveToPage","summary":"Moves items to another page.","params":{"ids":"string[]","page":"string"},"mutates":true},{"name":"items.lock","summary":"Locks or unlocks items.","params":{"ids":"string[]","locked":"boolean"},"mutates":true},{"name":"items.hide","summary":"Hides or shows items.","params":{"ids":"string[]","hidden":"boolean"},"mutates":true},{"name":"items.style","summary":"Applies a look to any items, with the Style panel's keys: line (colour), fill, fillOpacity, width, dash, text (text colour), size, bold, italic, underline, allCaps, font (''|serif|mono), align, valign, wrapW, lineOpacity, cap, join, radius, fillKind (none|solid|gradient), fill2, gradAngle, opacity, shadow. Keys that don't apply to an item are ignored.","params":{"ids":"string[]","look":"object"},"mutates":true},{"name":"items.getStyle","summary":"Reads the look of items (common values, and which keys differ).","params":{"ids":"string[]"}},{"name":"items.find","summary":"Finds items by text in refs, values, wire labels, shape text and props, across all pages.","params":{"text":"string","limit?":"integer"}},{"name":"items.template","summary":"Items (with the wires between them) as a reusable template file (format 'nodal-template'); doc.insert puts it back.","params":{"ids":"string[]","name?":"string"}},{"name":"groups.list","summary":"Groups with their members.","params":{}},{"name":"groups.create","summary":"Groups items; returns the group id.","params":{"ids":"string[]","name?":"string"},"mutates":true},{"name":"groups.ungroup","summary":"Takes items out of their (outermost) groups.","params":{"ids":"string[]"},"mutates":true},{"name":"groups.rename","summary":"Renames a group.","params":{"group":"string","name":"string"},"mutates":true},{"name":"components.place","summary":"Places a part from the library, centred on x, y. Returns its id, ref and pins with absolute positions (wire to those).","params":{"symbol":"string — symbol id","x":"number — centre","y":"number — centre","rot?":"0|90|180|270","flipX?":"boolean","ref?":"string","value?":"string","props?":"object","showRef?":"boolean","showValue?":"boolean","page?":"string","style?":"object — color, fill, lineWidth, dash, scale, labelColor…"},"mutates":true},{"name":"components.placeMany","summary":"Places several parts in one step (same fields as components.place each).","params":{"parts":"object[]","page?":"string"},"mutates":true},{"name":"components.ports","summary":"Pins of a part: id, name, absolute position, side, and what is connected (wires, net name).","params":{"id":"string — id or ref"}},{"name":"components.setSymbol","summary":"Swaps the symbol a part is drawn with (e.g. another type of the same part), keeping its position and labels.","params":{"id":"string","symbol":"string"},"mutates":true},{"name":"components.annotate","summary":"Renumbers every part's reference left-to-right, top-to-bottom, page by page.","params":{},"mutates":true},{"name":"wires.connect","summary":"Draws a wire between two targets, routed orthogonally around parts. A target is a pin {ref|comp, port}, a junction {junction}, a point on a wire {wire, x, y} (makes a junction there) or a loose point {x, y}. Returns the wire id.","params":{"from":"object — target","to":"object — target","via?":"object[] — bend points {x,y} to pass through","angle?":"ortho|45|any","route?":"boolean — route around parts (default true)","style?":"object — {color, width, radius, dash}","label?":"string — wire name","page?":"string"},"mutates":true},{"name":"wires.connectMany","summary":"Several wires.connect in one step; returns their ids (null where nothing was drawn).","params":{"wires":"object[] — each {from, to, via?, angle?, style?, label?}","page?":"string"},"mutates":true},{"name":"wires.path","summary":"Draws a wire exactly through given points (no routing); ends snap to pins, junctions or wires lying on them.","params":{"points":"object[] — [{x,y}, …] at least 2","style?":"object","label?":"string","page?":"string"},"mutates":true},{"name":"wires.reroute","summary":"Re-routes wires around parts (all wires on the page when no ids).","params":{"ids?":"string[]","page?":"string"},"mutates":true},{"name":"wires.junction","summary":"Joins wires that cross or meet at a point with a solder dot (or adds a free junction).","params":{"x":"number","y":"number","wires?":"string[]","page?":"string"},"mutates":true},{"name":"wires.unsolder","summary":"Removes a junction (the wires through it stay joined as one) or disconnects a pin.","params":{"junction?":"string","comp?":"string","port?":"string"},"mutates":true},{"name":"wires.label","summary":"Names a wire (its net) and places the label.","params":{"id":"string","label":"string","at?":"number — 0…1 along the wire","side?":"above|below|left|right","hidden?":"boolean"},"mutates":true},{"name":"wires.deletePart","summary":"Deletes one bend (node) or one segment of a wire: an end segment shortens it, a middle one splits it in two.","params":{"id":"string — wire","kind":"node|segment","index":"integer — node index (0 = end a) or segment index"},"mutates":true},{"name":"shapes.add","summary":"Adds a shape. Boxes use x, y, w, h; line / arrow use from / to (points or {id} to glue to an item) and optional bends; polygon / path use points; text uses text and fontSize; callout uses text and anchor {x,y} or {id}; image uses src (data URL); ink uses points with optional pressure p.","params":{"kind":"rect|zone|ellipse|polygon|line|arrow|text|image|ink|callout|frame","x?":"number","y?":"number","w?":"number","h?":"number","points?":"object[] — polygon / ink / line points","from?":"object — line/arrow start {x,y} or {id, fx?, fy?}","to?":"object — line/arrow end","text?":"string","props?":"object — any ShapeItem fields (stroke, fill, fillOpacity, strokeWidth, dash, radius, fontSize, textColor, bold, route, headEnd…)","page?":"string"},"mutates":true},{"name":"shapes.presets","summary":"Lists the shape presets (flowchart, arrows, basic).","params":{"query?":"string"}},{"name":"shapes.addPreset","summary":"Adds a preset shape (e.g. a flowchart decision).","params":{"preset":"string","x":"number","y":"number","w?":"number","h?":"number","text?":"string","page?":"string"},"mutates":true},{"name":"shapes.connect","summary":"Draws a connector (arrow or line) glued between two items, so it follows them.","params":{"from":"string — item id","to":"string — item id","kind?":"arrow|line","route?":"straight|elbow|curved","text?":"string","props?":"object","page?":"string"},"mutates":true},{"name":"shapes.note","summary":"Adds a callout pointing at items (or a point) with text — handy to explain your work.","params":{"text":"string","ids?":"string[]","x?":"number","y?":"number","page?":"string"},"mutates":true},{"name":"shapes.toPath","summary":"Turns rectangles, ellipses and unattached lines into editable paths (polygons with curves).","params":{"ids":"string[]"},"mutates":true},{"name":"symbols.list","summary":"Library symbols (built-in, the user's and the document's), filtered.","params":{"query?":"string — words in name, id, category or keywords","category?":"string","limit?":"integer — default 100"}},{"name":"symbols.categories","summary":"Symbol categories with counts.","params":{}},{"name":"symbols.get","summary":"A symbol's full definition: size, pins (id, name, local x, y, side), fields, prefix, types, and its DSL source.","params":{"id":"string"}},{"name":"symbols.create","summary":"Creates (or replaces) a custom symbol from DSL source; it is stored in the document and, optionally, in the user's library. Returns its id.","params":{"name":"string","draw":"string — symbol DSL","ports":"string — 'name:x,y …'","w":"number","h":"number","id?":"string","category?":"string","prefix?":"string — e.g. U","value?":"string","fields?":"string — 'key:Label=default, …'","keywords?":"string","hideLabels?":"boolean","saveToLibrary?":"boolean — default true"},"mutates":true},{"name":"symbols.fromSvg","summary":"Creates a custom symbol from SVG markup (its drawing), with pins you name.","params":{"name":"string","svg":"string","ports?":"string — 'name:x,y …' in the result's coordinates","size?":"number — longest side, default 80","prefix?":"string","saveToLibrary?":"boolean"},"mutates":true},{"name":"symbols.fromItems","summary":"Turns items into a new symbol; with replace, they are swapped for one instance of it.","params":{"ids":"string[]","name":"string","replace?":"boolean — default true","prefix?":"string"},"mutates":true},{"name":"symbols.delete","summary":"Removes a custom symbol from the user's library (parts using it keep their copy).","params":{"id":"string"}},{"name":"symbols.importLibrary","summary":"Adds the symbols of a Nodal library file (format 'nodal-library') to the user's library.","params":{"library":"any — library object or its JSON text","overwrite?":"boolean — replace symbols with the same id"}},{"name":"symbols.exportLibrary","summary":"The user's library as a Nodal library file (to save or share).","params":{}},{"name":"nets.list","summary":"Electrical nets: name, label names, wires and pins (ref.port).","params":{"page?":"string — only nets touching this page"}},{"name":"nets.of","summary":"The net of a pin or wire.","params":{"wire?":"string","comp?":"string — id or ref","port?":"string"}},{"name":"check.run","summary":"Runs the electrical rules check: unconnected pins, duplicate refs, shorts, loose ends… (issues the user chose to ignore are listed apart).","params":{"page?":"string"}},{"name":"check.ignore","summary":"Marks rule-check issues as ignored (or not).","params":{"keys":"string[]","ignored?":"boolean — default true"},"mutates":true},{"name":"history.undo","summary":"Undoes your last step (only yours; refused if the user has changed the same items since).","params":{"force?":"boolean — undo even over later changes"},"mutates":true},{"name":"history.redo","summary":"Redoes your last undone step.","params":{},"mutates":true},{"name":"history.steps","summary":"Your steps so far (labels, item counts), newest last.","params":{}},{"name":"versions.save","summary":"Saves a named version of the circuit in its version history.","params":{"label?":"string"}},{"name":"versions.list","summary":"Saved versions of the open circuit.","params":{}},{"name":"versions.restore","summary":"Opens a saved version in place of the circuit (the current state is saved as a version first).","params":{"id":"string"},"mutates":true},{"name":"symbolEditor.open","summary":"Opens the user's symbol editor page on a symbol (or a new one). UI action.","params":{"symbol?":"string"}},{"name":"symbolEditor.close","summary":"Closes the symbol editor page without saving.","params":{}},{"name":"batch","summary":"Runs several calls as ONE step (one undo step, one repaint). Strings like \"$0.id\" refer to earlier results (call index, dotted path). Stops at the first error and undoes the whole batch.","params":{"calls":"object[] — [{method, params}]","label?":"string"},"mutates":true}]};
let catalog = EMBEDDED_CATALOG ?? loadCatalog();

/** "number — what it is" → JSON schema. Types: string, number, integer, boolean, object, any, T[], or a|b|c. */
export function paramSchema(spec) {
  const [type, ...rest] = String(spec).split(' — ');
  const description = rest.join(' — ') || undefined;
  const t = type.trim();
  let s;
  if (t.endsWith('[]')) s = { type: 'array', items: paramSchema(t.slice(0, -2)) };
  else if (t.includes('|')) {
    const vals = t.split('|');
    s = vals.every((v) => /^-?\d+(\.\d+)?$/.test(v)) ? { type: 'number', enum: vals.map(Number) } : { type: 'string', enum: vals };
  } else if (t === 'any') s = {};
  else s = { type: t };
  if (description) s.description = description;
  return s;
}

export function methodSchema(m) {
  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(m.params || {})) {
    const opt = key.endsWith('?');
    const name = opt ? key.slice(0, -1) : key;
    properties[name] = paramSchema(spec);
    if (!opt) required.push(name);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: true };
}

export const toolName = (method) => method.replace(/\./g, '_');

/* ------------------------------------------------------------------ */
/* Token                                                               */
/* ------------------------------------------------------------------ */

function readToken() {
  try {
    return readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return null;
  }
}

function ensureToken() {
  const have = readToken();
  if (have) return have;
  mkdirSync(CONFIG_DIR, { recursive: true });
  const t = randomBytes(24).toString('hex');
  writeFileSync(TOKEN_FILE, `${t}\n`, { mode: 0o600 });
  try {
    chmodSync(TOKEN_FILE, 0o600);
  } catch {
    /* not on this file system */
  }
  return t;
}

/* ------------------------------------------------------------------ */
/* Minimal WebSocket server (RFC 6455, text frames)                    */
/* ------------------------------------------------------------------ */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsFrame(data, opcode = 1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const n = payload.length;
  const head = n < 126 ? Buffer.alloc(2) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = 0x80 | opcode;
  if (n < 126) head[1] = n;
  else if (n < 65536) {
    head[1] = 126;
    head.writeUInt16BE(n, 2);
  } else {
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([head, payload]);
}

/** Wraps an upgraded socket: onMessage(text), onClose(); returns { send, close, ping }. */
function wsConnection(socket, onMessage, onClose) {
  let buf = Buffer.alloc(0);
  let parts = [];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      socket.end(wsFrame(Buffer.alloc(0), 8));
    } catch {
      /* gone */
    }
    socket.destroy();
    onClose();
  };
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (len > MAX_BODY) return close();
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      const mask = masked ? buf.subarray(off, off + 4) : null;
      const data = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      buf = buf.subarray(off + maskLen + len);
      if (op === 8) return close();
      if (op === 9) {
        socket.write(wsFrame(data, 10));
        continue;
      }
      if (op === 10) continue;
      if (op === 1 || op === 2 || op === 0) {
        parts.push(data);
        if (fin) {
          const text = Buffer.concat(parts).toString('utf8');
          parts = [];
          onMessage(text);
        }
      }
    }
  });
  socket.on('close', () => {
    if (!closed) {
      closed = true;
      onClose();
    }
  });
  socket.on('error', () => socket.destroy());
  return {
    send: (text) => !closed && socket.write(wsFrame(text)),
    ping: () => !closed && socket.write(wsFrame(Buffer.alloc(0), 9)),
    close,
  };
}

/* ------------------------------------------------------------------ */
/* The bridge                                                          */
/* ------------------------------------------------------------------ */

class Bridge {
  constructor() {
    this.app = null;
    this.appInfo = null;
    this.pending = new Map();
    this.nextId = 1;
    this.sse = new Set();
    this.local = 0;
    this.waiters = [];
    this.token = ensureToken();
  }

  clients() {
    return this.sse.size + this.local;
  }

  tellClients() {
    this.app?.send(JSON.stringify({ type: 'clients', count: this.clients() }));
  }

  emit(event) {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.sse) res.write(line);
  }

  attachApp(conn) {
    if (this.app) {
      this.app.send(JSON.stringify({ type: 'standby' }));
      this.app.close();
    }
    this.app = conn;
    log('Nodal connected');
    this.tellClients();
    for (const w of this.waiters.splice(0)) w();
  }

  detachApp(conn) {
    if (this.app !== conn) return;
    this.app = null;
    this.appInfo = null;
    log('Nodal disconnected');
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ error: { code: 'app_gone', message: 'Nodal disconnected before answering' } });
      this.pending.delete(id);
    }
    this.emit({ kind: 'system', text: 'Nodal disconnected' });
  }

  onAppMessage(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === 'hello') {
      this.appInfo = msg;
      this.emit({ kind: 'system', text: `Nodal ${msg.version} connected (${msg.doc?.name ?? 'untitled'})` });
    } else if (msg.type === 'result') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      p.resolve(msg.error ? { error: msg.error } : { result: msg.result });
    } else if (msg.type === 'event') {
      this.emit(msg.entry);
    }
  }

  /** Waits (up to ms) for a Nodal window to connect. */
  waitForApp(ms) {
    if (this.app) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        resolve(true);
      };
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve(false);
      }, ms);
      this.waiters.push(done);
    });
  }

  async call(method, params = {}) {
    if (method === 'bridge.status') return { result: { app: !!this.app, appInfo: this.appInfo, clients: this.clients(), port: PORT } };
    if (!(await this.waitForApp(Number(process.env.NODAL_AGENT_WAIT_MS || 15000)))) {
      return { error: { code: 'no_app', message: `No Nodal window is linked. Open Nodal and turn on File → AI agent link (or open it with ?agent) — it connects to ws://${HOST}:${PORT}/app.` } };
    }
    const id = this.nextId++;
    const ms = method === 'session.waitForUser' ? Math.min(610000, Number(params?.timeoutMs ?? 120000) + 10000) : CALL_TIMEOUT;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: { code: 'timeout', message: `${method} got no answer from Nodal within ${ms / 1000}s` } });
      }, ms);
      this.pending.set(id, { resolve, timer });
      this.app.send(JSON.stringify({ type: 'call', id, method, params }));
    });
  }

  listen() {
    const server = createServer((req, res) => this.http(req, res));
    server.on('upgrade', (req, socket) => this.upgrade(req, socket));
    setInterval(() => this.app?.ping(), 25000).unref();
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(PORT, HOST, () => {
        server.off('error', reject);
        log(`bridge on http://${HOST}:${PORT} (app socket ws://${HOST}:${PORT}/app)`);
        resolve(server);
      });
    });
  }

  upgrade(req, socket) {
    const url = new URL(req.url, 'http://x');
    const origin = req.headers.origin;
    if (url.pathname !== '/app' || req.headers.upgrade?.toLowerCase() !== 'websocket' || (origin && !ORIGINS.some((o) => o.test(origin)))) {
      if (origin && !ORIGINS.some((o) => o.test(origin))) log(`refused app connection from ${origin} (add it to NODAL_AGENT_ORIGINS to allow)`);
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);
    const conn = wsConnection(
      socket,
      (text) => this.onAppMessage(text),
      () => this.detachApp(conn),
    );
    this.attachApp(conn);
  }

  authed(req, url) {
    const h = req.headers.authorization || '';
    const t = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token');
    if (typeof t !== 'string') return false;
    const a = createHash('sha256').update(t).digest();
    const b = createHash('sha256').update(this.token).digest();
    return timingSafeEqual(a, b);
  }

  async http(req, res) {
    const url = new URL(req.url, 'http://x');
    const json = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    // browsers may only read /health and /methods (no token, nothing private)
    const origin = req.headers.origin;
    if (url.pathname === '/health') return json(200, { ok: true, bridge: VERSION, app: !!this.app, appInfo: this.appInfo && { version: this.appInfo.version, doc: this.appInfo.doc } });
    if (url.pathname === '/methods') return json(200, this.appInfo?.catalog ?? catalog);
    if (origin && !ORIGINS.some((o) => o.test(origin))) return json(403, { error: { code: 'forbidden', message: 'origin not allowed' } });
    if (!this.authed(req, url)) return json(401, { error: { code: 'unauthorized', message: `Send "Authorization: Bearer <token>" (the token is in ${TOKEN_FILE})` } });
    if (url.pathname === '/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ kind: 'system', text: this.app ? 'Nodal is linked' : 'Waiting for Nodal' })}\n\n`);
      this.sse.add(res);
      this.tellClients();
      const keep = setInterval(() => res.write(': keep-alive\n\n'), 20000);
      req.on('close', () => {
        clearInterval(keep);
        this.sse.delete(res);
        this.tellClients();
      });
      return;
    }
    if (url.pathname === '/rpc' && req.method === 'POST') {
      let size = 0;
      const chunks = [];
      for await (const c of req) {
        size += c.length;
        if (size > MAX_BODY) return json(413, { error: { code: 'too_large', message: 'request too large' } });
        chunks.push(c);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return json(400, { error: { code: 'bad_json', message: 'body must be JSON {method, params}' } });
      }
      if (typeof body.method !== 'string') return json(400, { error: { code: 'bad_request', message: 'method is required' } });
      return json(200, await this.call(body.method, body.params ?? {}));
    }
    json(404, { error: { code: 'not_found', message: 'routes: GET /health, GET /methods, POST /rpc, GET /events' } });
  }
}

/* ------------------------------------------------------------------ */
/* Talking to a bridge: in this process, or one already running        */
/* ------------------------------------------------------------------ */

/** Starts a bridge here, or (port taken) returns a client of the running one. */
async function connectBridge() {
  const bridge = new Bridge();
  try {
    await bridge.listen();
    return { call: (m, p) => bridge.call(m, p), local: bridge, events: (fn) => (bridge.sse.add({ write: (l) => fn(JSON.parse(l.slice(6))) }), bridge.tellClients()) };
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
  }
  const token = readToken();
  const base = `http://${HOST}:${PORT}`;
  const health = await fetch(`${base}/health`).then((r) => r.json()).catch(() => null);
  if (!health?.bridge) throw new Error(`Port ${PORT} is taken by something that is not a Nodal agent bridge (set NODAL_AGENT_PORT)`);
  log(`using the bridge already running on ${base}`);
  const call = async (method, params) => {
    try {
      const r = await fetch(`${base}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ method, params }) });
      return await r.json();
    } catch (e) {
      return { error: { code: 'bridge_gone', message: `The bridge stopped: ${e.message}` } };
    }
  };
  const events = async (fn) => {
    for (;;) {
      try {
        const r = await fetch(`${base}/events`, { headers: { authorization: `Bearer ${token}` } });
        const dec = new TextDecoder();
        let buf = '';
        for await (const chunk of r.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (line.startsWith('data: ')) fn(JSON.parse(line.slice(6)));
          }
        }
      } catch {
        /* reconnect */
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  };
  return { call, local: null, events };
}

/* ------------------------------------------------------------------ */
/* MCP over stdio                                                      */
/* ------------------------------------------------------------------ */

const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

function mcpTools() {
  return catalog.methods.map((m) => ({
    name: toolName(m.name),
    description: `${m.summary}${m.mutates ? ' (edits the circuit)' : ''}`,
    inputSchema: methodSchema(m),
  }));
}

/** An MCP tool result from a call result: JSON text, plus the picture for screenshots / PNG exports. */
export function toolResult(res) {
  if (res.error) return { content: [{ type: 'text', text: `Error (${res.error.code}): ${res.error.message}` }], isError: true };
  const r = res.result;
  if (r && typeof r === 'object' && r.mime === 'image/png' && typeof r.base64 === 'string') {
    const { base64, ...rest } = r;
    return { content: [{ type: 'image', data: base64, mimeType: 'image/png' }, { type: 'text', text: JSON.stringify(rest) }] };
  }
  const text = r === undefined ? 'ok' : JSON.stringify(r, null, 1);
  return { content: [{ type: 'text', text }] };
}

async function runMcp() {
  let bridge = await connectBridge();
  const register = (b) => (b.local ? (b.local.local++, b.local.tellClients()) : b.events(() => {})); // counts this agent at the bridge
  register(bridge);
  // the process that ran the bridge may go away: take it over and try again
  const call = async (m, p) => {
    const res = await bridge.call(m, p);
    if (res.error?.code !== 'bridge_gone') return res;
    bridge = await connectBridge();
    register(bridge);
    return bridge.call(m, p);
  };
  const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const byTool = new Map(catalog.methods.map((m) => [toolName(m.name), m.name]));
  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    const { id, method, params } = msg;
    const reply = (result) => id !== undefined && out({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => id !== undefined && out({ jsonrpc: '2.0', id, error: { code, message } });
    switch (method) {
      case 'initialize': {
        const want = params?.protocolVersion;
        reply({
          protocolVersion: MCP_VERSIONS.includes(want) ? want : MCP_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'nodal', version: VERSION },
          instructions: catalog.guide,
        });
        return;
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return;
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: mcpTools() });
      case 'tools/call': {
        const name = params?.name;
        const m = byTool.get(name);
        if (!m) return reply({ content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true });
        const res = await call(m, params?.arguments ?? {});
        return reply(toolResult(res));
      }
      case 'resources/list':
        return reply({ resources: [] });
      case 'prompts/list':
        return reply({ prompts: [] });
      default:
        if (id !== undefined) fail(-32601, `Method not found: ${method}`);
    }
  });
  rl.on('close', () => process.exit(0));
}

/* ------------------------------------------------------------------ */
/* Command line                                                        */
/* ------------------------------------------------------------------ */

async function main() {
  const [cmd = 'serve', ...rest] = process.argv.slice(2).filter((a, i, all) => a !== '--port' && all[i - 1] !== '--port');
  switch (cmd) {
    case 'serve': {
      const b = new Bridge();
      await b.listen().catch((e) => {
        log(e.code === 'EADDRINUSE' ? `port ${PORT} is in use (a bridge already running? set NODAL_AGENT_PORT)` : e.message);
        process.exit(1);
      });
      log(`token file: ${TOKEN_FILE}`);
      log('in Nodal: File → AI agent link');
      return;
    }
    case 'mcp':
      return runMcp();
    case 'call': {
      const [method, raw] = rest;
      if (!method) throw new Error('usage: nodal-agent call <method> [json-params | @file.json | -]');
      // params inline, from a file, or from stdin ("-"): shells such as PowerShell mangle quotes in inline JSON
      const text = raw === '-' ? readFileSync(0, 'utf8') : raw?.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw;
      const params = text ? JSON.parse(text) : {};
      const b = await connectBridge();
      const res = await b.call(method, params);
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      process.exit(res.error ? 1 : 0);
      return;
    }
    case 'methods':
      for (const m of catalog.methods) process.stdout.write(`${m.name.padEnd(24)} ${m.summary}\n`);
      return;
    case 'schema':
      process.stdout.write(`${JSON.stringify(mcpTools(), null, 2)}\n`);
      return;
    case 'events': {
      const b = await connectBridge();
      b.events((e) => process.stdout.write(`${JSON.stringify(e)}\n`));
      return;
    }
    case 'token':
      process.stdout.write(`${ensureToken()}\n`);
      return;
    default:
      process.stderr.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
      process.exit(2);
  }
}

const isMain = () => {
  try {
    return !!process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
};

if (isMain()) {
  main().catch((e) => {
    log(e.message);
    process.exit(1);
  });
}
