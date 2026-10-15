import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { RotateCcw } from 'lucide-react';

// Colour fields: GDD "color-rrggbb" (#rrggbb) and "color-rrggbbaa" (#rrggbbaa, with an opacity slider).
const recentKey = 'grafonaut.recentColors';
const recentLimit = 8;
const listeners = new Set();
let recent = readRecent();

function readRecent() {
  try {
    const stored = JSON.parse(globalThis.localStorage?.getItem(recentKey) ?? '[]');
    return Array.isArray(stored) ? [...new Set(stored.map((color) => parseColor(color)?.rgb).filter(Boolean))].slice(0, recentLimit) : [];
  } catch { return []; }
}

// The last colours picked in this browser, newest first (shared by all colour fields). Stored without opacity: they are
// offered in the browser's colour picker popup, which only knows #rrggbb.
export function rememberColor(color) {
  const parsed = parseColor(color);
  if (!parsed) return;
  const value = parsed.rgb;
  recent = [value, ...recent.filter((candidate) => candidate !== value)].slice(0, recentLimit);
  try { globalThis.localStorage?.setItem(recentKey, JSON.stringify(recent)); } catch { /* private mode: keep it in memory */ }
  listeners.forEach((listener) => listener());
}

export function useRecentColors() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => recent, () => recent);
}

// '#abc', 'abc', '#aabbcc' or '#aabbccdd' -> { rgb: '#aabbcc', alpha: 'dd' } (lowercase); anything else -> null
export function parseColor(value) {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(String(value ?? '').trim());
  if (!match) return null;
  const hex = (match[1].length === 3 ? [...match[1]].map((digit) => digit + digit).join('') : match[1]).toLowerCase();
  return { rgb: `#${hex.slice(0, 6)}`, alpha: hex.slice(6) || 'ff' };
}

// Formats a colour for the field: with alpha for color-rrggbbaa, in upper case if only that matches the field's pattern.
export function formatColor(schema, { rgb, alpha }) {
  const value = schema?.gddType === 'color-rrggbbaa' ? rgb + alpha : rgb;
  if (typeof schema?.pattern === 'string') {
    try {
      const pattern = new RegExp(schema.pattern);
      if (!pattern.test(value) && pattern.test(value.toUpperCase())) return value.toUpperCase();
    } catch { /* invalid pattern: keep lower case */ }
  }
  return value;
}

// '#rrggbb' <-> { h: 0..360, s: 0..1, v: 0..1 }
export function hexToHsv(rgb) {
  const [r, g, b] = [1, 3, 5].map((index) => parseInt(rgb.slice(index, index + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  let h = 0;
  if (delta) h = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return { h: (h * 60 + 360) % 360, s: max ? delta / max : 0, v: max };
}

export function hsvToHex({ h, s, v }) {
  const channel = (n) => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255).toString(16).padStart(2, '0');
  };
  return `#${channel(5)}${channel(3)}${channel(1)}`;
}

const clamp = (number) => Math.min(1, Math.max(0, number));

// Pointer dragging on an area: calls onMove with the position as fractions (0..1) of its width and height.
function dragHandlers(onMove) {
  const move = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    onMove(clamp((event.clientX - rect.left) / (rect.width || 1)), clamp((event.clientY - rect.top) / (rect.height || 1)));
  };
  return {
    onPointerDown: (event) => { event.currentTarget.setPointerCapture?.(event.pointerId); event.currentTarget.focus(); move(event); },
    onPointerMove: (event) => { if (event.currentTarget.hasPointerCapture?.(event.pointerId)) move(event); }
  };
}

// The picker popup: saturation/brightness area, hue bar and the recently picked colours, in one view. It is fixed to the
// viewport next to the swatch (below, or above when there is no room), so the scrolling dialog does not clip it.
function ColorPanel({ title, rgb, onPick, anchor }) {
  const panel = useRef(null);
  useLayoutEffect(() => {
    const place = () => {
      const element = panel.current;
      const target = anchor.current?.getBoundingClientRect();
      if (!element || !target) return;
      const { offsetWidth: width, offsetHeight: height } = element;
      const below = target.bottom + 6;
      const top = below + height > window.innerHeight - 8 && target.top - height - 6 >= 8 ? target.top - height - 6 : below;
      element.style.top = `${Math.max(8, top)}px`;
      element.style.left = `${Math.max(8, Math.min(target.left, window.innerWidth - width - 8))}px`;
      element.style.visibility = 'visible';
    };
    place();
    panel.current?.querySelector('.color-area')?.focus();
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); document.removeEventListener('scroll', place, true); };
  }, [anchor]);
  const [hsv, setHsv] = useState(() => hexToHsv(rgb));
  // Follow changes from outside (typed hex, recent colours) but keep the hue while it cannot be derived (greys, black).
  useEffect(() => { if (hsvToHex(hsv) !== rgb) setHsv(hexToHsv(rgb)); }, [rgb]);
  const recentColors = useRecentColors();
  const update = (changes) => {
    const next = { ...hsv, ...changes };
    setHsv(next);
    onPick(hsvToHex(next));
  };
  const step = (event) => (event.shiftKey ? 0.1 : 0.01);
  const areaKeys = (event) => {
    const moves = { ArrowLeft: { s: hsv.s - step(event) }, ArrowRight: { s: hsv.s + step(event) }, ArrowUp: { v: hsv.v + step(event) }, ArrowDown: { v: hsv.v - step(event) } };
    const change = moves[event.key];
    if (!change) return;
    event.preventDefault();
    update(Object.fromEntries(Object.entries(change).map(([key, number]) => [key, clamp(number)])));
  };
  const hueKeys = (event) => {
    const amount = event.shiftKey ? 10 : 1;
    const hues = { ArrowLeft: hsv.h - amount, ArrowDown: hsv.h - amount, ArrowRight: hsv.h + amount, ArrowUp: hsv.h + amount, Home: 0, End: 359 };
    if (!(event.key in hues)) return;
    event.preventDefault();
    update({ h: Math.min(359, Math.max(0, hues[event.key])) });
  };
  return <div ref={panel} className="color-panel" role="group" aria-label={`${title} picker`}>
    <div className="color-area" style={{ backgroundColor: hsvToHex({ h: hsv.h, s: 1, v: 1 }) }} role="slider" tabIndex={0}
      aria-label="Saturation and brightness" aria-valuetext={`Saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
      onKeyDown={areaKeys} {...dragHandlers((x, y) => update({ s: x, v: 1 - y }))}>
      <span className="color-area-thumb" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: rgb }} />
    </div>
    <div className="color-hue" role="slider" tabIndex={0} aria-label="Hue" aria-valuemin={0} aria-valuemax={359} aria-valuenow={Math.round(hsv.h)}
      onKeyDown={hueKeys} {...dragHandlers((x) => update({ h: Math.min(359, x * 360) }))}>
      <span className="color-hue-thumb" style={{ left: `${(hsv.h / 360) * 100}%`, background: hsvToHex({ h: hsv.h, s: 1, v: 1 }) }} />
    </div>
    {recentColors.length > 0 && <div className="color-recent" role="group" aria-label="Recent colours">
      {recentColors.map((color) => <button key={color} type="button" className={`color-recent-swatch${color === rgb ? ' is-selected' : ''}`}
        title={color} aria-label={`Use ${color}`} aria-pressed={color === rgb} onClick={() => onPick(color)}>
        <span style={{ background: color }} />
      </button>)}
    </div>}
  </div>;
}

export function ColorWidget({ id, value, onChange, schema, disabled, readonly }) {
  const withAlpha = schema.gddType === 'color-rrggbbaa';
  const current = parseColor(value);
  const fallback = typeof schema.default === 'string' && parseColor(schema.default) ? schema.default : '';
  const title = schema.title ?? 'a colour';
  const [text, setText] = useState(value ?? '');
  useEffect(() => { setText(value ?? ''); }, [value]);
  const [open, setOpen] = useState(false);
  const field = useRef(null);
  const swatch = useRef(null);
  // A colour counts as picked when the panel closes (or the dialog with it), not on every move.
  const session = useRef({ open: false, start: null, latest: value });
  session.current.latest = value;
  const locked = disabled || readonly;
  const rgb = current?.rgb ?? '#000000';
  const alpha = current?.alpha ?? 'ff';
  const set = (color) => onChange(formatColor(schema, color));

  function openPanel() {
    session.current = { open: true, start: value, latest: value };
    setOpen(true);
  }
  function closePanel() {
    const { open: wasOpen, start, latest } = session.current;
    session.current.open = false;
    if (wasOpen && latest !== start) rememberColor(latest);
    setOpen(false);
  }
  useEffect(() => () => { if (session.current.open && session.current.latest !== session.current.start) rememberColor(session.current.latest); }, []);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event) => { if (!field.current?.contains(event.target)) closePanel(); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  return <div className="color-field" ref={field} onKeyDown={(event) => {
    // Escape closes the panel, not the dialog.
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); closePanel(); swatch.current?.focus(); }
  }}>
    <div className="color-field-row">
      <button ref={swatch} type="button" className="color-swatch" disabled={locked} aria-label={`Pick ${title}`} aria-expanded={open}
        onClick={() => (open ? closePanel() : openPanel())}>
        <span className="color-swatch-fill" style={{ background: withAlpha ? rgb + alpha : rgb }} />
      </button>
      <input id={id} className="color-hex" type="text" value={text} disabled={locked} spellCheck={false} autoComplete="off"
        placeholder={withAlpha ? '#rrggbbaa' : '#rrggbb'} aria-invalid={text !== '' && !parseColor(text)}
        onChange={(event) => {
          setText(event.target.value);
          const parsed = parseColor(event.target.value);
          if (parsed) set(parsed);
        }}
        onBlur={() => { if (parseColor(text)) rememberColor(formatColor(schema, parseColor(text))); else setText(value ?? ''); }} />
      {withAlpha && <label className="color-alpha">
        <span>Opacity</span>
        <input type="range" aria-label="Opacity" min="0" max="100" value={Math.round(parseInt(alpha, 16) * 100 / 255)} disabled={locked}
          onChange={(event) => set({ rgb, alpha: toAlpha(event.target.value) })} />
        <output>{Math.round(parseInt(alpha, 16) * 100 / 255)}%</output>
      </label>}
      {fallback && <button className="text-button" type="button" disabled={locked || value === fallback} onClick={() => onChange(fallback)}><RotateCcw size={14} />Default</button>}
    </div>
    {open && !locked && <ColorPanel anchor={swatch} title={title} rgb={rgb} onPick={(picked) => set({ rgb: picked, alpha })} />}
  </div>;
}

const toAlpha = (opacity) => Math.round(Number(opacity) * 255 / 100).toString(16).padStart(2, '0');
