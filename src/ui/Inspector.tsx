import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  BringToFront,
  FlipHorizontal2,
  FlipVertical2,
  Group,
  Lock,
  Pencil,
  RotateCcw,
  RotateCw,
  SendToBack,
  Ungroup,
} from 'lucide-react';
import { useMemo } from 'react';
import { defaultHeadSize, measureText } from '../canvas/Scene';
import { SymbolPreview } from '../canvas/SymbolGraphic';
import { computeNets, netOfWire } from '../model/netlist';
import { getSymbol } from '../model/registry';
import type { ComponentItem, Dash, DocSettings, HeadKind, ShapeItem, WireItem, WireStyle } from '../model/types';
import * as A from '../store/actions';
import { S, mutate, set, toast, useStore } from '../store/store';
import { ColorInput, Field, NumberInput, Section, Segmented, Slider, TextInput, Toggle } from './controls';

const DASHES: { value: Dash; label: string }[] = [
  { value: 'solid', label: 'Solid' },
  { value: 'dashed', label: 'Dashed' },
  { value: 'dotted', label: 'Dotted' },
];

const HEAD_TITLES: Record<HeadKind, string> = {
  none: 'None — plain end',
  open: 'Open — V arrowhead',
  filled: 'Solid — filled triangle',
  circle: 'Dot',
  bar: 'Bar — perpendicular tick',
};

/** Tiny preview of an arrowhead; `flip` points it left (for the start end). */
function HeadIcon({ kind, flip }: { kind: HeadKind; flip?: boolean }) {
  const head =
    kind === 'open' ? <path d="M15 2.5L20 6L15 9.5" fill="none" /> :
    kind === 'filled' ? <path d="M14.5 2.5L20.5 6L14.5 9.5Z" fill="currentColor" /> :
    kind === 'circle' ? <circle cx="18.5" cy="6" r="2.5" fill="currentColor" stroke="none" /> :
    kind === 'bar' ? <path d="M20 2v8" /> :
    null;
  return (
    <svg width={22} height={12} viewBox="0 0 22 12" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', margin: '0 auto', transform: flip ? 'scaleX(-1)' : undefined }}>
      <path d={`M2 6H${kind === 'filled' ? 16 : kind === 'circle' ? 17 : 20}`} />
      {head}
    </svg>
  );
}

const headOptions = (flip: boolean) =>
  (Object.keys(HEAD_TITLES) as HeadKind[]).map((k) => ({ value: k, label: <HeadIcon kind={k} flip={flip} />, title: HEAD_TITLES[k] }));

function ArrangeBar({ count }: { count: number }) {
  return (
    <div className="arrange-bar">
      <button title="Rotate counter-clockwise (Alt+R)" onClick={() => A.rotateSelection(-90)}>
        <RotateCcw size={15} />
      </button>
      <button title="Rotate clockwise (R)" onClick={() => A.rotateSelection(90)}>
        <RotateCw size={15} />
      </button>
      <button title="Flip horizontally (X)" onClick={() => A.flipSelection('x')}>
        <FlipHorizontal2 size={15} />
      </button>
      <button title="Flip vertically (Y)" onClick={() => A.flipSelection('y')}>
        <FlipVertical2 size={15} />
      </button>
      <span className="sep" />
      <button title="Group (Ctrl+G)" disabled={count < 2} onClick={A.groupSelection}>
        <Group size={15} />
      </button>
      <button title="Ungroup (Ctrl+Shift+G)" onClick={A.ungroupSelection}>
        <Ungroup size={15} />
      </button>
      <button title="Lock / unlock (Ctrl+Shift+L)" onClick={A.toggleLock}>
        <Lock size={15} />
      </button>
    </div>
  );
}

function AlignBar() {
  return (
    <div className="arrange-bar">
      <button title="Align left (Alt+←)" onClick={() => A.align('left')}>
        <AlignStartVertical size={15} />
      </button>
      <button title="Align centres horizontally (Alt+H)" onClick={() => A.align('hcenter')}>
        <AlignCenterVertical size={15} />
      </button>
      <button title="Align right (Alt+→)" onClick={() => A.align('right')}>
        <AlignEndVertical size={15} />
      </button>
      <button title="Align top (Alt+↑)" onClick={() => A.align('top')}>
        <AlignStartHorizontal size={15} />
      </button>
      <button title="Align centres vertically (Alt+V)" onClick={() => A.align('vcenter')}>
        <AlignCenterHorizontal size={15} />
      </button>
      <button title="Align bottom (Alt+↓)" onClick={() => A.align('bottom')}>
        <AlignEndHorizontal size={15} />
      </button>
      <span className="sep" />
      <button title="Distribute horizontally (Alt+Shift+H)" onClick={() => A.distribute('x')}>
        <AlignHorizontalDistributeCenter size={15} />
      </button>
      <button title="Distribute vertically (Alt+Shift+V)" onClick={() => A.distribute('y')}>
        <AlignVerticalDistributeCenter size={15} />
      </button>
    </div>
  );
}

function WireStyleEditor({ style, onChange, showBrush }: { style: WireStyle; onChange: (p: Partial<WireStyle>) => void; showBrush?: boolean }) {
  return (
    <>
      <Field label="Colour">
        <ColorInput value={style.color} onChange={(color) => onChange({ color })} />
      </Field>
      <Field label="Thickness">
        <NumberInput value={style.width} min={0.5} max={20} step={0.5} suffix="px" onChange={(width) => onChange({ width })} />
      </Field>
      <Field label="Corners">
        <Segmented
          value={style.radius > 0 ? 'round' : 'sharp'}
          options={[
            { value: 'sharp', label: 'Sharp' },
            { value: 'round', label: 'Rounded' },
          ]}
          onChange={(v) => onChange({ radius: v === 'round' ? Math.max(style.radius, 8) : 0 })}
        />
      </Field>
      {style.radius > 0 && (
        <Field label="Radius">
          <NumberInput value={style.radius} min={1} max={60} suffix="px" onChange={(radius) => onChange({ radius })} />
        </Field>
      )}
      <Field label="Line">
        <Segmented value={style.dash} options={DASHES} onChange={(dash) => onChange({ dash })} />
      </Field>
      {showBrush && null}
    </>
  );
}

function DocumentPanel() {
  const settings = useStore((s) => s.doc.settings);
  const items = useStore((s) => s.doc.items);
  const name = useStore((s) => s.doc.name);
  const upd = (fn: (s: DocSettings) => void) => mutate((d) => fn(d.settings));
  const counts = useMemo(() => {
    const c = { component: 0, wire: 0, shape: 0, junction: 0 };
    for (const i of Object.values(items)) c[i.type]++;
    return c;
  }, [items]);
  return (
    <>
      <Section title="Circuit">
        <Field label="Name">
          <TextInput value={name} onChange={(v) => mutate((d) => void (d.name = v || 'Untitled circuit'))} />
        </Field>
        <Field label="Author">
          <TextInput value={settings.author} onChange={(v) => upd((s) => (s.author = v))} placeholder="Your name" />
        </Field>
        <Field label="Revision">
          <TextInput value={settings.revision} onChange={(v) => upd((s) => (s.revision = v))} />
        </Field>
        <div className="stats">
          <span>
            <b>{counts.component}</b> parts
          </span>
          <span>
            <b>{counts.wire}</b> wires
          </span>
          <span>
            <b>{counts.junction}</b> junctions
          </span>
          <span>
            <b>{counts.shape}</b> shapes
          </span>
        </div>
      </Section>
      <Section title="Default wire style">
        <WireStyleEditor style={settings.wire} onChange={(p) => upd((s) => Object.assign(s.wire, p))} />
        <Field label="Crossings">
          <Segmented
            value={settings.hops}
            options={[
              { value: 'arc', label: 'Hop', title: 'Draw a small arc where wires cross' },
              { value: 'gap', label: 'Gap', title: 'Break the wire where it crosses' },
              { value: 'none', label: 'Plain' },
            ]}
            onChange={(hops) => upd((s) => (s.hops = hops))}
          />
        </Field>
        {settings.hops !== 'none' && (
          <Field label="Hop size">
            <NumberInput value={settings.hopSize} min={2} max={20} suffix="px" onChange={(v) => upd((s) => (s.hopSize = v))} />
          </Field>
        )}
        <Field label="Junction dot">
          <NumberInput value={settings.junctionSize} min={1} max={12} step={0.5} suffix="px" onChange={(v) => upd((s) => (s.junctionSize = v))} />
        </Field>
        <button
          className="secondary-btn full"
          onClick={() => {
            mutate((d) => Object.values(d.items).forEach((i) => i.type === 'wire' && delete (i as WireItem).style));
            toast('All wires now use the default style');
          }}
        >
          Reset all wires to default style
        </button>
      </Section>
      <Section title="Canvas">
        <Field label="Grid">
          <NumberInput value={settings.grid} min={2} max={100} suffix="px" onChange={(v) => upd((s) => (s.grid = v))} />
        </Field>
        <Field label="Show grid">
          <Toggle checked={settings.showGrid} onChange={(v) => upd((s) => (s.showGrid = v))} />
        </Field>
        <Field label="Snap to grid">
          <Toggle checked={settings.snap} onChange={(v) => upd((s) => (s.snap = v))} />
        </Field>
        <Field label="Symbol colour">
          <ColorInput value={settings.componentColor} allowNone onChange={(v) => upd((s) => (s.componentColor = v))} />
        </Field>
        <Field label="Label colour">
          <ColorInput value={settings.labelColor} allowNone onChange={(v) => upd((s) => (s.labelColor = v))} />
        </Field>
        <Field label="Background">
          <ColorInput value={settings.background} allowNone onChange={(v) => upd((s) => (s.background = v))} />
        </Field>
      </Section>
      <div className="inspector-tip">
        Tip: select something to edit it. Press <kbd>?</kbd> for all shortcuts, <kbd>Ctrl+K</kbd> for the command palette.
      </div>
    </>
  );
}

function ComponentPanel({ c }: { c: ComponentItem }) {
  const doc = useStore((s) => s.doc);
  const def = getSymbol(doc, c.symbol);
  const upd = (fn: (c: ComponentItem) => void) => mutate((d) => fn(d.items[c.id] as ComponentItem));
  const nets = useMemo(() => computeNets(doc), [doc]);
  return (
    <>
      <div className="comp-header">
        <div className="comp-preview">
          <SymbolPreview def={def} size={64} ports />
        </div>
        <div>
          <div className="comp-title">{def.valueIsLabel ? c.value : c.ref}</div>
          <div className="comp-sub">{def.name}</div>
          <button className="link-btn" onClick={() => set({ dialog: 'symbol-editor', editingSymbol: def.id })}>
            <Pencil size={11} /> {def.custom ? 'Edit symbol' : 'Customise symbol'}
          </button>
        </div>
      </div>
      <ArrangeBar count={1} />
      <Section title="Properties">
        {!def.valueIsLabel && (
          <Field label="Reference">
            <TextInput value={c.ref} onChange={(v) => upd((x) => (x.ref = v))} />
          </Field>
        )}
        <Field label={def.valueIsLabel ? 'Net name' : 'Value'}>
          <TextInput value={c.value} focusKey="value" onChange={(v) => upd((x) => (x.value = v))} />
        </Field>
        {(def.fields ?? []).map((f) => (
          <Field key={f.key} label={f.label}>
            <TextInput value={c.props[f.key] ?? ''} placeholder={f.default} onChange={(v) => upd((x) => (x.props[f.key] = v))} />
          </Field>
        ))}
        {!def.valueIsLabel && (
          <Field label="Show labels">
            <span className="row-gap">
              <Toggle checked={c.showRef} onChange={(v) => upd((x) => (x.showRef = v))} label="Ref" />
              <Toggle checked={c.showValue} onChange={(v) => upd((x) => (x.showValue = v))} label="Value" />
            </span>
          </Field>
        )}
        {(c.labelDx || c.labelDy) && (
          <button className="secondary-btn full" onClick={() => upd((x) => ((x.labelDx = 0), (x.labelDy = 0)))}>
            Reset label position
          </button>
        )}
      </Section>
      <Section title="Appearance">
        <Field label="Rotation">
          <Segmented
            value={c.rot}
            options={[0, 90, 180, 270].map((r) => ({ value: r as ComponentItem['rot'], label: `${r}°` }))}
            onChange={(rot) => upd((x) => (x.rot = rot))}
          />
        </Field>
        <Field label="Mirrored">
          <Toggle checked={!!c.flipX} onChange={(v) => upd((x) => (x.flipX = v))} />
        </Field>
        <Field label="Colour">
          <ColorInput value={c.color ?? ''} allowNone onChange={(v) => upd((x) => (x.color = v || undefined))} />
        </Field>
        <Field label="Position">
          <span className="row-gap">
            <NumberInput value={c.x} step={doc.settings.grid} suffix="x" onChange={(v) => upd((x) => (x.x = v))} />
            <NumberInput value={c.y} step={doc.settings.grid} suffix="y" onChange={(v) => upd((x) => (x.y = v))} />
          </span>
        </Field>
      </Section>
      {def.ports.length > 0 && (
        <Section title={`Pins (${def.ports.length})`}>
          <div className="pin-list">
            {def.ports.map((p) => {
              const net = nets.find((n) => n.pins.some((pin) => pin.comp === c.id && pin.port === p.id));
              const connected = net && (net.pins.length > 1 || net.wires.length > 0);
              return (
                <div key={p.id} className="pin-row">
                  <span className={connected ? 'pin-dot on' : 'pin-dot'} />
                  <span className="pin-name">{p.name}</span>
                  <span className="pin-net">{connected ? net!.name : 'unconnected'}</span>
                </div>
              );
            })}
          </div>
        </Section>
      )}
    </>
  );
}

function WirePanel({ wires }: { wires: WireItem[] }) {
  const doc = useStore((s) => s.doc);
  const brush = useStore((s) => s.wireBrush);
  const first = wires[0];
  const style = { ...doc.settings.wire, ...first.style };
  const ids = wires.map((w) => w.id);
  const upd = (p: Partial<WireStyle>) => mutate((d) => ids.forEach((id) => ((d.items[id] as WireItem).style = { ...(d.items[id] as WireItem).style, ...p })));
  const net = useMemo(() => netOfWire(computeNets(doc), first.id), [doc, first.id]);
  return (
    <>
      <div className="panel-title">
        {wires.length > 1 ? `${wires.length} wires` : 'Wire'}
        {net && <span className="net-chip">net {net.name}</span>}
      </div>
      <Section title="Style">
        <WireStyleEditor style={style} onChange={upd} />
        <Field label="Routing">
          <Segmented
            value={first.routing ?? 'ortho'}
            options={[
              { value: 'ortho', label: 'Elbows', title: 'Right-angle elbows only' },
              { value: 'straight', label: 'Direct', title: 'Allow diagonal segments' },
            ]}
            onChange={(v) => mutate((d) => ids.forEach((id) => ((d.items[id] as WireItem).routing = v)))}
          />
        </Field>
        <Field label="Crossings" hint="Rest the pointer on a crossing to choose which wire hops over, or to solder it">
          <span className="muted small">{first.hopLayer ? `stacking layer ${first.hopLayer > 0 ? '+' : ''}${first.hopLayer}` : 'automatic'}</span>
        </Field>
        <div className="btn-row">
          <button className="secondary-btn" onClick={() => mutate((d) => ids.forEach((id) => delete (d.items[id] as WireItem).style))}>
            Use default
          </button>
          <button
            className={brush ? 'secondary-btn active' : 'secondary-btn'}
            title="New wires will be drawn with this style"
            onClick={() => {
              set({ wireBrush: brush ? null : { ...first.style } });
              toast(brush ? 'New wires use the default style' : 'New wires will use this style');
            }}
          >
            {brush ? 'Stop using for new wires' : 'Use for new wires'}
          </button>
        </div>
        <button
          className="secondary-btn full"
          onClick={() => {
            if (!net) return;
            mutate((d) => net.wires.forEach((id) => d.items[id] && ((d.items[id] as WireItem).style = { ...first.style })));
            toast(`Applied to all ${net.wires.length} wires of net ${net.name}`);
          }}
        >
          Apply style to whole net
        </button>
      </Section>
      {wires.length === 1 && (
        <Section title="Label">
          <Field label="Text">
            <TextInput value={first.label ?? ''} focusKey="value" placeholder="e.g. SDA, 5V, CLK" onChange={(v) => mutate((d) => void ((d.items[first.id] as WireItem).label = v || undefined))} />
          </Field>
        </Section>
      )}
      {net && (
        <Section title="Net">
          <div className="pin-list">
            {net.pins.map((p) => (
              <div key={`${p.comp}:${p.port}`} className="pin-row">
                <span className="pin-dot on" />
                <span className="pin-name">{p.ref}</span>
                <span className="pin-net">pin {p.portName}</span>
              </div>
            ))}
            {!net.pins.length && <div className="empty-note small">No component pins on this net yet.</div>}
          </div>
          <div className="btn-row">
            <button className="secondary-btn" onClick={() => set({ selection: net.wires })}>
              Select net
            </button>
            <button className="secondary-btn" onClick={() => set({ highlight: S().highlight ? null : new Set(net.wires) })}>
              Highlight (N)
            </button>
          </div>
        </Section>
      )}
    </>
  );
}

function ShapePanel({ shapes }: { shapes: ShapeItem[] }) {
  const first = shapes[0];
  const ids = shapes.map((s) => s.id);
  const upd = (fn: (s: ShapeItem) => void) =>
    mutate((d) =>
      ids.forEach((id) => {
        const s = d.items[id] as ShapeItem;
        fn(s);
        if (s.kind === 'text') Object.assign(s, measureText(s.text ?? '', s.fontSize ?? 16));
      }),
    );
  const isText = first.kind === 'text';
  const isLine = first.kind === 'line' || first.kind === 'arrow';
  const title = { rect: 'Rectangle', zone: 'Filled zone', ellipse: 'Ellipse', line: 'Line', arrow: 'Arrow', text: 'Text' }[first.kind];
  return (
    <>
      <div className="panel-title">{shapes.length > 1 ? `${shapes.length} shapes` : title}</div>
      <Section title={isText ? 'Text' : 'Label'}>
        <Field label={isText ? 'Content' : 'Title'} wide>
          <TextInput value={first.text ?? ''} multiline={isText} focusKey="value" onChange={(v) => upd((s) => (s.text = v))} placeholder={isText ? '' : 'Optional title'} />
        </Field>
        <Field label="Font size">
          <NumberInput value={first.fontSize ?? (isText ? 16 : 13)} min={6} max={120} suffix="px" onChange={(v) => upd((s) => (s.fontSize = v))} />
        </Field>
        <Field label="Bold">
          <Toggle checked={first.bold ?? !isText} onChange={(v) => upd((s) => (s.bold = v))} />
        </Field>
        <Field label="Text colour">
          <ColorInput value={first.textColor ?? ''} allowNone onChange={(v) => upd((s) => (s.textColor = v || undefined))} />
        </Field>
      </Section>
      {!isText && (
        <Section title="Stroke">
          <Field label="Colour">
            <ColorInput value={first.stroke} onChange={(v) => upd((s) => (s.stroke = v))} />
          </Field>
          <Field label="Width">
            <NumberInput value={first.strokeWidth} min={0} max={30} step={0.5} suffix="px" onChange={(v) => upd((s) => (s.strokeWidth = v))} />
          </Field>
          <Field label="Line">
            <Segmented value={first.dash} options={DASHES} onChange={(v) => upd((s) => (s.dash = v))} />
          </Field>
          {isLine && (
            <>
              <Field label="Start">
                <Segmented value={first.headStart ?? 'none'} options={headOptions(true)} onChange={(v) => upd((s) => (s.headStart = v))} />
              </Field>
              <Field label="End">
                <Segmented value={first.headEnd ?? (first.kind === 'arrow' ? 'open' : 'none')} options={headOptions(false)} onChange={(v) => upd((s) => (s.headEnd = v))} />
              </Field>
              <Field label="Head size">
                <NumberInput value={first.headSize ?? defaultHeadSize(first.strokeWidth)} min={2} max={80} suffix="px" onChange={(v) => upd((s) => (s.headSize = v))} />
              </Field>
            </>
          )}
          {(first.kind === 'rect' || first.kind === 'zone') && (
            <Field label="Corner radius">
              <NumberInput value={first.radius} min={0} max={200} suffix="px" onChange={(v) => upd((s) => (s.radius = v))} />
            </Field>
          )}
        </Section>
      )}
      {!isLine && (
        <Section title="Fill">
          <Field label="Colour">
            <ColorInput value={first.fill === 'none' ? '' : first.fill} allowNone onChange={(v) => upd((s) => ((s.fill = v || 'none'), v && s.fillOpacity === 0 && (s.fillOpacity = 0.15)))} />
          </Field>
          <Field label="Opacity">
            <span className="row-gap">
              <Slider value={first.fillOpacity} min={0} max={1} onChange={(v) => upd((s) => (s.fillOpacity = v))} />
              <span className="mono small">{Math.round(first.fillOpacity * 100)}%</span>
            </span>
          </Field>
        </Section>
      )}
      <Section title="Layer">
        <Field label="Draw">
          <Segmented
            value={first.layer}
            options={[
              { value: 'below', label: 'Behind', title: 'Behind wires and components' },
              { value: 'above', label: 'On top', title: 'Above everything' },
            ]}
            onChange={(v) => upd((s) => (s.layer = v))}
          />
        </Field>
        <div className="arrange-bar">
          <button title="Bring to front (Ctrl+Shift+])" onClick={() => A.reorder('front')}>
            <BringToFront size={15} />
          </button>
          <button title="Send to back (Ctrl+Shift+[)" onClick={() => A.reorder('back')}>
            <SendToBack size={15} />
          </button>
          <button title="Lock (Ctrl+Shift+L) — locked zones let clicks pass through" onClick={A.toggleLock}>
            <Lock size={15} />
          </button>
        </div>
      </Section>
      {shapes.length === 1 && !isText && (
        <Section title="Geometry">
          <Field label="Position">
            <span className="row-gap">
              <NumberInput value={first.x} suffix="x" onChange={(v) => upd((s) => (s.x = v))} />
              <NumberInput value={first.y} suffix="y" onChange={(v) => upd((s) => (s.y = v))} />
            </span>
          </Field>
          <Field label="Size">
            <span className="row-gap">
              <NumberInput value={first.w} suffix="w" onChange={(v) => upd((s) => (s.w = v))} />
              <NumberInput value={first.h} suffix="h" onChange={(v) => upd((s) => (s.h = v))} />
            </span>
          </Field>
        </Section>
      )}
    </>
  );
}

function MultiPanel({ ids }: { ids: string[] }) {
  const doc = useStore((s) => s.doc);
  const items = ids.map((id) => doc.items[id]).filter(Boolean);
  const comps = items.filter((i): i is ComponentItem => i.type === 'component');
  const wires = items.filter((i): i is WireItem => i.type === 'wire');
  const shapes = items.filter((i): i is ShapeItem => i.type === 'shape');
  return (
    <>
      <div className="panel-title">{items.length} items selected</div>
      <div className="stats">
        {comps.length > 0 && (
          <span>
            <b>{comps.length}</b> parts
          </span>
        )}
        {wires.length > 0 && (
          <span>
            <b>{wires.length}</b> wires
          </span>
        )}
        {shapes.length > 0 && (
          <span>
            <b>{shapes.length}</b> shapes
          </span>
        )}
      </div>
      <ArrangeBar count={items.length} />
      <Section title="Align & distribute">
        <AlignBar />
      </Section>
      {comps.length > 0 && (
        <Section title="Parts">
          <Field label="Colour">
            <ColorInput value={comps[0].color ?? ''} allowNone onChange={(v) => mutate((d) => comps.forEach((c) => ((d.items[c.id] as ComponentItem).color = v || undefined)))} />
          </Field>
        </Section>
      )}
      {wires.length > 0 && (
        <Section title="Wires">
          <WireStyleEditor
            style={{ ...doc.settings.wire, ...wires[0].style }}
            onChange={(p) => mutate((d) => wires.forEach((w) => ((d.items[w.id] as WireItem).style = { ...(d.items[w.id] as WireItem).style, ...p })))}
          />
        </Section>
      )}
    </>
  );
}

export function Inspector() {
  const selection = useStore((s) => s.selection);
  const doc = useStore((s) => s.doc);
  const items = selection.map((id) => doc.items[id]).filter(Boolean);
  let body: JSX.Element;
  if (!items.length) body = <DocumentPanel />;
  else if (items.length === 1 && items[0].type === 'component') body = <ComponentPanel c={items[0]} />;
  else if (items.every((i) => i.type === 'wire' || i.type === 'junction') && items.some((i) => i.type === 'wire'))
    body = <WirePanel wires={items.filter((i): i is WireItem => i.type === 'wire')} />;
  else if (items.every((i) => i.type === 'shape')) body = <ShapePanel shapes={items as ShapeItem[]} />;
  else if (items.length === 1 && items[0].type === 'junction') body = <div className="panel-title">Junction</div>;
  else body = <MultiPanel ids={selection} />;
  return (
    <aside className="panel right-panel">
      <div className="tabs">
        <button className="active">{items.length ? 'Properties' : 'Document'}</button>
      </div>
      <div className="inspector-scroll">{body}</div>
    </aside>
  );
}
