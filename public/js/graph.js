/* FirmLedger relationship graph — radial SVG, zero dependencies */
(function () {
  'use strict';
  var host = document.getElementById('relGraph');
  var dataEl = document.getElementById('relGraphData');
  if (!host || !dataEl) return;

  var data;
  try { data = JSON.parse(dataEl.textContent); } catch (e) { return; }
  var items = (data.items || []).slice(0, 12);
  if (!items.length) return;

  var NS = 'http://www.w3.org/2000/svg';
  var W = 720, H = 460, CX = W / 2, CY = H / 2;
  var R = Math.min(W, H) / 2 - 92;

  var COLORS = {
    founder: '#A16207', investor: '#1d4ed8', parent_company: '#0E7B4F',
    subsidiary: '#0E7B4F', product: '#6d28d9', service: '#be185d', partner: '#0e7490',
  };
  function color(rel) { return COLORS[rel] || '#5e6c84'; }
  function short(name, n) { name = name || ''; return name.length > n ? name.slice(0, n - 1).trimEnd() + '…' : name; }
  function initial(name) { return (name || '?').trim().charAt(0).toUpperCase(); }
  function el(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'presentation' }, host);
  el('circle', { cx: CX, cy: CY, r: R, fill: 'none', stroke: '#E7E4DC', 'stroke-dasharray': '3 5' }, svg);
  el('circle', { cx: CX, cy: CY, r: R / 2, fill: 'none', stroke: '#F0EDE6', 'stroke-dasharray': '2 6' }, svg);

  // edges + nodes
  items.forEach(function (item, i) {
    var angle = (Math.PI * 2 * i) / items.length - Math.PI / 2;
    // alternate two radii to reduce label collisions
    var radius = (i % 2 === 0 ? R : R * 0.62);
    var x = CX + radius * Math.cos(angle);
    var y = CY + radius * Math.sin(angle);
    var c = color(item.rel);

    el('line', { x1: CX, y1: CY, x2: x, y2: y, stroke: c, 'stroke-width': 1.6, opacity: 0.5 }, svg);

    // relationship label at midpoint
    var mx = CX + (radius * 0.5) * Math.cos(angle);
    var my = CY + (radius * 0.5) * Math.sin(angle);
    var lbg = el('g', { transform: 'translate(' + mx + ',' + my + ')' }, svg);
    var lt = el('text', {
      y: 4, 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 700,
      'font-family': 'JetBrains Mono, monospace', fill: c,
    }, lbg);
    lt.textContent = short(item.relLabel || item.rel, 22);
    var bboxW = Math.min(lt.getComputedTextLength ? lt.getComputedTextLength() : 80, 150);
    var bbg = el('rect', {
      x: -bboxW / 2 - 6, y: -9, width: bboxW + 12, height: 20, rx: 10,
      fill: '#ffffff', stroke: c, 'stroke-opacity': 0.35,
    }, lbg);
    lbg.insertBefore(bbg, lt);

    // node
    var g = el('g', { class: 'rel-node' + (item.slug ? ' linkable' : ''), transform: 'translate(' + x + ',' + y + ')' }, svg);
    if (item.slug) {
      g.addEventListener('click', function () { window.location.href = '/listing/' + item.slug; });
    }
    el('circle', {
      r: 30, fill: '#ffffff', stroke: c, 'stroke-width': 2,
      'stroke-dasharray': item.slug ? 'none' : '4 3',
    }, g);
    var t = el('text', {
      y: 8, 'text-anchor': 'middle', 'font-size': 20, 'font-weight': 600,
      'font-family': 'Fraunces, Georgia, serif', fill: c,
    }, g);
    t.textContent = initial(item.name);
    if (item.claimed) {
      el('circle', { cx: 21, cy: -21, r: 8, fill: '#0e9f6e', stroke: '#fff', 'stroke-width': 2 }, g);
      var ck = el('text', { x: 21, y: -16.5, 'text-anchor': 'middle', 'font-size': 9.5, 'font-weight': 800, fill: '#fff' }, g);
      ck.textContent = '✓';
    }
    var name = el('text', {
      y: 48, 'text-anchor': 'middle', 'font-size': 12.5, 'font-weight': 600,
      'font-family': 'Inter, sans-serif', fill: '#22304a',
    }, g);
    name.textContent = short(item.name, 18);
    if (item.note) {
      var nt = el('text', { y: 63, 'text-anchor': 'middle', 'font-size': 10, fill: '#5e6c84', 'font-family': 'Inter, sans-serif' }, g);
      nt.textContent = short(item.note, 24);
    }
    var title = el('title', {}, g);
    title.textContent = item.name + ' — ' + (item.relLabel || item.rel);
  });

  // center node (on top)
  var cg = el('g', { transform: 'translate(' + CX + ',' + CY + ')' }, svg);
  el('circle', { r: 46, fill: '#0e1626' }, cg);
  el('circle', { r: 46, fill: 'none', stroke: '#e5c07b', 'stroke-width': 2 }, cg);
  var ct = el('text', {
    y: 11, 'text-anchor': 'middle', 'font-size': 30, 'font-weight': 600,
    'font-family': 'Fraunces, Georgia, serif', fill: '#e5c07b',
  }, cg);
  ct.textContent = initial(data.center.name);
  var cn = el('text', {
    y: 70, 'text-anchor': 'middle', 'font-size': 13.5, 'font-weight': 700,
    'font-family': 'Inter, sans-serif', fill: '#0e1626',
  }, cg);
  cn.textContent = short(data.center.name, 24);

  // legend
  var legend = document.getElementById('relGraphLegend');
  if (legend) {
    var seen = {};
    items.forEach(function (item) {
      var label = item.relLabel || item.rel;
      if (seen[label]) return;
      seen[label] = true;
      var s = document.createElement('span');
      s.className = 'legend-item';
      var d = document.createElement('span');
      d.className = 'legend-dot';
      d.style.background = color(item.rel);
      s.appendChild(d);
      s.appendChild(document.createTextNode(label));
      legend.appendChild(s);
    });
  }
})();
