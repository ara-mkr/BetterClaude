/**
 * Hand-rolled Canvas 2D chart rendering for the Usage Analytics Dashboard —
 * no charting library dependency, consistent with this app's existing
 * dependency-light hand-rolled visuals (confetti/parallax in
 * core/motion-fx.js). DOM-only (Canvas 2D API), no Node/Electron APIs.
 */

const PALETTE = ["#8b5cf6", "#22c55e", "#f59e0b", "#ef4444", "#38bdf8", "#f472b6", "#a3e635", "#fb923c"];

function setupCanvas(canvas, widthCss, heightCss) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = widthCss * dpr;
  canvas.height = heightCss * dpr;
  canvas.style.width = `${widthCss}px`;
  canvas.style.height = `${heightCss}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, widthCss, heightCss);
  return ctx;
}

function renderLineChart(canvas, { labels, series }, { width = 640, height = 220, color = "#8b5cf6" } = {}) {
  const ctx = setupCanvas(canvas, width, height);
  const padding = { top: 16, right: 16, bottom: 28, left: 44 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  ctx.font = "10px -apple-system, sans-serif";
  ctx.textAlign = "left";

  if (!labels || labels.length === 0) {
    ctx.fillStyle = "rgba(236,231,251,0.65)";
    ctx.fillText("No data in this range.", padding.left, height / 2);
    return;
  }

  const maxVal = Math.max(1, ...series);
  const stepX = labels.length > 1 ? plotW / (labels.length - 1) : 0;

  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.fillStyle = "rgba(236,231,251,0.65)";
  for (let i = 0; i <= 4; i += 1) {
    const y = padding.top + plotH - (plotH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + plotW, y);
    ctx.stroke();
    ctx.fillText(String(Math.round((maxVal * i) / 4)), 4, y + 3);
  }

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  series.forEach((val, i) => {
    const x = padding.left + stepX * i;
    const y = padding.top + plotH - (plotH * val) / maxVal;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.fillStyle = color;
  series.forEach((val, i) => {
    const x = padding.left + stepX * i;
    const y = padding.top + plotH - (plotH * val) / maxVal;
    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.fillStyle = "rgba(236,231,251,0.65)";
  const showIdx = new Set([0, labels.length - 1, Math.floor(labels.length / 2)]);
  showIdx.forEach((i) => {
    const x = padding.left + stepX * i;
    ctx.fillText(labels[i], Math.max(padding.left, Math.min(x - 14, width - 40)), height - 8);
  });
}

function renderBarChart(canvas, { labels, values }, { width = 640, height = 220 } = {}) {
  const ctx = setupCanvas(canvas, width, height);
  const padding = { top: 16, right: 16, bottom: 44, left: 16 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  ctx.font = "10px -apple-system, sans-serif";

  if (!labels || labels.length === 0) {
    ctx.fillStyle = "rgba(236,231,251,0.65)";
    ctx.textAlign = "left";
    ctx.fillText("No data in this range.", padding.left, height / 2);
    return;
  }

  const maxVal = Math.max(1, ...values);
  const gap = 8;
  const barW = Math.max(4, (plotW - gap * (labels.length - 1)) / labels.length);
  const rotateLabels = labels.length > 6;

  labels.forEach((label, i) => {
    const val = values[i] || 0;
    const barH = maxVal > 0 ? (plotH * val) / maxVal : 0;
    const x = padding.left + i * (barW + gap);
    const y = padding.top + plotH - barH;
    ctx.fillStyle = PALETTE[i % PALETTE.length];
    ctx.fillRect(x, y, barW, barH);

    ctx.fillStyle = "rgba(236,231,251,0.9)";
    ctx.textAlign = "center";
    ctx.fillText(String(val), x + barW / 2, y - 4);

    ctx.fillStyle = "rgba(236,231,251,0.85)";
    ctx.save();
    ctx.translate(x + barW / 2, height - padding.bottom + 10);
    if (rotateLabels) ctx.rotate(-Math.PI / 4);
    ctx.textAlign = rotateLabels ? "right" : "center";
    const truncated = label.length > 16 ? `${label.slice(0, 15)}…` : label;
    ctx.fillText(truncated, 0, 0);
    ctx.restore();
  });
}

module.exports = { renderLineChart, renderBarChart, PALETTE };
