/**
 * Visualiser page — thin wrapper over vasturiano's force-graph, not a
 * reimplementation.
 *
 * WHY the switch (2026-10-21): the hand-rolled canvas version had to invent its
 * own force simulation and dot rendering, and it never looked right. force-graph
 * (MIT, ~177 KB, vendored into vendor/ so it works offline) is the library the
 * reference screenshot's look comes from: 2D canvas, d3-force, small nodes,
 * thin links, per-node colour and value accessors. What is left to write is only
 * the part that is ours — reading /graph and lighting nodes from /events.
 *
 * Contract with the server: GET /graph → {nodes:[{id,label,group,size}],
 * edges:[{source,target}]}; GET /events?since=seq → {seq, events:[{seq,
 * notePath}]}. Only paths and structure ever leave the process.
 */
export const GRAPH_UI_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>记忆图 · 检索点亮</title>
<style>
  html,body { margin:0; height:100%; background:#1e1e1e; overflow:hidden;
    font:12px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',
      'Hiragino Sans GB','Microsoft YaHei',Helvetica,Arial,sans-serif;
    color:#8a8a8a; -webkit-font-smoothing:antialiased; }
  #g { position:fixed; inset:0; }
  .hud { position:fixed; pointer-events:none; user-select:none; z-index:2; }
  #tl { left:16px; top:14px; display:flex; align-items:center; gap:8px; }
  #tl b { color:#f0eee6; font-weight:600; font-variant-numeric:tabular-nums; }
  #tl .s { color:#57534e; }
  #tag { padding:1px 7px; border-radius:999px; border:1px solid rgba(240,238,230,0.14);
    color:#b8b5ac; font-size:11px; }
  #br { right:16px; bottom:14px; color:#57534e; font-size:11px; }
  #legend { position:fixed; right:16px; top:14px; text-align:right; font-size:11px;
    z-index:2; pointer-events:none; }
  #legend div { margin-bottom:4px; color:#8a8a8a; display:flex; align-items:center;
    justify-content:flex-end; gap:7px; }
  #legend i { width:6px; height:6px; border-radius:50%; }
</style></head>
<body>
<div id="g"></div>
<div class="hud" id="tl">
  <b id="hit">0</b><span>命中</span><span class="s">/</span>
  <b id="ev">0</b><span>事件</span>
  <span id="tag">连接中</span>
</div>
<div id="legend"></div>
<div class="hud" id="br">记忆库 · 检索实时点亮</div>
<script src="/vendor/force-graph.min.js"></script>
<script>
var PALETTE = ['#D97757','#7F9C6E','#5B8FB9','#9A7BA6','#C9A227','#C77E7E','#6FA39A'];
var groupColor = {}, since = 0, evCount = 0, nodes = [];
var tag = document.getElementById('tag');

window.addEventListener('error', function (e) {
  if (tag) tag.textContent = '错误: ' + (e.message || 'unknown');
});

function heatOf(n) { return n.heat || 0; }

var Graph = ForceGraph()(document.getElementById('g'))
  .backgroundColor('#1e1e1e')
  .nodeId('id')
  .nodeLabel(function (n) { return n.label; })
  .nodeVal(function (n) { return Math.pow(n.size || 0.3, 1.4) * 8; })
  .nodeRelSize(3.2)
  .linkColor(function (l) {
    var h = Math.max(heatOf(l.source), heatOf(l.target));
    return h > 0.02 ? 'rgba(255,232,214,' + (0.25 + h * 0.7) + ')' : 'rgba(200,200,200,0.20)';
  })
  .linkWidth(function (l) {
    var h = Math.max(heatOf(l.source), heatOf(l.target));
    return h > 0.02 ? 0.8 + h * 1.1 : 0.4;
  })
  .onEngineStop(function () { Graph.zoomToFit(500, 50); });

// d3 forces tuned to the reference: tight clusters, a few long bridges
Graph.d3Force('charge').strength(-55);
Graph.d3Force('link').distance(26).strength(0.85);

function paint() {
  Graph.nodeColor(function (n) {
    return heatOf(n) > 0.02 ? '#FFF3E6' : (groupColor[n.group] || '#cfcfcf');
  });
}

function loadGraph() {
  fetch('/graph').then(function (r) { return r.json(); }).then(function (g) {
    nodes = g.nodes.map(function (n) { n.heat = 0; return n; });
    var gs = [];
    nodes.forEach(function (n) { if (gs.indexOf(n.group) < 0) gs.push(n.group); });
    gs.sort();
    gs.forEach(function (gr, k) { groupColor[gr] = PALETTE[k % PALETTE.length]; });
    document.getElementById('legend').innerHTML = gs.slice(0, 7).map(function (gr) {
      return '<div>' + gr + '<i style="background:' + groupColor[gr] + '"></i></div>';
    }).join('');
    Graph.graphData({ nodes: nodes, links: g.edges });
    paint();
    tag.textContent = '已连接 · ' + nodes.length + ' 节点 / ' + g.edges.length + ' 连线';
  }).catch(function (e) { tag.textContent = '取图失败: ' + e.message; });
}

function poll() {
  fetch('/events?since=' + since).then(function (r) { return r.json(); }).then(function (d) {
    if (d.events && d.events.length) {
      document.getElementById('hit').textContent = d.events.length;
      var byId = {};
      nodes.forEach(function (n) { byId[n.id] = n; });
      d.events.forEach(function (e) {
        since = Math.max(since, e.seq);
        evCount++;
        var n = byId[e.notePath];
        if (n) n.heat = 1;
      });
      document.getElementById('ev').textContent = evCount;
    }
  }).catch(function () { tag.textContent = '断线'; });
}

// decay + repaint: force-graph stops repainting once the engine settles, so a
// settled graph needs an explicit refresh to show a new hit fading out
setInterval(function () {
  var alive = false;
  nodes.forEach(function (n) {
    if (n.heat > 0) { n.heat = Math.max(0, n.heat - 0.02); alive = true; }
  });
  if (alive) Graph.refresh();
}, 50);

setInterval(poll, 700);
loadGraph();
</script></body></html>`;
