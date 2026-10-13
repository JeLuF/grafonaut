import React from 'react';
import { BadgeCheck, CodeXml, Gamepad2, MonitorPlay, Twitch, UserRound } from 'lucide-react';

// Grafanaut brand elements. The logo is drawn in code until the final logo artwork exists.

export function Logo({ size = 34 }) {
  return <svg className="logo-mark" width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="logo-helmet" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#ffffff" /><stop offset="1" stopColor="#b9c2ff" /></linearGradient>
      <linearGradient id="logo-visor" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#0d1440" /><stop offset=".65" stopColor="#24308a" /><stop offset="1" stopColor="#4cc9ff" /></linearGradient>
    </defs>
    <rect x="3" y="15" width="5" height="11" rx="2.5" fill="#8b9cff" />
    <rect x="32" y="15" width="5" height="11" rx="2.5" fill="#8b9cff" />
    <circle cx="20" cy="20" r="16" fill="url(#logo-helmet)" />
    <ellipse cx="20.5" cy="21" rx="11" ry="9.5" fill="url(#logo-visor)" />
    <ellipse cx="16.5" cy="17.2" rx="3.6" ry="1.8" fill="#ffffff" opacity=".55" transform="rotate(-24 16.5 17.2)" />
  </svg>;
}

export function Wordmark() {
  return <span className="wordmark"><Logo /><span>Grafanaut</span></span>;
}

export function TwitchLogin({ compact = false, label = 'Login with Twitch' }) {
  return <a className={`twitch-button${compact ? ' is-compact' : ''}`} href="/api/auth/twitch"><Twitch size={compact ? 16 : 20} aria-hidden="true" />{label}</a>;
}

// Hero illustration (public/brand): an astronaut with a graphics tablet on a moon. Its dark background is faded into
// the page by a CSS mask.
export function HeroArt() {
  return <div className="hero-art">
    <img src="/brand/hero-astronaut-1536.webp" srcSet="/brand/hero-astronaut-768.webp 768w, /brand/hero-astronaut-1536.webp 1536w"
      sizes="(max-width: 900px) 100vw, 55vw" width="1536" height="1024" decoding="async" fetchPriority="high"
      alt="An astronaut on a moon holding a tablet with a graphic, next to the note: Same format. Endless possibilities." />
  </div>;
}

const features = [
  { icon: MonitorPlay, title: 'Works with OBS & vMix', text: 'Add your renderer URL as a browser source. No complicated setup.' },
  { icon: Gamepad2, title: 'Controller ready', text: 'Trigger graphics and group actions from Bitfocus Companion or a Stream Deck via the OGraf Server API.' },
  { icon: CodeXml, title: 'Customizable & extensible', text: 'HTML-based animations. Adjust their properties or upload your own.' },
  { icon: BadgeCheck, title: 'Built on an open standard', text: 'Based on the EBU OGraf specification, so graphics are not locked in.' },
  { icon: UserRound, title: 'Log in with Twitch', text: 'Use your Twitch account and get started right away.' }
];

export function FeatureRow() {
  return <section className="feature-row" aria-label="Features">
    {features.map(({ icon: Icon, title, text }) => <div key={title} className="feature">
      <Icon size={34} strokeWidth={1.6} aria-hidden="true" />
      <h3>{title}</h3>
      <p>{text}</p>
    </div>)}
  </section>;
}
