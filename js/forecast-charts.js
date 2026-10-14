(function (root) {
  'use strict';

  const EV = root.EV = root.EV || {};
  const css = name => getComputedStyle(
    document.documentElement
  ).getPropertyValue(name).trim();

  const labelTime = value => new Date(value * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  class ForecastCharts {
    constructor(motionAllowed) {
      this.motionAllowed = motionAllowed;
      this.charts = {};
      this.forecasts = null;
      this.create('short', 'forecast-short-chart');
      this.create('medium', 'forecast-medium-chart');
    }

    create(key, canvasId) {
      const canvas = document.getElementById(canvasId);
      const fallback = document.getElementById(
        'forecast-' + key + '-chart-fallback'
      );
      if (!canvas) return;
      if (!root.Chart) {
        canvas.hidden = true;
        if (fallback) fallback.hidden = false;
        return;
      }
      this.charts[key] = new root.Chart(canvas, {
        type: 'line',
        data: {
          datasets: [
            {
              label: 'Actual voltage',
              data: [],
              yAxisID: 'voltage',
              borderColor: css('--cyan'),
              backgroundColor: css('--cyan'),
              borderWidth: 1.7,
              pointRadius: 0,
              tension: 0.2,
              parsing: false
            },
            {
              label: 'Forecast voltage',
              data: [],
              yAxisID: 'voltage',
              borderColor: css('--cyan'),
              backgroundColor: css('--cyan'),
              borderDash: [5, 4],
              borderWidth: 1.7,
              pointRadius: 0,
              tension: 0.2,
              parsing: false
            },
            {
              label: 'Actual temperature',
              data: [],
              yAxisID: 'temperature',
              borderColor: css('--amber'),
              backgroundColor: css('--amber'),
              borderWidth: 1.7,
              pointRadius: 0,
              tension: 0.2,
              parsing: false
            },
            {
              label: 'Forecast temperature',
              data: [],
              yAxisID: 'temperature',
              borderColor: css('--amber'),
              backgroundColor: css('--amber'),
              borderDash: [5, 4],
              borderWidth: 1.7,
              pointRadius: 0,
              tension: 0.2,
              parsing: false
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: this.motionAllowed() ? { duration: 250 } : false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: {
              display: true,
              labels: {
                color: css('--muted'),
                boxWidth: 12,
                boxHeight: 2,
                font: { size: 9 }
              }
            },
            tooltip: {
              callbacks: {
                title: items => items.length ? labelTime(items[0].parsed.x) : '',
                label: context => {
                  const isTemperature = context.dataset.yAxisID === 'temperature';
                  const unit = isTemperature ? ' °C' : ' V';
                  return context.dataset.label + ': ' +
                    context.parsed.y.toFixed(2) + unit;
                }
              }
            }
          },
          scales: {
            x: {
              type: 'linear',
              grid: { color: css('--line-soft'), drawTicks: false },
              ticks: {
                color: css('--faint'),
                maxTicksLimit: 5,
                maxRotation: 0,
                callback: labelTime,
                font: { size: 8 }
              }
            },
            voltage: {
              type: 'linear',
              position: 'left',
              title: { display: true, text: 'V', color: css('--cyan') },
              ticks: { color: css('--cyan'), font: { size: 8 } },
              grid: { color: css('--line-soft') }
            },
            temperature: {
              type: 'linear',
              position: 'right',
              title: { display: true, text: '°C', color: css('--amber') },
              ticks: { color: css('--amber'), font: { size: 8 } },
              grid: { drawOnChartArea: false }
            }
          }
        }
      });
    }

    update(forecasts) {
      this.forecasts = forecasts;
      ['short', 'medium'].forEach(key => {
        const chart = this.charts[key];
        if (!chart) return;
        const forecast = forecasts && forecasts[
          key === 'short' ? 'short_term' : 'medium_term'
        ];
        const actual = forecasts && Array.isArray(forecasts.actual_series)
          ? forecasts.actual_series
          : [];
        const duration = key === 'short' ? 60 : 300;
        const cutoff = forecasts &&
          Number.isFinite(forecasts.generated_at_timestamp)
          ? forecasts.generated_at_timestamp - duration
          : -Infinity;
        const visibleActual = actual.filter(
          item => item.timestamp >= cutoff
        );
        const projected = forecast &&
          Array.isArray(forecast.forecast_series)
          ? forecast.forecast_series
          : [];
        chart.data.datasets[0].data = visibleActual.map(item => ({
          x: item.timestamp,
          y: item.voltage
        }));
        chart.data.datasets[1].data = projected.map(item => ({
          x: item.timestamp,
          y: item.voltage
        }));
        chart.data.datasets[2].data = visibleActual.map(item => ({
          x: item.timestamp,
          y: item.temperature
        }));
        chart.data.datasets[3].data = projected.map(item => ({
          x: item.timestamp,
          y: item.temperature
        }));
        chart.options.animation = this.motionAllowed()
          ? { duration: 250 }
          : false;
        chart.update(this.motionAllowed() ? undefined : 'none');
      });
    }

    theme() {
      ['short', 'medium'].forEach(key => {
        const chart = this.charts[key];
        if (!chart) return;
        chart.data.datasets.forEach((dataset, index) => {
          const color = index < 2 ? css('--cyan') : css('--amber');
          dataset.borderColor = color;
          dataset.backgroundColor = color;
        });
        chart.options.scales.x.grid.color = css('--line-soft');
        chart.options.scales.x.ticks.color = css('--faint');
        chart.options.scales.voltage.title.color = css('--cyan');
        chart.options.scales.voltage.ticks.color = css('--cyan');
        chart.options.scales.temperature.title.color = css('--amber');
        chart.options.scales.temperature.ticks.color = css('--amber');
        chart.options.plugins.legend.labels.color = css('--muted');
        chart.update('none');
      });
    }

    resize() {
      Object.values(this.charts).forEach(chart => chart.resize());
    }

    destroy() {
      Object.values(this.charts).forEach(chart => chart.destroy());
      this.charts = {};
    }
  }

  EV.ForecastCharts = ForecastCharts;
})(window);
