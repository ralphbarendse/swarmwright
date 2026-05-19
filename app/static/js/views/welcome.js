export function renderWelcomeView(container) {
  container.innerHTML = `
    <style>
      .welcome-view {
        position: absolute; inset: 0;
        background: var(--color-parchment);
        display: flex; align-items: stretch; overflow: hidden;
      }
      .welcome-left {
        flex: 0 0 280px;
        display: flex; flex-direction: column; justify-content: center;
        padding: 40px 24px 40px 40px; overflow-y: auto;
        animation: wv-fade-up 0.6s cubic-bezier(.2,.6,.2,1) both;
      }
      .welcome-canvas-wrap {
        flex: 1; min-width: 0; position: relative;
        display: flex; align-items: stretch; justify-content: center;
        /* top/bottom padding reserves room for overlay labels (top:-48, bottom:-44) */
        padding: 56px 28px 52px 0; overflow: hidden;
      }
      @media (max-width: 860px) {
        .welcome-canvas-wrap { display: none; }
        .welcome-left { flex: 1; padding: 48px 24px; }
      }
      .wv-canvas-host {
        position: relative;
        width: 100%; max-width: 820px;
      }
      .wv-canvas-root {
        position: absolute; inset: 0; overflow: visible;
        background: transparent;
      }
      @keyframes wv-fade-up {
        from { opacity: 0; transform: translateY(16px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      .wv-mark svg { display: block; overflow: visible; }
      .wv-mark path {
        stroke-dasharray: 290; stroke-dashoffset: 290;
        animation: wv-draw-w 1.4s cubic-bezier(.45,.05,.25,1) 0.1s forwards;
      }
      @keyframes wv-draw-w { to { stroke-dashoffset: 0; } }
      @keyframes wv-particle {
        from { transform: translate(var(--dx), var(--dy)); opacity: 0; }
        to   { transform: translate(0,0); opacity: var(--op); }
      }
      .wv-wordmark { display: flex; flex-direction: column; line-height: 0.82; margin-top: 6px; }
      .wv-wordmark-small {
        font-family: var(--font-sans); font-weight: 200; font-size: 16px;
        letter-spacing: 0.44em; text-transform: uppercase; color: var(--color-ink); opacity: 0.36;
      }
      .wv-wordmark-big {
        font-family: var(--font-display); font-weight: 800;
        font-size: clamp(52px, 9vw, 68px); letter-spacing: 0.01em;
        text-transform: uppercase; color: var(--color-ink);
      }
      .wv-tagline { margin-top: 18px; display: flex; flex-direction: column; gap: 5px; }
      .wv-tagline-text {
        font-family: var(--font-hand); font-weight: 500; font-size: clamp(24px, 4vw, 34px);
        color: var(--color-primary); line-height: 1;
        transform: rotate(-1.2deg); display: inline-block;
      }
      .wv-tagline svg { display: block; overflow: visible; max-width: 380px; }
      .wv-tagline path {
        fill: none; stroke: var(--color-primary); stroke-width: 2.2;
        stroke-linecap: round; opacity: 0.7;
        stroke-dasharray: 460; stroke-dashoffset: 460;
        animation: wv-draw-wave 0.9s cubic-bezier(.4,0,.25,1) 0.5s forwards;
      }
      @keyframes wv-draw-wave { to { stroke-dashoffset: 0; } }
      .wv-lede {
        margin-top: 18px; font-size: 15px; line-height: 1.6;
        color: var(--color-ink-soft); max-width: 440px;
      }
      .wv-lede em { font-style: italic; color: var(--color-ink); }
      .wv-actions { margin-top: 28px; }
      .wv-action-label {
        font-family: var(--font-mono); font-size: 10.5px; letter-spacing: 0.18em;
        color: var(--color-ink-faint); text-transform: uppercase; margin-bottom: 10px;
        display: flex; align-items: center; gap: 8px;
      }
      .wv-action-swirl {
        font-family: var(--font-hand); font-size: 15px; color: var(--color-primary);
        letter-spacing: 0; text-transform: none;
        transform: rotate(-2deg) translateY(-1px); display: inline-block;
      }
      .wv-btns { display: flex; gap: 12px; flex-wrap: wrap; }
      .wv-btn-primary {
        padding: 12px 26px; background: var(--color-primary); color: #FBF5E6;
        border: none; border-radius: 7px; font-family: var(--font-display);
        font-size: 15px; font-weight: 700; letter-spacing: 0.04em; cursor: pointer;
        box-shadow: 3px 4px 0 #a0601a; transition: opacity 0.15s, transform 0.1s;
      }
      .wv-btn-primary:hover { opacity: 0.88; }
      .wv-btn-primary:active { transform: translate(1px,1px); box-shadow: 2px 3px 0 #a0601a; }
      .wv-btn-secondary {
        padding: 12px 26px; background: transparent; color: var(--color-ink-soft);
        border: 1.5px solid var(--color-cream-line); border-radius: 7px;
        font-family: var(--font-display); font-size: 15px; font-weight: 700;
        letter-spacing: 0.04em; cursor: pointer; text-decoration: none; display: inline-block;
        transition: border-color 0.15s, color 0.15s;
      }
      .wv-btn-secondary:hover { border-color: var(--color-primary); color: var(--color-primary); }
      @keyframes wv-ping {
        0%   { box-shadow: 0 0 0 0 rgba(26,175,135,.55); }
        70%  { box-shadow: 0 0 0 6px rgba(26,175,135,0); }
        100% { box-shadow: 0 0 0 0 rgba(26,175,135,0); }
      }
      @keyframes wv-march { to { stroke-dashoffset: -11; } }
    </style>

    <div class="welcome-view">
      <div class="welcome-left">

        <div class="wv-mark" style="margin-left:-10px">
          <svg viewBox="-26 -26 132 128" width="170" height="152" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <circle cx="-4"  cy="0"   r="2"   fill="#C97B1E" style="--dx:44px;  --dy:36px;  --op:.85; animation:wv-particle .55s 1.30s cubic-bezier(.2,.6,0,1.4) both"/>
            <circle cx="8"   cy="-9"  r="2.6" fill="#C97B1E" style="--dx:32px;  --dy:45px;  --op:.9;  animation:wv-particle .55s 1.34s cubic-bezier(.2,.6,0,1.4) both"/>
            <circle cx="19"  cy="-5"  r="1.3" fill="#C97B1E" style="--dx:21px;  --dy:41px;  --op:.65; animation:wv-particle .55s 1.38s cubic-bezier(.2,.6,0,1.4) both"/>
            <circle cx="33"  cy="-12" r="1.8" fill="#C97B1E" style="--dx:7px;   --dy:48px;  --op:.78; animation:wv-particle .55s 1.42s cubic-bezier(.2,.6,0,1.4) both"/>
            <circle cx="51"  cy="-10" r="2.2" fill="#C97B1E" style="--dx:-11px; --dy:46px;  --op:.75; animation:wv-particle .55s 1.51s cubic-bezier(.2,.6,0,1.4) both"/>
            <circle cx="65"  cy="-6"  r="1.6" fill="#C97B1E" style="--dx:-25px; --dy:42px;  --op:.7;  animation:wv-particle .55s 1.55s cubic-bezier(.2,.6,0,1.4) both"/>
            <circle cx="77"  cy="-4"  r="2.4" fill="#C97B1E" style="--dx:-37px; --dy:40px;  --op:.85; animation:wv-particle .55s 1.59s cubic-bezier(.2,.6,0,1.4) both"/>
            <circle cx="-9"  cy="20"  r="2.8" fill="#C97B1E" style="--dx:49px;  --dy:16px;  --op:.9;  animation:wv-particle .55s 1.67s cubic-bezier(.2,.6,0,1.4) both"/>
            <circle cx="-14" cy="42"  r="1.6" fill="#C97B1E" style="--dx:54px;  --dy:-6px;  --op:.65; animation:wv-particle .55s 1.71s cubic-bezier(.2,.6,0,1.4) both"/>
            <circle cx="88"  cy="19"  r="1.8" fill="#C97B1E" style="--dx:-48px; --dy:17px;  --op:.75; animation:wv-particle .55s 1.80s cubic-bezier(.2,.6,0,1.4) both"/>
            <circle cx="93"  cy="40"  r="2.4" fill="#C97B1E" style="--dx:-53px; --dy:-4px;  --op:.9;  animation:wv-particle .55s 1.84s cubic-bezier(.2,.6,0,1.4) both"/>
            <circle cx="14"  cy="80"  r="2.2" fill="#C97B1E" style="--dx:26px;  --dy:-44px; --op:.8;  animation:wv-particle .55s 1.92s cubic-bezier(.2,.6,0,1.4) both"/>
            <circle cx="43"  cy="86"  r="1.8" fill="#C97B1E" style="--dx:-3px;  --dy:-50px; --op:.75; animation:wv-particle .55s 2.01s cubic-bezier(.2,.6,0,1.4) both"/>
            <circle cx="57"  cy="82"  r="2.6" fill="#C97B1E" style="--dx:-17px; --dy:-46px; --op:.85; animation:wv-particle .55s 2.05s cubic-bezier(.2,.6,0,1.4) both"/>
            <path d="M 6,4 C 9,26 14,52 20,72 C 25,60 33,40 40,26 C 47,13 55,60 60,70 C 66,50 71,26 74,5"
              fill="none" stroke="#C97B1E" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>

        <div class="wv-actions" style="margin-top:28px;">
          <div class="wv-action-label">
            <span class="wv-action-swirl">keep building ↓</span>
          </div>
          <div class="wv-btns">
            <button class="wv-btn-primary" id="wv-continue-btn">Continue →</button>
            <a class="wv-btn-secondary" href="https://www.swarmwright.com/docs.html" target="_blank" rel="noopener">Read the docs →</a>
          </div>
        </div>

      </div>

      <div class="welcome-canvas-wrap">
        <div class="wv-canvas-host" id="wv-canvas-host"></div>
      </div>
    </div>
  `;

  const stop = initHeroCanvas(container.querySelector('#wv-canvas-host'));
  container.querySelector('#wv-continue-btn').addEventListener('click', () => {
    stop();
    window.swNav('org');
  });
}

// ── Easing helpers ────────────────────────────────────────────────────────────
const eOut3   = t => 1 - Math.pow(1 - t, 3);
const eBack   = t => { const c = 1.70158, c3 = c + 1; return 1 + c3 * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
const tw      = (t, s, e, from, to, ease = eOut3) => {
  if (t <= s) return from;
  if (t >= e) return to;
  return from + (to - from) * ease((t - s) / (e - s));
};

// ── Stage timing ──────────────────────────────────────────────────────────────
const LOOP = 24.0;
const STAGES = [
  { id: 1, label: 'design the swarm',                        start: 0,    inEnd: .6,  outStart: 5.0,  end: 5.8  },
  { id: 2, label: 'write the constitution',                  start: 5.8,  inEnd: 6.5, outStart: 11.2, end: 12.0 },
  { id: 3, label: 'run via control room, cron, or webhook',  start: 12.0, inEnd: 12.7,outStart: 17.4, end: 18.2 },
  { id: 4, label: 'see output live',                         start: 18.2, inEnd: 18.9,outStart: 23.0, end: 24.0 },
];
const stageOp    = (s, t) => { if (t < s.start || t > s.end) return 0; if (t < s.inEnd) return (t - s.start) / (s.inEnd - s.start); if (t > s.outStart) return 1 - (t - s.outStart) / (s.end - s.outStart); return 1; };
const stageLocal = (s, t) => Math.max(0, t - s.start);
const activeIdx  = t => { for (let i = STAGES.length - 1; i >= 0; i--) if (t >= STAGES[i].start) return i; return 0; };

// ── Color palette ─────────────────────────────────────────────────────────────
const TEAL = '#1AAF87', AMBER = '#C97B1E', PURPLE = '#8B5CF6', BLUE = '#3B82F6', MUTED = '#8A7055';
const INK = '#1A1410', CARD = '#FAF6EC', RULE = 'rgba(26,20,16,0.13)';
const MONO = "'DM Mono',monospace", SANS = "'DM Sans',sans-serif";

// ── Main init ─────────────────────────────────────────────────────────────────
function initHeroCanvas(host) {
  // Canvas root — overflow:visible so overlay labels can bleed into host padding
  const root = document.createElement('div');
  root.className = 'wv-canvas-root';
  host.appendChild(root);

  // Dot grid background
  const grid = document.createElement('div');
  grid.style.cssText = `position:absolute;inset:0;pointer-events:none;
    background-image:radial-gradient(circle,rgba(160,136,106,.22) 1px,transparent 1px);
    background-size:28px 28px;background-position:14px 14px;
    mask-image:radial-gradient(ellipse 85% 85% at 55% 50%,black 25%,transparent 80%);
    -webkit-mask-image:radial-gradient(ellipse 85% 85% at 55% 50%,black 25%,transparent 80%);`;
  root.appendChild(grid);

  const s1 = buildStage1(root);
  const s2 = buildStage2(root);
  const s3 = buildStage3(root);
  const s4 = buildStage4(root);
  const ov = buildOverlay(root);

  let t0 = null, raf;
  function tick(now) {
    if (!document.body.contains(host)) { cancelAnimationFrame(raf); return; }
    if (t0 === null) t0 = now;
    const t = ((now - t0) / 1000) % LOOP;
    const op1 = stageOp(STAGES[0], t), op2 = stageOp(STAGES[1], t);
    const op3 = stageOp(STAGES[2], t), op4 = stageOp(STAGES[3], t);
    s1.update(t, op1);
    s2.update(stageLocal(STAGES[1], t), op2);
    s3.update(stageLocal(STAGES[2], t), op3);
    s4.update(stageLocal(STAGES[3], t), op4);
    ov.update(t);
    raf = requestAnimationFrame(tick);
  }
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}

// ── Stage 1: Topology ─────────────────────────────────────────────────────────
function buildStage1(parent) {
  const el = document.createElement('div');
  el.style.cssText = 'position:absolute;inset:0;pointer-events:none;';

  // SVG arrow layer
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('style', 'position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;');
  svg.setAttribute('viewBox', '0 0 880 648');
  svg.setAttribute('preserveAspectRatio', 'none');

  const defs = document.createElementNS(NS, 'defs');
  [TEAL, PURPLE, AMBER, MUTED].forEach(c => {
    const ch = c.slice(1);
    ['ah', 'as'].forEach((id, ri) => {
      const m = document.createElementNS(NS, 'marker');
      m.setAttribute('id', `wv-${id}-${ch}`);
      m.setAttribute('markerWidth', '8'); m.setAttribute('markerHeight', '8');
      m.setAttribute('refX', ri === 0 ? '6' : '2'); m.setAttribute('refY', '3');
      m.setAttribute('orient', ri === 0 ? 'auto' : 'auto-start-reverse');
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', 'M0,0 L0,6 L8,3 Z'); p.setAttribute('fill', c);
      m.appendChild(p); defs.appendChild(m);
    });
  });
  svg.appendChild(defs);

  const ARROWS = [
    { d: 'M 440,74 L 440,120',                          color: TEAL,   t: .7,  dashed: false, bi: false },
    { d: 'M 295,255 C 235,288 196,304 178,310',          color: PURPLE, t: 1.4, dashed: true,  bi: true  },
    { d: 'M 440,255 L 440,308',                          color: TEAL,   t: 1.4, dashed: true,  bi: true  },
    { d: 'M 585,255 C 645,288 684,304 702,310',          color: AMBER,  t: 1.55,dashed: true,  bi: true  },
    { d: 'M 440,440 L 440,488',                          color: MUTED,  t: 2.0, dashed: true,  bi: false },
  ];
  const arrowPaths = ARROWS.map(a => {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', a.d);
    path.setAttribute('stroke', a.color);
    path.setAttribute('stroke-width', a.dashed ? '1.8' : '2.2');
    path.setAttribute('fill', 'none');
    path.setAttribute('marker-end', `url(#wv-ah-${a.color.slice(1)})`);
    if (a.bi) path.setAttribute('marker-start', `url(#wv-as-${a.color.slice(1)})`);
    svg.appendChild(path);
    return { path, a, len: null };
  });
  el.appendChild(svg);

  // Node positions & appear times
  const NP = { invoke:{l:33,t:5.5,w:34,h:8.5}, orch:{l:27,t:18,w:46,h:21}, classifier:{l:3.5,t:47,w:29,h:21}, assigner:{l:35.5,t:47,w:29,h:21}, policy:{l:67.5,t:47,w:29,h:21}, tool:{l:35.5,t:74,w:29,h:17} };
  const NT = { invoke:.05, orch:.5, classifier:1.0, assigner:1.15, policy:1.3, tool:1.8 };

  const ping = `width:6px;height:6px;border-radius:50%;background:${TEAL};animation:wv-ping 1.8s ease-out infinite;display:inline-block;flex-shrink:0;`;
  const dot  = (c) => `width:7px;height:7px;border-radius:50%;background:${c};display:inline-block;flex-shrink:0;`;

  function card(accent, title, desc, lines, model, star = false) {
    return `<div style="width:100%;height:100%;background:${CARD};border:1.5px solid ${accent};border-left:4px solid ${accent};border-radius:8px;box-shadow:3px 4px 0 rgba(26,20,16,.10);padding:9px 11px;display:flex;flex-direction:column;gap:4px;box-sizing:border-box;">
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <div style="display:flex;align-items:center;gap:6px;"><span style="${dot(accent)}"></span><span style="font-family:${SANS};font-weight:700;font-size:12px;color:${INK};">${title}</span></div>
        <div style="display:flex;align-items:center;gap:4px;">${star ? `<span style="color:${AMBER};font-size:11px;">★</span>` : ''}<span style="${ping}"></span></div>
      </div>
      <div style="font-family:${SANS};font-size:9.5px;font-style:italic;color:#5A4A36;line-height:1.4;">${desc}</div>
      <div style="flex:1;overflow:hidden;">${lines.map(l => `<div style="font-family:${SANS};font-size:9.5px;color:#6A5540;line-height:1.35;padding-left:10px;position:relative;margin-bottom:1px;"><span style="position:absolute;left:0;color:${accent};font-weight:700;">·</span>${l}</div>`).join('')}</div>
      <div style="border-top:1px dashed rgba(26,20,16,.15);padding-top:5px;"><span style="display:inline-flex;padding:2px 7px;background:rgba(26,20,16,.07);border:1px solid rgba(26,20,16,.15);border-radius:4px;font-family:${MONO};font-size:9px;color:#4A3C2A;">${model}</span></div>
    </div>`;
  }

  const NODE_HTML = {
    invoke: `<div style="width:100%;height:100%;background:${CARD};border:1.5px solid ${AMBER};border-left:4px solid ${AMBER};border-radius:8px;box-shadow:3px 4px 0 rgba(26,20,16,.10);padding:8px 12px;display:flex;flex-direction:row;align-items:center;gap:10px;box-sizing:border-box;"><span style="color:${AMBER};font-size:14px;">▶</span><div style="flex:1;"><div style="font-family:${SANS};font-weight:700;font-size:12px;color:${INK};">invoke</div><div style="font-family:${MONO};font-size:9px;letter-spacing:.1em;color:${MUTED};text-transform:uppercase;margin-top:1px;">Invocation</div></div><span style="padding:2px 8px;background:rgba(26,175,135,.13);border:1px solid rgba(26,175,135,.34);border-radius:12px;font-family:${MONO};font-size:10px;color:${TEAL};font-weight:500;">7 input</span><span style="${ping}"></span></div>`,
    orch:       card(TEAL,   'invoice-orchestrator', 'Entry point for the Invoice Router swarm.',      ['Accept raw invoice input (vendor, amount, date…)', 'Coordinate classifier, policy and cost-center agents'], 'claude-sonnet-4-6', true),
    classifier: card(PURPLE, 'invoice-classifier',   'A read-only perceptionist.',                     ['Parse invoice fields and extract structure', 'Return classification for orchestrator'],                       'claude-sonnet-4-6'),
    assigner:   card(BLUE,   'cost-center-assigner', 'An executioner-layer agent.',                    ['Receive classified invoice data', 'Resolve the correct cost center via tool'],                               'claude-haiku-4-5'),
    policy:     card(AMBER,  'invoice-policy',        'The governance authority.',                      ['Review high-value assignments', 'Approve, reject, or escalate'],                                             'claude-sonnet-4-6'),
    tool: `<div style="width:100%;height:100%;background:${CARD};border:1.5px dashed ${MUTED};border-radius:8px;box-shadow:2px 3px 0 rgba(26,20,16,.08);padding:9px 11px;display:flex;flex-direction:column;gap:6px;box-sizing:border-box;"><div style="display:flex;align-items:center;gap:6px;"><span style="font-family:${MONO};font-size:12px;color:${MUTED};">⟳</span><span style="font-family:${SANS};font-weight:700;font-size:12px;color:${INK};">lookup-cost-center</span></div><div style="border-top:1px dashed rgba(26,20,16,.15);padding-top:5px;display:flex;flex-direction:column;gap:3px;">${[['IN',['amount','category','department']],['OUT',['cost_center','requires_approval']]].map(([lbl,pills])=>`<div style="display:flex;gap:5px;align-items:flex-start;"><span style="font-family:${MONO};font-size:9px;color:${MUTED};width:22px;font-weight:500;">${lbl}</span><div style="flex:1;display:flex;flex-wrap:wrap;gap:3px;">${pills.map(p=>`<span style="padding:1px 6px;background:rgba(26,20,16,.06);border:1px solid rgba(26,20,16,.12);border-radius:3px;font-family:${MONO};font-size:8.5px;color:#4A3C2A;">${p}</span>`).join('')}</div></div>`).join('')}</div></div>`,
  };

  const nodes = Object.keys(NP).map(key => {
    const p = NP[key];
    const div = document.createElement('div');
    div.style.cssText = `position:absolute;left:${p.l}%;top:${p.t}%;width:${p.w}%;height:${p.h}%;opacity:0;transform:scale(.86);transform-origin:center;`;
    div.innerHTML = NODE_HTML[key];
    el.appendChild(div);
    return { div, key };
  });

  parent.appendChild(el);

  let lengthsReady = false;
  return {
    update(t, op) {
      if (op <= 0) { el.style.opacity = '0'; return; }
      el.style.opacity = String(op);

      if (!lengthsReady) {
        arrowPaths.forEach(ap => { try { ap.len = ap.path.getTotalLength(); } catch (_) { ap.len = 180; } });
        lengthsReady = true;
      }

      nodes.forEach(({ div, key }) => {
        const at = NT[key];
        div.style.opacity = String(tw(t, at, at + .5, 0, 1));
        div.style.transform = `scale(${tw(t, at, at + .48, .86, 1, eBack)})`;
      });

      arrowPaths.forEach(({ path, a, len }) => {
        const pl = len || 180;
        const pr = tw(t, a.t, a.t + .65, 0, 1);
        const done = pr >= 1;
        if (a.dashed) {
          if (done) {
            path.setAttribute('stroke-dasharray', '6 5');
            path.setAttribute('stroke-dashoffset', '0');
            path.style.animation = 'wv-march .9s linear infinite';
          } else {
            path.setAttribute('stroke-dasharray', `${pl} ${pl}`);
            path.setAttribute('stroke-dashoffset', String(pl * (1 - pr)));
            path.style.animation = '';
          }
          path.setAttribute('opacity', String(pr * .78));
        } else {
          path.setAttribute('stroke-dasharray', String(pl));
          path.setAttribute('stroke-dashoffset', String(pl * (1 - pr)));
          path.setAttribute('opacity', String(pr * .9));
        }
      });
    }
  };
}

// ── Stage 2: Agent Editor ─────────────────────────────────────────────────────
function buildStage2(parent) {
  const LINES = [
    { n: 1,  text: '## Role',                                                 h: true,  ap: 0   },
    { n: 2,  text: '',                                                                   ap: 0   },
    { n: 3,  text: 'You are the invoice-orchestrator, the entry point',        h: false, ap: 0   },
    { n: 4,  text: 'for the Invoice Router swarm. You receive raw',            h: false, ap: 0   },
    { n: 5,  text: 'invoice data, coordinate classification and',              h: false, ap: 0   },
    { n: 6,  text: 'cost-center assignment.',                                  h: false, ap: 0   },
    { n: 7,  text: '',                                                                   ap: 0   },
    { n: 8,  text: '## Responsibilities',                                      h: true,  ap: 0   },
    { n: 9,  text: '',                                                                   ap: 0   },
    { n: 10, text: '1. Accept raw invoice input (vendor, amount…)',            h: false, ap: .2  },
    { n: 11, text: '2. Delegate to invoice-classifier',                        h: false, ap: .5  },
    { n: 12, text: '3. Delegate to cost-center-assigner',                      h: false, ap: .8  },
    { n: 13, text: '4. If approval required, escalate to invoice-policy',      h: false, ap: 1.1 },
    { n: 14, text: '5. Compile and return final routing decision',             h: false, ap: 1.4 },
    { n: 15, text: '',                                                                   ap: 1.4 },
    { n: 16, text: '## Behaviour',                                             h: true,  ap: 1.9 },
    { n: 17, text: '',                                                                   ap: 1.9 },
    { n: 18, text: '- Always delegate to invoice-classifier first',            h: false, ap: 2.1 },
    { n: 19, text: '- Pass the full original payload unchanged',               h: false, ap: 2.5 },
    { n: 20, text: '- Only escalate when `requires_approval` is true',         h: false, ap: 2.9 },
  ];

  const agentRows = [
    { tag: 'EXEC', color: BLUE,   name: 'cost-cent…'    },
    { tag: 'PERC', color: PURPLE, name: 'invoice-…'     },
    { tag: 'POLI', color: AMBER,  name: 'invoice-policy' },
  ];
  const previewItems = ['Accept raw invoice input','Delegate to invoice-classifier','Delegate to cost-center-assigner','Escalate if approval required','Compile final routing decision'];

  const el = document.createElement('div');
  el.style.cssText = 'position:absolute;inset:0;opacity:0;will-change:transform,opacity;';
  el.innerHTML = `
    <div style="position:absolute;inset:0;border-radius:10px;overflow:hidden;box-shadow:0 12px 40px -14px rgba(26,20,16,.18);border:1px solid rgba(26,20,16,.10);background:rgba(250,246,236,.92);display:flex;flex-direction:column;">
      <div style="height:28px;flex-shrink:0;background:rgba(240,232,210,.85);border-bottom:1px solid rgba(26,20,16,.10);display:flex;align-items:center;padding:0 14px;gap:4px;">
        <span style="font-family:${SANS};font-size:10.5px;color:${MUTED};">Workspaces</span><span style="color:${MUTED};font-size:9px;margin:0 2px;">›</span>
        <span style="font-family:${SANS};font-size:10.5px;color:${MUTED};">invoice-router</span><span style="color:${MUTED};font-size:9px;margin:0 2px;">›</span>
        <span style="font-family:${SANS};font-size:10.5px;color:${INK};font-weight:600;">invoice-orchestrator</span>
        <span style="flex:1;"></span>
        <span style="font-family:${MONO};font-size:9px;color:${MUTED};">245 words · ~465 tokens</span>
        <div style="display:flex;gap:5px;margin-left:12px;">
          <span style="padding:2px 8px;border:1px solid rgba(26,20,16,.12);border-radius:4px;font-family:${SANS};font-size:9.5px;color:${INK};background:rgba(250,246,236,.8);">+ Draft</span>
          <span style="padding:2px 8px;border:1px solid rgba(26,20,16,.12);border-radius:4px;font-family:${SANS};font-size:9.5px;color:${INK};background:rgba(250,246,236,.8);">Discard</span>
          <span style="padding:2px 9px;border:1px solid ${AMBER};border-radius:4px;font-family:${SANS};font-size:9.5px;color:${AMBER};background:rgba(201,123,30,.08);font-weight:600;">Save ⌘S</span>
        </div>
      </div>
      <div style="display:flex;flex:1;overflow:hidden;">
        <aside style="width:18%;border-right:1px solid ${RULE};padding:10px;background:rgba(250,246,236,.4);display:flex;flex-direction:column;gap:10px;overflow:hidden;flex-shrink:0;">
          <div style="font-family:${MONO};font-size:8.5px;letter-spacing:.16em;color:${MUTED};">CONFIG</div>
          ${[['LAYER','Orchestrator'],['MODEL','Claude Sonnet 4.6']].map(([lbl,val])=>`
          <div>
            <div style="font-family:${MONO};font-size:8px;color:${MUTED};letter-spacing:.12em;">${lbl}</div>
            <div style="display:flex;align-items:center;justify-content:space-between;border:1px solid ${RULE};border-radius:5px;padding:4px 8px;background:rgba(250,246,236,.8);font-family:${SANS};font-size:10.5px;color:${INK};margin-top:3px;">
              <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${val}</span><span style="color:${MUTED};font-size:9px;flex-shrink:0;">⌄</span>
            </div>
          </div>`).join('')}
          <div>
            <div style="font-family:${MONO};font-size:8px;color:${MUTED};letter-spacing:.12em;margin-bottom:3px;">SKILLS</div>
            <span style="font-family:${SANS};font-size:9.5px;color:${MUTED};font-style:italic;">No skills attached yet.</span>
          </div>
          <div>
            <div style="font-family:${MONO};font-size:8px;color:${MUTED};letter-spacing:.12em;margin-bottom:4px;">SWARM AGENTS</div>
            ${agentRows.map(a=>`<div style="display:flex;align-items:center;gap:4px;margin-bottom:5px;">
              <span style="padding:1px 5px;border-radius:3px;background:${a.color}22;border:1px solid ${a.color}55;font-family:${MONO};font-size:7.5px;color:${a.color};font-weight:600;flex-shrink:0;">${a.tag}</span>
              <span style="font-family:${SANS};font-size:9px;color:${INK};flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${a.name}</span>
              <span style="padding:1px 5px;border:1px solid ${RULE};border-radius:3px;font-family:${SANS};font-size:8px;color:${MUTED};flex-shrink:0;">Insert</span>
            </div>`).join('')}
          </div>
        </aside>
        <main style="flex:1;overflow:hidden;padding:8px 0;background:rgba(250,248,240,.5);min-width:0;">
          <div id="wvs2-lines">
            ${LINES.map(l=>`<div data-ap="${l.ap}" style="display:flex;align-items:baseline;gap:0;opacity:0;">
              <span style="font-family:${MONO};font-size:9.5px;color:rgba(138,112,85,.45);width:28px;text-align:right;padding-right:8px;flex-shrink:0;user-select:none;">${l.n}</span>
              <span style="font-family:${MONO};font-size:10.5px;line-height:1.55;color:${l.h?INK:'#5A4A36'};font-weight:${l.h?700:400};white-space:pre;">${l.text}</span>
            </div>`).join('')}
          </div>
        </main>
        <aside style="width:28%;border-left:1px solid ${RULE};padding:12px 14px;background:rgba(250,248,240,.3);overflow:hidden;flex-shrink:0;">
          <div style="display:flex;gap:0;margin-bottom:10px;border-bottom:1px solid ${RULE};padding-bottom:6px;">
            <span style="font-family:${SANS};font-size:11px;padding:2px 10px;border-radius:999px;margin-right:4px;background:${AMBER};color:#FAF6EC;font-weight:600;">Preview</span>
            <span style="font-family:${SANS};font-size:11px;padding:2px 10px;border-radius:999px;color:${MUTED};">Context</span>
          </div>
          <div style="font-family:${SANS};font-size:11px;color:${INK};line-height:1.5;">
            <div style="font-weight:700;font-size:13px;margin-bottom:4px;">Role</div>
            <p style="margin-bottom:8px;color:#5A4A36;font-size:10.5px;">You are the invoice-orchestrator, the entry point for the Invoice Router swarm.</p>
            <div style="font-weight:700;font-size:12px;margin-bottom:4px;">Responsibilities</div>
            ${previewItems.map((r,i)=>`<div style="font-size:10.5px;color:#5A4A36;margin-bottom:3px;padding-left:10px;position:relative;"><span style="position:absolute;left:0;">${i+1}.</span>${r}</div>`).join('')}
          </div>
        </aside>
      </div>
      <div style="height:26px;flex-shrink:0;background:linear-gradient(to top,#E8DEC2,#DDD0AF);border-top:1px solid ${RULE};display:flex;align-items:center;padding:0 14px;gap:6px;">
        <span style="font-family:${MONO};font-size:9px;color:${MUTED};">INSERT</span>
        ${['Role','Responsibilities','Behavior','Output Format','Constraints','↗ Action'].map(s=>`<span style="padding:2px 8px;border:1px solid ${RULE};border-radius:4px;font-family:${SANS};font-size:9px;color:${INK};background:rgba(250,246,236,.8);">${s}</span>`).join('')}
      </div>
    </div>
  `;

  const lineEls = el.querySelectorAll('#wvs2-lines > div');
  const lastSpan = lineEls[lineEls.length - 1].querySelector('span:last-child');
  const cursor = document.createElement('span');
  cursor.style.cssText = `display:none;width:7px;height:12px;background:${AMBER};vertical-align:middle;margin-left:1px;`;
  lastSpan.appendChild(cursor);

  parent.appendChild(el);

  return {
    update(localT, op) {
      if (op <= 0) { el.style.opacity = '0'; return; }
      const enter = tw(localT, 0, .7, 0, 1);
      el.style.opacity  = String(op * enter);
      el.style.transform = `translateY(${(1 - enter) * 20}px)`;
      lineEls.forEach(ln => { ln.style.opacity = String(tw(localT, +ln.dataset.ap, +ln.dataset.ap + .3, 0, 1)); });
      const show = localT > 3.5;
      cursor.style.display = show ? 'inline-block' : 'none';
      if (show) cursor.style.opacity = Math.floor(localT * 2) % 2 === 0 ? '1' : '0';
    }
  };
}

// ── Stage 3: Control Room ─────────────────────────────────────────────────────
function buildStage3(parent) {
  const RUNS = [
    { name: 'expense-approval', id: 'a3f1c82e', status: 'running',   dur: '4.2s'  },
    { name: 'content-review',   id: 'b7d4e91a', status: 'completed', dur: '3.1s'  },
    { name: 'onboarding-flow',  id: 'c2a8f05b', status: 'completed', dur: '2.7s'  },
    { name: 'support-triage',   id: 'd9e3b47c', status: 'completed', dur: '18.8s' },
    { name: 'data-pipeline',    id: 'e5c6d12f', status: 'completed', dur: '11.2s' },
  ];
  const GROUPS = [
    { group: 'FINANCE',  agents: [{ name: 'expense-approval', notify: false }] },
    { group: 'PLATFORM', agents: [{ name: 'swarm-architect', notify: false }, { name: 'swarm-reviewer', notify: true }] },
    { group: 'OPS',      agents: [{ name: 'onboarding-flow', notify: false }, { name: 'support-triage', notify: false }] },
  ];

  const el = document.createElement('div');
  el.style.cssText = 'position:absolute;inset:0;opacity:0;will-change:transform,opacity;';
  el.innerHTML = `
    <div style="position:absolute;inset:0;border-radius:10px;overflow:hidden;box-shadow:0 12px 40px -14px rgba(26,20,16,.18);border:1px solid rgba(26,20,16,.10);display:flex;height:100%;background:rgba(250,246,236,.92);">
      <aside style="width:22%;border-right:1px solid ${RULE};padding:10px;background:rgba(250,246,236,.5);display:flex;flex-direction:column;gap:0;flex-shrink:0;overflow:hidden;">
        <div style="margin-bottom:10px;">
          <div style="font-family:'Syne',sans-serif;font-weight:800;font-size:13px;color:${INK};">SwarmWright</div>
          <div style="font-family:${MONO};font-size:8.5px;letter-spacing:.14em;color:${MUTED};">CONTROL ROOM</div>
        </div>
        ${GROUPS.map(g=>`<div style="margin-bottom:8px;">
          <div style="font-family:${MONO};font-size:8px;letter-spacing:.14em;color:${MUTED};margin-bottom:4px;">${g.group}</div>
          ${g.agents.map(a=>`<div style="display:flex;align-items:center;gap:5px;margin-bottom:3px;">
            <span style="font-family:${SANS};font-size:10px;color:${INK};flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">· ${a.name}</span>
            ${a.notify?`<span style="width:7px;height:7px;border-radius:50%;background:${PURPLE};flex-shrink:0;"></span>`:''}
            <span style="padding:1px 5px;border:1px solid rgba(26,175,135,.4);border-radius:3px;font-family:${MONO};font-size:7.5px;color:${TEAL};flex-shrink:0;">active</span>
            <span style="color:${MUTED};font-size:9px;flex-shrink:0;">▶</span>
          </div>`).join('')}
        </div>`).join('')}
      </aside>
      <div style="flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0;">
        <div style="padding:7px 14px;border-bottom:1px solid ${RULE};background:rgba(250,246,236,.5);display:flex;align-items:center;gap:14px;font-family:${MONO};font-size:10px;flex-shrink:0;">
          <span id="wvs3-pulse-wrap" style="display:flex;align-items:center;gap:5px;">
            <span id="wvs3-pulse-dot" style="width:7px;height:7px;border-radius:50%;background:${TEAL};display:inline-block;flex-shrink:0;"></span>
            <span style="color:${TEAL};font-weight:500;">1 running</span>
          </span>
          <span style="color:${MUTED};">· 0 awaiting</span>
          <span style="color:${MUTED};">✓ 3 done today</span>
          <span style="flex:1;"></span>
          <span style="padding:3px 10px;border:1px solid ${RULE};border-radius:5px;background:${AMBER};color:#FAF6EC;font-size:9.5px;">↺ Refresh</span>
        </div>
        <div id="wvs3-runs" style="flex:1;overflow:hidden;padding:8px 14px;display:flex;flex-direction:column;gap:7px;">
          ${RUNS.map((r,i)=>`<div data-i="${i}" style="background:${CARD};border:1px solid ${RULE};border-radius:7px;padding:8px 14px;display:flex;align-items:center;gap:10px;box-shadow:2px 3px 0 rgba(26,20,16,.06);transition:border-color .3s,background .3s;">
            <span style="width:7px;height:7px;border-radius:50%;flex-shrink:0;background:${r.status==='running'?TEAL:'rgba(138,112,85,.35)'};"></span>
            <span style="font-family:${SANS};font-weight:700;font-size:11.5px;color:${INK};flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${r.name}</span>
            <span style="font-family:${MONO};font-size:8.5px;color:${MUTED};flex-shrink:0;">${r.id}</span>
            <span style="font-family:${SANS};font-size:10px;color:${r.status==='running'?TEAL:MUTED};font-weight:${r.status==='running'?600:400};flex-shrink:0;">${r.status==='running'?'Running…':'Completed'}</span>
            <span style="font-family:${MONO};font-size:9px;color:${MUTED};flex-shrink:0;">${r.dur}</span>
          </div>`).join('')}
        </div>
      </div>
    </div>
  `;

  const pulseDot = el.querySelector('#wvs3-pulse-dot');
  const runRows  = Array.from(el.querySelectorAll('#wvs3-runs > div'));
  parent.appendChild(el);

  return {
    update(localT, op) {
      if (op <= 0) { el.style.opacity = '0'; return; }
      const enter = tw(localT, 0, .7, 0, 1);
      el.style.opacity   = String(op * enter);
      el.style.transform = `translateY(${(1 - enter) * 20}px)`;

      const pulse = .5 + .5 * Math.sin(localT * 4);
      pulseDot.style.boxShadow = `0 0 0 ${(3 * pulse).toFixed(1)}px rgba(26,175,135,${(.2 * (1 - pulse)).toFixed(2)})`;

      const hi = Math.floor(localT / 1.0) % RUNS.length;
      runRows.forEach((row, i) => {
        const active = i === hi;
        row.style.background  = active ? 'rgba(201,123,30,.07)' : CARD;
        row.style.border      = `1px solid ${active ? AMBER : RULE}`;
        row.style.boxShadow   = active ? '0 0 0 2px rgba(201,123,30,.12)' : '2px 3px 0 rgba(26,20,16,.06)';
      });
    }
  };
}

// ── Stage 4: Run Trace ────────────────────────────────────────────────────────
function buildStage4(parent) {
  const STEPS = [
    { n: 1, name: 'invoice-orchestrator', type: 'Agent', desc: null,                                                                   dur: null,    input: '{"vendor":"Microsoft","invoice_number":"INV-2025-0042","amount":1250.0,"currency":"EUR"…}',                             ap: 0   },
    { n: 2, name: 'invoice-classifier',   type: 'Agent', desc: '"Extract and classify structured invoice fields from raw input…"',     dur: '4.1s',  input: '{"vendor":"Microsoft","invoice_number":"INV-2025-0042","amount":1250.0,"currency":"EUR","date":"2025-05-01","department":"IT"}', ap: .4  },
    { n: 3, name: 'cost-center-assigner', type: 'Agent', desc: '"Assign the correct cost center once the invoice is classified"',      dur: null,    input: '{"vendor":"Microsoft","invoice_number":"INV-2025-0042","amount":1250.0,"currency":"EUR","category":"it-services"…}',    ap: .9  },
    { n: 4, name: 'lookup-cost-center',   type: 'Skill', desc: '"Look up the correct cost center code for the classified invoice"',    dur: '231ms', input: '{\n  "amount": 1250,\n  "category": "it-services",\n  "department": "IT"\n}',                                            ap: 1.5 },
  ];

  const el = document.createElement('div');
  el.style.cssText = 'position:absolute;inset:0;opacity:0;will-change:transform,opacity;display:flex;flex-direction:column;';
  el.innerHTML = `
    <div style="position:absolute;inset:0;display:flex;flex-direction:column;border-radius:10px;overflow:hidden;box-shadow:0 12px 40px -14px rgba(26,20,16,.18);border:1px solid rgba(26,20,16,.10);background:rgba(250,246,236,.92);">
      <div style="padding:14px 22px 10px;display:flex;flex-direction:column;gap:6px;border-bottom:1px solid ${RULE};background:rgba(250,246,236,.45);flex-shrink:0;">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="width:8px;height:8px;border-radius:50%;background:${TEAL};box-shadow:0 0 0 3px rgba(26,175,135,.22);flex-shrink:0;"></span>
          <span style="font-family:${SANS};font-size:11px;color:${TEAL};font-weight:600;">Completed</span>
          <span style="font-family:'Syne',sans-serif;font-weight:800;font-size:16px;color:${INK};">expense-approval</span>
          <span style="font-family:${MONO};font-size:9px;color:${MUTED};">a3f1c82e · invocation</span>
          <span style="flex:1;"></span>
          <span style="padding:3px 11px;border:1px solid ${RULE};border-radius:5px;font-family:${SANS};font-size:10px;color:${INK};background:rgba(250,246,236,.9);">↺ Replay</span>
        </div>
        <div style="display:flex;align-items:center;gap:18px;font-family:${MONO};font-size:9.5px;color:${MUTED};flex-wrap:wrap;">
          <span><span style="color:${INK};">Started</span> today, 14:22:08</span>
          <span><span style="color:${INK};">Duration</span> 18.8s</span>
          <span style="color:${TEAL};">↑ 6,060 tok</span>
          <span style="color:${PURPLE};">↓ 1,207 tok</span>
          <span style="flex:1;"></span>
          <span style="background:rgba(201,123,30,.10);border:1px solid rgba(201,123,30,.3);border-radius:4px;padding:2px 9px;color:${AMBER};font-weight:600;">4 steps · 18.8s</span>
        </div>
      </div>
      <div style="flex:1;padding:10px 22px 12px;overflow:hidden;display:flex;flex-direction:column;gap:0;">
        <div style="font-family:${MONO};font-size:9px;letter-spacing:.16em;color:${MUTED};margin-bottom:8px;text-transform:uppercase;">Step Trace</div>
        <div id="wvs4-steps" style="display:flex;flex-direction:column;gap:7px;">
          ${STEPS.map((s,i)=>`
          <div data-i="${i}" data-ap="${s.ap}" style="display:flex;gap:12px;align-items:flex-start;opacity:0;">
            <div style="display:flex;flex-direction:column;align-items:center;gap:0;padding-top:8px;flex-shrink:0;">
              <span class="wvs4-num" style="font-family:${MONO};font-size:11px;font-weight:700;color:${MUTED};width:18px;text-align:center;transition:color .3s;">${s.n}</span>
              ${i<STEPS.length-1?`<div class="wvs4-line" style="width:1px;height:14px;background:${RULE};margin-top:3px;transition:background .3s;"></div>`:''}
            </div>
            <div class="wvs4-card" style="flex:1;border-radius:8px;border:1.5px solid ${RULE};background:${CARD};box-shadow:2px 3px 0 rgba(26,20,16,.07);overflow:hidden;transition:border-color .3s,background .3s,box-shadow .3s;min-width:0;">
              <div style="padding:7px 12px;display:flex;align-items:center;gap:7px;border-bottom:1px solid ${RULE};flex-wrap:wrap;">
                <span style="font-family:${SANS};font-weight:700;font-size:12px;color:${INK};">${s.name}</span>
                <span style="padding:1px 6px;background:${s.type==='Skill'?'rgba(26,175,135,.12)':'rgba(59,130,246,.10)'};border:1px solid ${s.type==='Skill'?'rgba(26,175,135,.3)':'rgba(59,130,246,.3)'};border-radius:4px;font-family:${MONO};font-size:8.5px;color:${s.type==='Skill'?TEAL:BLUE};flex-shrink:0;">${s.type}</span>
                ${s.desc?`<span style="font-family:${SANS};font-size:10px;font-style:italic;color:${AMBER};flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${s.desc}</span>`:'<span style="flex:1;"></span>'}
                ${s.dur?`<span style="font-family:${MONO};font-size:9.5px;color:${MUTED};flex-shrink:0;">${s.dur}</span>`:''}
              </div>
              <div style="padding:5px 12px 8px;">
                <div style="display:flex;gap:0;margin-bottom:4px;">
                  <span style="font-family:${SANS};font-size:10px;padding:1px 10px;border-bottom:2px solid ${AMBER};color:${AMBER};">Input</span>
                  <span style="font-family:${SANS};font-size:10px;padding:1px 10px;border-bottom:2px solid transparent;color:${MUTED};">Output</span>
                </div>
                <div class="wvs4-input" style="font-family:${MONO};font-size:9px;color:#5A4A36;line-height:1.5;background:rgba(26,20,16,.04);border-radius:4px;padding:5px 8px;white-space:pre;overflow:hidden;max-height:22px;transition:max-height .4s ease;">${s.input}</div>
              </div>
            </div>
          </div>`).join('')}
        </div>
      </div>
    </div>
  `;

  const stepEls = Array.from(el.querySelectorAll('#wvs4-steps > div')).map(row => ({
    row,
    num:   row.querySelector('.wvs4-num'),
    line:  row.querySelector('.wvs4-line'),
    card:  row.querySelector('.wvs4-card'),
    input: row.querySelector('.wvs4-input'),
  }));
  parent.appendChild(el);

  return {
    update(localT, op) {
      if (op <= 0) { el.style.opacity = '0'; return; }
      const enter = tw(localT, 0, .7, 0, 1);
      el.style.opacity   = String(op * enter);
      el.style.transform = `translateY(${(1 - enter) * 20}px)`;

      const active = Math.floor(localT / 1.2) % STEPS.length;
      stepEls.forEach(({ row, num, line, card, input }, i) => {
        row.style.opacity = String(tw(localT, STEPS[i].ap, STEPS[i].ap + .4, 0, 1));
        const isActive = i === active;
        num.style.color      = isActive ? AMBER : MUTED;
        if (line) line.style.background = isActive ? AMBER : RULE;
        card.style.border    = `1.5px solid ${isActive ? AMBER : RULE}`;
        card.style.background = isActive ? 'rgba(201,123,30,.05)' : CARD;
        card.style.boxShadow = isActive ? '0 0 0 3px rgba(201,123,30,.09), 3px 4px 0 rgba(26,20,16,.07)' : '2px 3px 0 rgba(26,20,16,.07)';
        input.style.maxHeight = isActive ? '54px' : '22px';
      });
    }
  };
}

// ── Stage overlay (step label + dot indicator) ────────────────────────────────
function buildOverlay(parent) {
  const label = document.createElement('div');
  label.style.cssText = `position:absolute;top:-48px;left:0;z-index:10;display:flex;align-items:baseline;gap:10px;opacity:0;pointer-events:none;`;
  label.innerHTML = `
    <span id="wvov-badge" style="font-family:${MONO};font-size:10.5px;letter-spacing:.18em;color:${MUTED};text-transform:uppercase;padding:3px 8px;border:1px solid rgba(26,20,16,.13);border-radius:4px;background:rgba(250,246,236,.8);">01 · step</span>
    <span id="wvov-label" style="font-family:'Caveat',cursive;font-weight:700;font-size:26px;color:${AMBER};line-height:1;transform:rotate(-1.5deg);display:inline-block;">design the swarm</span>
  `;

  const dots = document.createElement('div');
  dots.style.cssText = `position:absolute;bottom:-44px;left:50%;transform:translateX(-50%);z-index:10;display:flex;align-items:center;gap:9px;padding:6px 14px;background:rgba(250,246,236,.75);border:1px solid rgba(26,20,16,.13);border-radius:999px;font-family:${MONO};font-size:10px;color:${MUTED};letter-spacing:.04em;white-space:nowrap;pointer-events:none;`;
  const dotSpans = STAGES.map((_, i) => {
    const s = document.createElement('span');
    s.style.cssText = `width:6px;height:6px;border-radius:50%;background:rgba(138,112,85,.3);display:inline-block;transition:background .25s,transform .25s,box-shadow .25s;`;
    dots.appendChild(s);
    return s;
  });
  const counter = document.createElement('span');
  counter.style.cssText = `margin-left:4px;color:${MUTED};`;
  counter.textContent = '01 / 04';
  dots.appendChild(counter);

  parent.appendChild(label);
  parent.appendChild(dots);

  const badge = label.querySelector('#wvov-badge');
  const lbl   = label.querySelector('#wvov-label');

  return {
    update(t) {
      const i  = activeIdx(t);
      const s  = STAGES[i];
      const op = stageOp(s, t);
      const loc = stageLocal(s, t);
      const yIn = (1 - tw(loc, 0, .5, 0, 1, eBack)) * 7;

      label.style.opacity   = String(op);
      label.style.transform = `translateY(${-yIn}px)`;
      badge.textContent = `0${s.id} · step`;
      lbl.textContent   = s.label;

      dotSpans.forEach((dot, di) => {
        const active = di === i;
        dot.style.background = active ? AMBER : 'rgba(138,112,85,.3)';
        dot.style.transform  = active ? 'scale(1.45)' : 'scale(1)';
        dot.style.boxShadow  = active ? '0 0 0 3px rgba(201,123,30,.18)' : 'none';
      });
      counter.textContent = `0${i + 1} / 04`;
    }
  };
}
