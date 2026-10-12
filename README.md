# Nodal — circuit & schematic designer

[![CI](https://github.com/JPMarcelino/nodal/actions/workflows/ci.yml/badge.svg)](https://github.com/JPMarcelino/nodal/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/JPMarcelino/nodal)](https://github.com/JPMarcelino/nodal/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Nodal is a fast, good-looking schematic editor. It's one React + TypeScript codebase that runs as:

- a **desktop app for Windows and Linux** (Tauri: small native installers, built by GitHub Actions), and
- a **web app**: <https://jpmarcelino.github.io/nodal/>

![Nodal editor](docs/screenshot.png)

**Download:** [latest release](https://github.com/JPMarcelino/nodal/releases/latest). On Windows use the `.msi` or `-setup.exe`; on Linux use the `.AppImage` (`chmod +x`, then run it), `.deb` or `.rpm`.

## Features

### Symbol library (~240 parts)
- **Passive:** resistors (US and IEC), variable resistors, potentiometers, trimmers, NTC/PTC thermistors, LDRs, varistors, resistor networks, 4-terminal current-sense resistors, capacitors (ceramic, polarized, bipolar, variable), inductors, coupled inductors, ferrite beads, transformers (center-tapped, dual secondary), crystals, resonators, fuses, polyfuses, spark gaps, gas discharge tubes, antennas
- **Semiconductors:** diodes, dual diodes, LEDs, Zener, Schottky, tunnel, TVS, varactor, photodiode, laser diode, DIAC, bridge rectifier, NPN/PNP (plain and circled), Darlington, phototransistor, N/P MOSFETs, depletion MOSFET, N/P JFETs, IGBT, SCR, TRIAC, UJT, optocouplers (transistor and TRIAC output), gate driver, vacuum tubes (triode, pentode)
- **ICs and analog:** op-amps (single and dual), comparator, TL431 shunt reference, voltage reference, LDO with enable, oscillator module, instrumentation amp, 555, linear and adjustable regulators, buck converter, generic 8/14/16-pin ICs, ATmega328P, generic MCU, EEPROM, ADC, DAC, H-bridge, USB-UART
- **Logic:** AND/NAND/OR/NOR/XOR/XNOR (2, 3 and 4 inputs), Schmitt NAND, NOT, buffers, Schmitt triggers, tri-state, D/JK/T flip-flops, SR latch, multiplexers, demux, 3→8 decoder, adders, counter, 74HC595, clock source, tie-high/low
- **Power and sources:** ground (signal, chassis, earth), supply rails, cells and batteries, DC/AC/pulse/current sources, dependent sources (including a 4-terminal VCCS), solar cell, generator, power flag
- **Switches and relays:** SPST, SPDT, DPST, DPDT, push buttons (NO/NC, 4-pin tactile), rotary encoder, reed, limit, rotary, DIP, relay coil, SPDT/DPDT/solid-state relays, breaker, contactor, thermal switch, e-stop
- **Output and sensors:** lamp, neon lamp, photo interrupter, RGB LED, 7-segment, buzzer, speaker, microphone, piezo, DC/AC/stepper motors, servo, solenoid, heater, fan, bell, headphones, thermocouple, Hall, temperature, PIR, ultrasonic, IMU, LCD 16×2, OLED
- **Meters and test:** volt/am/ohm/watt meters, galvanometer, oscilloscope, frequency counter, function generator, test point, probe
- **Connectors and labels:** net labels, global labels, in/out/bidirectional ports, off-page connector, no-connect flag, terminals, terminal blocks, pin headers (1×2 to 1×12, 2×3 to 2×10), D-sub 9, SMA, bus entry, DC jack, 3.5 mm audio jack, USB, USB-C, RJ45, BNC, plug and socket, banana jack, mounting hole, fiducial

You can search the library, mark favourites (★), and see recently used parts. Click a part to place it, or drag it onto the canvas.

### Symbol types (several drawings per part)
Many parts can be drawn more than one way. A symbol with types shows a small **types badge** on its tile; **hover** it for a clean popup preview, and **click** it to open a type picker (e.g. N- and P-channel MOSFETs ship with **Type A · standard**, **Type B · source arrow** and **Type C · simplified/gate-bubble**, and diodes, capacitors and inductors have alternates too). The same preview appears on hover in the command palette, and the type travels with the part.

### Making your own symbols
Open the symbol editor with **Ctrl+Shift+N**, the **+ New** button, or **Customise symbol** on any part:
- **Draw:** lines, polylines/polygons, rectangles, circles and text on a grid, plus pins that snap onto the symbol outline
- **Chip / IC builder:** type the pin names for each side and the box, leads, labels and pin numbers are generated
- **Import SVG:** paste or load an SVG; it is converted and scaled to fit
- **Code:** a short text format, for precise edits
- **Drawing type:** set *“Drawing type”* to an existing symbol to save your drawing as a **new type** of it — it then appears in that part's type picker, and you can manage (edit/delete) the other types from the same panel. Everything in the editor snaps to the same 10 px grid.

Your symbols are kept in *My symbols*. Every circuit file also stores a copy of the symbols it uses, so files open correctly on other machines.

### Sharing & collaboration
**Live collaboration.** Click **Share** in the top bar, then **Start live session**. A link is copied for you; anyone who opens it edits the same circuit with you in real time:
- Everyone's **cursor and name** are shown live, along with what they have selected. Pick your own name and colour in the Share dialog.
- The avatars in the top bar show who is here. **Click someone's avatar to follow their view**; panning or zooming yourself stops following.
- **Undo only undoes your own edits**, never someone else's.
- The session is **end-to-end encrypted**. The key is in the part of the link after `#`, which never reaches the server, so only people with the link can read the circuit. The room keeps an encrypted copy, so the link still works after everyone has left (rooms nobody touches for 90 days are deleted).
- In the desktop app, paste a session link into *Share → Join*.

The relay is a small Cloudflare Worker in [`collab-server/`](collab-server).

You can also share without a live session. Open **File → Share & collaborate…** to:
- **Share your whole symbol library** as copy-paste text or a `.json` file, and import someone else's (imports *merge*, never overwrite).
- **Share any part of a circuit as a reusable template** — select it and send it; the template carries its parts, wiring and custom symbols, and lands correctly on another machine.

### Wiring
- Drag from any pin to draw a wire, or press **W** and click to add bends. Wires stay orthogonal; press **Space** to flip the elbow and **Backspace** to remove the last bend.
- Ending a wire on another wire creates a **junction** automatically. **Alt-drag** on a wire starts a branch from it.
- **Crossings hop:** where wires cross without connecting, a small arc is drawn (you can switch to a gap or a plain crossing).
- Junction dots appear wherever three or more conductors meet. Deleting a branch merges the remaining wire back into one.
- To reshape a selected wire, drag one of its segments. To reconnect it, drag an end handle.
- **Wire style is fully customisable**, both per wire and as the document default: colour, thickness, sharp or rounded corners (with a radius), and solid/dashed/dotted lines. "Use for new wires" turns the current style into a brush, and "Apply style to whole net" restyles a net in one click.
- Wire labels (net names): **drag a label along its wire, onto any other wire of the same net, and to either side** (above, below, left, right), set its side and position in the inspector, or hide it while it still names the net. Net-label, port and rail symbols can hide their name too, and their name can be dragged.
- Net highlighting (**N**), and a list of the pins on each net
- Unconnected pins are marked, so dangling connections are easy to spot

### Zones, shapes and annotation
- Outline **rectangles** (**B**) and **filled zones** (**Z**) for highlighting areas, each with an optional title. They sit **behind wires** by default; switch one to *Above all* (**Ctrl+Alt+L**) if needed.
- Ellipses, lines, arrows and free text
- Stroke, fill, opacity, corner radius and dash settings; z-ordering within each layer
- Locking a zone lets clicks pass through it

### Checking the circuit
- **Check tab** (**Ctrl+Alt+R**): a live electrical rules check. It lists unconnected pins (open power pins are errors), duplicate reference designators, supply rails shorted together, net labels used only once, nets that reach a single pin, loose wire ends, wire ends touching something without connecting, no-connect flags on wired pins, and parts stacked on the same spot. Markers show each problem on the canvas; click one to select and zoom to it. Put a **no-connect flag** (**Shift+X**) on pins you leave open on purpose.
- **Find** (**Ctrl+F**): jump to any part (by reference, value or any field), net, label or text.
- Pins of two parts that touch are connected, just as if a wire joined them.

### Part details and manufacturing
- Every part has **footprint, manufacturer, part number, supplier, supplier part number and datasheet** fields (the datasheet opens from the inspector), plus any **fields of your own**.
- **Do not populate**: the part stays in the drawing (dimmed, tagged DNP) but is left out of the SPICE netlist and listed separately in the BOM.

### Drawing frame and title block
Turn on **Drawing frame** in the document properties for a sheet border with zone markers (1, 2, 3… / A, B, C…) and a title block (company, title, description, author, date, size, revision, sheet number). Sizes A5–A0, US Letter/Legal/Tabloid and ANSI C–E, landscape or portrait. With a frame, exports use the sheet as the page and printing uses its paper size.

### Maths (LaTeX)
Write `$…$` for inline maths or `$$…$$` for display maths in free text, zone/shape titles, wire labels and part values, e.g. `$f_c = \frac{1}{2\pi RC}$` or `$R_{load}$`. Formulas are typeset with MathJax as vector paths, so they look the same in SVG, PNG and PDF exports. Type `\$` for a literal dollar sign.

### Organising
- **Groups** (**Ctrl+G** / **Ctrl+Shift+G**), including nested groups. Double-click a grouped item to enter the group.
- **Layers** panel: tree of groups and items, with show/hide and lock
- Align and distribute, rotate (**R**), flip (**X**/**Y**), nudge with the arrow keys
- Copy/paste between windows (the clipboard holds JSON); **Ctrl+V pastes under the mouse pointer**, **Ctrl+Shift+V** pastes next to the original; duplicate
- Automatic reference designators (R1, C2…), plus a renumber command
- Box select: drag right to select items fully inside, drag left to select anything touched

### Files and export
- Native open/save dialogs on desktop (`.nodal` files), with autosave and restore
- Export to **PNG** (1–4×, light/dark), **SVG**, **DXF** (layered, for AutoCAD/LibreCAD), **SPICE netlist** (correct transistor pin order, engineering values such as `4k7` converted), **KiCad netlist** (parts, footprints and nets for PCB layout), **bill of materials (CSV)** with footprints, part numbers and DNP, and **JSON**; print or save as PDF
- Buses: draw a thick wire as the bus and attach signals with **bus entry** symbols; signals connect by their net labels
- Copy the selection as SVG to paste into other apps

### Interface
- Dark and light themes, compact/normal/large UI sizes, minimap, focus mode
- **Command palette** (**Ctrl+K**): run any command or place any part by name
- **Customisable keyboard shortcuts** (Settings → Keyboard shortcuts)

## Keyboard shortcuts

Press **?** in the app for the full list. You can rebind any shortcut in Settings.

| Action | Keys | Action | Keys |
| --- | --- | --- | --- |
| Select / Pan tool | `V` / `H` (or hold `Space`) | Wire tool | `W` |
| Rectangle / Zone | `B` / `Z` | Ellipse / Line / Arrow / Text | `O` / `L` / `A` / `T` |
| Rotate / Rotate back | `R` / `Alt+R` | Flip horizontal / vertical | `X` / `Y` |
| Group / Ungroup | `Ctrl+G` / `Ctrl+Shift+G` | Lock | `Ctrl+Shift+L` |
| Copy / Cut / Paste / Duplicate | `Ctrl+C` / `Ctrl+X` / `Ctrl+V` / `Ctrl+D` | Delete | `Del` / `Backspace` |
| Undo / Redo | `Ctrl+Z` / `Ctrl+Shift+Z` or `Ctrl+Y` | Select all | `Ctrl+A` |
| Place resistor / capacitor | `Shift+R` / `Shift+C` | Place ground / supply / net label | `Shift+G` / `Shift+V` / `Shift+L` |
| Place last used part | `P` | Search library | `/` |
| Zoom in / out / fit / 100% | `=` / `-` / `F` / `Ctrl+0` | Zoom to selection | `Shift+2` |
| Grid / Snap | `G` / `Ctrl+'` | Minimap | `M` |
| Zone above/behind wires | `Ctrl+Alt+L` | Bring forward / back | `Ctrl+]` / `Ctrl+[` |
| Align left/right/top/bottom | `Alt+←/→/↑/↓` | Distribute H / V | `Alt+Shift+H` / `Alt+Shift+V` |
| Highlight net | `N` | Re-route wire | `Shift+W` |
| Command palette | `Ctrl+K` | Save / Open / Export | `Ctrl+S` / `Ctrl+O` / `Ctrl+E` |
| Find | `Ctrl+F` | Check circuit | `Ctrl+Alt+R` |
| New symbol | `Ctrl+Shift+N` | Library / Properties panel | `Ctrl+B` / `Ctrl+I` |

## Development

```bash
npm install
npm run dev        # web app at http://localhost:1420
npm test           # unit tests (geometry, junctions, symbol grid checks)
npm run tauri dev  # desktop app (needs Rust + the Tauri system dependencies)
```

Releases are built by GitHub Actions. Pushing a `v*` tag runs `.github/workflows/release.yml`, which builds the Windows (MSI/NSIS) and Linux (AppImage/deb/rpm) installers and attaches them to a GitHub release. Every push to `main` redeploys the web app to GitHub Pages.

### Adding a built-in symbol
Symbols use a small drawing language (see `src/model/symbols/dsl.ts`):

```ts
sym('resistor', 'Resistor', 'Passive', {
  w: 80, h: 20, prefix: 'R', value: '10kΩ',
  draw: 'L 0 10 20 10 23 3 30 17 37 3 43 17 50 3 57 17 60 10 80 10',
  ports: '1:0,10 2:80,10',
});
```

For box-style parts, `chip()` in `src/model/symbols/chip.ts` takes pin-name lists. A test checks that every symbol's pins land on the 10 px grid.

## Credits

Nodal began as a copy of the MIT-licensed [ngDiagram electric-circuit template](https://github.com/synergycodes/ng-diagram-electric-circuit) by Synergy Codes and was then rewritten in React.
