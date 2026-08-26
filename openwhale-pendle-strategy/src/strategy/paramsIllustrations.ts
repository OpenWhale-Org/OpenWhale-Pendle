import type { ParamIllustration } from '@openwhaleorg/core'

/**
 * Interactive docs rendered inside the param form (sandboxed iframes; the
 * dashboard streams the live field values in via postMessage — see
 * ParamIllustration in @openwhaleorg/core). Plain string-concat JS inside so
 * the page reads as data. Layout is computed from the iframe's real width on
 * every draw and redrawn on resize.
 */

const STYLE = `
  <style>
    html, body { overflow: hidden; }
    body { margin: 0; padding: 10px 12px; background: #101012; color: #d4d4d8;
           font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
    svg { display: block; }
    .lbl { fill: #8b8b93; font-size: 10px; }
    .val { fill: #d4d4d8; font-size: 11px; }
    .hi { fill: #fbbf24; font-size: 10px; }
  </style>`

/**
 * The corridor: where an order rests relative to mid and the incentive band,
 * and the two lines that trigger a re-quote.
 */
const CORRIDOR_HTML = `<!doctype html><html><head><meta charset="utf-8">${STYLE}</head><body>
<svg id="s" height="210"></svg>
<script>
var v = {};
function num(name, dflt) { var x = parseFloat(v[name]); return isFinite(x) ? x : dflt; }
function draw() {
  var edge = num('edgeRatio', 0.95);
  var safe = num('safeDistanceRatio', 0.3);
  var sides = v.sides || 'both';
  var W = Math.max(320, document.body.clientWidth - 26);
  var svg = document.getElementById('s');
  svg.setAttribute('width', W);
  svg.setAttribute('viewBox', '0 0 ' + W + ' 210');
  var mid = W / 2, half = (W - 80) / 2 / 1.3;   // band half-width in px; leave room for the out-of-band zone
  var axisY = 120;
  function X(r) { return mid + r * half; }      // r = distance from mid in units of the half-width (+ = short side / higher APR)
  var g = '';
  function rect(x1, x2, y, h, fill, o) { g += '<rect x="' + Math.min(x1,x2) + '" y="' + y + '" width="' + Math.abs(x2-x1) + '" height="' + h + '" fill="' + fill + '" opacity="' + o + '"/>'; }
  function vline(x, y1, y2, col, dash) { g += '<line x1="' + x + '" x2="' + x + '" y1="' + y1 + '" y2="' + y2 + '" stroke="' + col + '" stroke-width="1.5"' + (dash ? ' stroke-dasharray="4 3"' : '') + '/>'; }
  function txt(x, y, s, cls, anchor) { g += '<text x="' + x + '" y="' + y + '" class="' + cls + '" text-anchor="' + (anchor || 'middle') + '">' + s + '</text>'; }
  // Zones per side, mirrored around mid: [0,safe) re-quote (too close), [safe,1] keep, >1 re-quote (out of band)
  [-1, 1].forEach(function (d) {
    var on = sides === 'both' || (d < 0 ? sides === 'long' : sides === 'short');
    rect(X(0), X(d * safe), 70, 100, '#ef4444', on ? 0.18 : 0.05);
    rect(X(d * safe), X(d * 1), 70, 100, '#22c55e', on ? 0.22 : 0.05);
    rect(X(d * 1), X(d * 1.3), 70, 100, '#ef4444', on ? 0.12 : 0.04);
    vline(X(d * 1), 62, 178, '#8b8b93', false);
    vline(X(d * safe), 70, 170, '#ef4444', true);
    if (on) {
      var ox = X(d * edge);
      g += '<circle cx="' + ox + '" cy="' + axisY + '" r="6" fill="#fbbf24"/>';
      txt(ox, 58, (d < 0 ? 'long' : 'short') + ' order', 'hi');
    }
  });
  g += '<line x1="' + X(-1.3) + '" x2="' + X(1.3) + '" y1="' + axisY + '" y2="' + axisY + '" stroke="#3a3a40"/>';
  vline(mid, 62, 178, '#d4d4d8', false);
  txt(mid, 192, 'mid implied APR', 'val');
  txt(X(-1), 192, 'mid − range', 'lbl'); txt(X(1), 192, 'mid + range', 'lbl');
  txt(X(-safe), 192, '− safe', 'lbl'); txt(X(safe), 192, '+ safe', 'lbl');
  txt(X(-1.15), 40, 'lower APR →', 'lbl'); txt(X(1.15), 40, '→ higher APR', 'lbl');
  txt(X(0.5 * (safe + 1)), 100, 'keep', 'val'); txt(X(-0.5 * (safe + 1)), 100, 'keep', 'val');
  txt(X(0.5 * safe), 140, 'too close', 'lbl'); txt(X(-0.5 * safe), 140, 'too close', 'lbl');
  txt(X(1.15), 140, 'out of band', 'lbl'); txt(X(-1.15), 140, 'out of band', 'lbl');
  txt(mid, 22, 'Rest at ' + (edge * 100).toFixed(0) + '% of the half-width; re-quote when out of band or closer than ' + (safe * 100).toFixed(0) + '%', 'val');
  svg.innerHTML = g;
}
window.addEventListener('message', function (e) { if (e.data && e.data.type === 'ow-params') { v = e.data.values || {}; draw(); } });
window.addEventListener('resize', draw);
draw();
</script></body></html>`

/**
 * Reward share: the band is not distance-weighted, so hourly reward =
 * side budget × sizeYu / (pool + sizeYu). Shown for a few pool sizes.
 */
const SHARE_HTML = `<!doctype html><html><head><meta charset="utf-8">${STYLE}</head><body>
<svg id="s" height="170"></svg>
<script>
var v = {};
function num(name, dflt) { var x = parseFloat(v[name]); return isFinite(x) ? x : dflt; }
function draw() {
  // Percent mode has no size to show — it is whatever the balance allows at
  // the moment of quoting. The shape of the curve is the point either way, so
  // it is drawn against a stand-in and labelled as one rather than quoting a
  // sizeYu that mode is ignoring.
  var percent = String(v['sizeMode'] || 'fixed') === 'percent';
  var size = percent ? 100 : num('sizeYu', 10);
  var W = Math.max(320, document.body.clientWidth - 26);
  var svg = document.getElementById('s');
  svg.setAttribute('width', W);
  svg.setAttribute('viewBox', '0 0 ' + W + ' 170');
  var pools = [1, 10, 50, 200, 1000];
  var x0 = 40, x1 = W - 24, baseY = 130, top = 40;
  var slot = (x1 - x0) / pools.length, barW = Math.min(60, slot * 0.5);
  var g = '<line x1="' + x0 + '" x2="' + x1 + '" y1="' + baseY + '" y2="' + baseY + '" stroke="#3a3a40"/>';
  pools.forEach(function (pool, i) {
    var share = size / (pool + size);
    var x = x0 + slot * i + (slot - barW) / 2;
    var h = share * (baseY - top);
    g += '<rect x="' + x + '" y="' + (baseY - h) + '" width="' + barW + '" height="' + h + '" fill="#818cf8" opacity="0.9" rx="2"/>';
    g += '<text x="' + (x + barW / 2) + '" y="' + (baseY - h - 5) + '" class="val" text-anchor="middle">' + (share * 100).toFixed(1) + '%</text>';
    g += '<text x="' + (x + barW / 2) + '" y="' + (baseY + 14) + '" class="lbl" text-anchor="middle">pool ' + pool + ' YU</text>';
  });
  g += '<text x="' + x0 + '" y="20" class="val">Share of the side budget with ' + size + ' YU in band' + (percent ? ' (example — percent mode sizes from your margin)' : '') + ', by pool size. Reward/h = budget × share.</text>';
  g += '<text x="' + x0 + '" y="160" class="lbl">Every YU in band earns the same — the edge is as good as the touch. Small pools pay.</text>';
  svg.innerHTML = g;
}
window.addEventListener('message', function (e) { if (e.data && e.data.type === 'ow-params') { v = e.data.values || {}; draw(); } });
window.addEventListener('resize', draw);
draw();
</script></body></html>`

export const makerIllustrations: ParamIllustration[] = [
  { section: 'Size', title: 'Reward share — what order size buys', html: SHARE_HTML, height: 185 },
  { section: 'Corridor', title: 'The corridor — where orders rest and when they move', html: CORRIDOR_HTML, height: 225 },
]
