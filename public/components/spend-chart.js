import { init, use } from 'echarts/core';
import { BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, DataZoomComponent, AriaComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import './spend-chart.css';

use([BarChart, GridComponent, TooltipComponent, DataZoomComponent, AriaComponent, SVGRenderer]);
const money = value => Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
let chart, resizeObserver, current;
const selected = new Map();

export function destroySpendChart() {
  resizeObserver?.disconnect();
  chart?.dispose();
  chart = null;
  current = null;
}

function draw() {
  if (!chart || !current) return;
  const { days, providers } = current;
  const styles = getComputedStyle(document.documentElement);
  const color = name => styles.getPropertyValue(name).trim();
  const colors = { anthropic: '--series-1', openai: '--series-2', google: '--series-3' };
  chart.setOption({
    animation: !matchMedia('(prefers-reduced-motion: reduce)').matches,
    animationDurationUpdate: 450,
    textStyle: { fontFamily: styles.getPropertyValue('--font-sans').trim(), color: color('--text-secondary') },
    aria: { enabled: true, description: 'Daily API usage spend in US dollars. Subscriptions are excluded. The data table below contains every value.' },
    grid: { left: 60, right: 16, top: 24, bottom: 82 },
    tooltip: { trigger: 'axis', confine: true, renderMode: 'richText', valueFormatter: money },
    xAxis: { type: 'category', data: days.map(d => d.date), axisTick: { show: false }, axisLine: { show: false }, axisLabel: { color: color('--text-muted'), formatter: v => v.slice(5) } },
    yAxis: { type: 'value', axisLabel: { color: color('--text-muted'), formatter: v => '$' + v.toLocaleString('en-US') }, splitLine: { lineStyle: { color: color('--grid'), type: 'dashed' } } },
    dataZoom: [{ type: 'slider', bottom: 8, height: 22, borderColor: color('--border'), textStyle: { color: color('--text-muted') } }],
    series: providers.map(p => ({
      id: p.name, name: p.label, type: 'bar', stack: 'usage', barMaxWidth: 16,
      itemStyle: { color: color(colors[p.name] || '--text-muted'), borderRadius: [3, 3, 0, 0] },
      emphasis: { focus: 'series' },
      data: days.map(d => selected.get(p.name) === false ? null : (d[p.name] || 0)),
    })),
  }, { replaceMerge: ['series'] });
}

export function renderSpendChart(container, data) {
  if (!chart || chart.getDom() !== container.querySelector('.spend-chart')) {
    destroySpendChart();
    container.innerHTML = '<div class="provider-filters" aria-label="Visible chart providers"></div><div class="spend-chart" role="img"></div><details class="chart-data"><summary>View daily usage data</summary><div class="chart-data-scroll"></div></details>';
    chart = init(container.querySelector('.spend-chart'), null, { renderer: 'svg' });
    resizeObserver = new ResizeObserver(() => chart?.resize());
    resizeObserver.observe(container);
  }
  current = data;
  const filters = container.querySelector('.provider-filters');
  filters.replaceChildren(...data.providers.map(p => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'btn btn-sm';
    button.textContent = p.label;
    button.setAttribute('aria-pressed', String(selected.get(p.name) !== false));
    button.addEventListener('click', () => {
      selected.set(p.name, selected.get(p.name) === false);
      button.setAttribute('aria-pressed', String(selected.get(p.name)));
      draw();
    });
    return button;
  }));
  const table = document.createElement('table');
  table.className = 'data-table';
  const caption = table.createCaption(); caption.textContent = 'Daily usage in USD · subscriptions excluded';
  const head = table.createTHead().insertRow();
  for (const title of ['Date (UTC)', ...data.providers.map(p => p.label), 'Total']) {
    const th = document.createElement('th'); th.scope = 'col'; th.textContent = title; head.append(th);
  }
  const body = table.createTBody();
  for (const day of data.days) {
    const row = body.insertRow();
    for (const value of [day.date, ...data.providers.map(p => money(day[p.name] || 0)), money(data.providers.reduce((sum, p) => sum + (day[p.name] || 0), 0))]) row.insertCell().textContent = value;
  }
  container.querySelector('.chart-data-scroll').replaceChildren(table);
  draw();
}
window.addEventListener('camaze-theme-change', draw);
window.addEventListener('pagehide', destroySpendChart);
