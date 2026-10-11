(function (root) {
  'use strict';

  const EV = root.EV = root.EV || {};

  const series = [
    {
      key: 'voltage',
      label: 'Voltage',
      unit: 'V',
      color: '--cyan',
      axis: 'volts',
      min: 250,
      max: 375,
      position: 'left'
    },
    {
      key: 'current',
      label: 'Current',
      unit: 'A',
      color: '--violet',
      axis: 'amps',
      min: 0,
      max: 110,
      position: 'right'
    },
    {
      key: 'temperature',
      label: 'Temperature',
      unit: '°C',
      color: '--amber',
      axis: 'degrees',
      min: 20,
      max: 85,
      position: 'right'
    }
  ];

  const css = name => getComputedStyle(
    document.documentElement
  ).getPropertyValue(name).trim();

  const labelTime = timestamp => new Date(
    timestamp
  ).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });

  class SensorCharts {
    constructor(canvas, fallback, motionAllowed) {
      this.canvas = canvas;
      this.fallback = fallback;
      this.motionAllowed = motionAllowed;

      this.minutes = 5;
      this.state = null;
      this.chart = null;

      if (root.Chart) {
        this.create();
      } else {
        this.canvas.hidden = true;
        this.fallback.hidden = false;
      }
    }

    create() {
      const scales = {
        x: {
          type: 'linear',
          grid: {
            color: css('--line-soft'),
            drawTicks: false
          },
          border: {
            display: false
          },
          ticks: {
            maxTicksLimit: 5,
            maxRotation: 0,
            color: css('--faint'),
            font: {
              size: 8
            },
            callback: value => labelTime(value)
          }
        }
      };

      series.forEach(item => {
        scales[item.axis] = {
          type: 'linear',
          position: item.position,
          min: item.min,
          max: item.max,

          title: {
            display: true,
            text: item.unit,
            color: css(item.color),
            font: {
              size: 8
            }
          },

          grid: {
            drawOnChartArea: item.axis === 'volts',
            color: css('--line-soft'),
            drawTicks: false
          },

          border: {
            display: false
          },

          ticks: {
            count: 4,
            color: css(item.color),
            font: {
              size: 8
            },
            padding: 4
          }
        };
      });

      this.chart = new root.Chart(this.canvas, {
        type: 'line',

        data: {
          datasets: series.map(item => ({
            label: item.label,
            yAxisID: item.axis,
            data: [],
            borderColor: css(item.color),
            backgroundColor: css(item.color),
            borderWidth: 1.6,
            pointRadius: 0,
            pointHitRadius: 8,
            pointHoverRadius: 3,
            tension: .3,
            parsing: false
          }))
        },

        options: {
          responsive: true,
          maintainAspectRatio: false,
          normalized: true,

          animation: this.motionAllowed()
            ? {
                duration: 480,
                easing: 'easeOutQuart'
              }
            : false,

          interaction: {
            mode: 'index',
            intersect: false
          },

          plugins: {
            legend: {
              display: false
            },

            tooltip: {
              backgroundColor: css('--panel-deep'),
              titleColor: css('--text'),
              bodyColor: css('--muted'),
              borderColor: css('--line'),
              borderWidth: 1,
              padding: 11,
              displayColors: true,

              titleFont: {
                size: 10
              },

              bodyFont: {
                size: 10
              },

              callbacks: {
                title: items => items.length
                  ? new Date(
                      items[0].parsed.x
                    ).toLocaleTimeString()
                  : '',

                label: context =>
                  context.dataset.label +
                  ': ' +
                  context.parsed.y.toFixed(1) +
                  ' ' +
                  series[context.datasetIndex].unit
              }
            }
          },

          scales
        }
      });
    }

    visibleReadings() {
      if (!this.state) return [];

      // A paused chart remains anchored to the latest recorded sample.
      const end = this.state.current.timestamp;
      const begin = end - this.minutes * 60000;

      return this.state.readings.filter(
        reading =>
          reading.timestamp >= begin &&
          reading.timestamp <= end
      );
    }

    update(state, instant = false) {
      this.state = state;

      const readings = this.visibleReadings();

      document.getElementById('sample-count').textContent =
        readings.length.toLocaleString() + ' samples';

      if (this.chart) {
        this.chart.options.animation =
          this.motionAllowed() && !instant
            ? {
                duration: 480,
                easing: 'easeOutQuart'
              }
            : false;

        this.chart.options.scales.x.min =
          state.current.timestamp - this.minutes * 60000;

        this.chart.options.scales.x.max =
          state.current.timestamp;

        series.forEach((item, index) => {
          this.chart.data.datasets[index].data =
            readings.map(reading => ({
              x: reading.timestamp,
              y: reading[item.key]
            }));
        });

        this.chart.update(
          instant || !this.motionAllowed()
            ? 'none'
            : undefined
        );
      } else {
        this.drawFallback(readings);
      }

      this.sparklines(state.readings.slice(-28));
    }

    setRange(minutes) {
      if (![1, 5, 30].includes(Number(minutes))) return;

      this.minutes = Number(minutes);

      if (this.state) {
        this.update(this.state);
      }
    }

    sparklines(readings) {
      document.querySelectorAll('[data-spark]').forEach(svg => {
        const values = readings.map(
          reading => reading[svg.dataset.spark]
        );

        const minimum = Math.min(...values);
        const maximum = Math.max(...values);
        const span = Math.max(maximum - minimum, .1);

        const path = values.map((value, index) => {
          const command = index ? 'L' : 'M';

          const x = (
            index / Math.max(values.length - 1, 1) * 151 + 2
          ).toFixed(2);

          const y = (
            maximum === minimum
              ? 16
              : 28 - (value - minimum) / span * 24
          ).toFixed(2);

          return `${command}${x},${y}`;
        }).join(' ');

        const target = svg.querySelector('path');

        if (root.gsap) {
          root.gsap.killTweensOf(target);
        }

        if (
          this.motionAllowed() &&
          target.getAttribute('d')
        ) {
          root.gsap.to(target, {
            attr: {
              d: path
            },
            duration: .45,
            ease: 'power1.out',
            overwrite: true
          });
        } else {
          target.setAttribute('d', path);
        }
      });
    }

    drawFallback(readings) {
      const width = 600;
      const left = 44;
      const right = 85;
      const top = 14;
      const bottom = 32;
      const height = 200;

      const x0 =
        this.state.current.timestamp - this.minutes * 60000;

      const plotW = width - left - right;
      const plotH = height - top - bottom;

      const parts = [];

      for (let i = 0; i < 4; i++) {
        const y = top + i * plotH / 3;

        parts.push(
          `<path
            d="M${left},${y}H${width - right}"
            stroke="${css('--line')}"
            fill="none"
          />`
        );

        series.forEach((item, index) => {
          const x = index === 0
            ? 4
            : width - right + 8 + (index - 1) * 40;

          const value = Math.round(
            item.max - (item.max - item.min) * i / 3
          );

          parts.push(
            `<text
              x="${x}"
              y="${y + 3}"
              fill="${css(item.color)}"
              font-size="9"
            >${value}${item.unit}</text>`
          );
        });
      }

      series.forEach(item => {
        const path = readings.map((reading, index) => {
          const command = index ? 'L' : 'M';

          const x = (
            left +
            (reading.timestamp - x0) /
            (this.minutes * 60000) *
            plotW
          ).toFixed(2);

          const y = (
            top +
            (item.max - reading[item.key]) /
            (item.max - item.min) *
            plotH
          ).toFixed(2);

          return `${command}${x},${y}`;
        }).join(' ');

        parts.push(
          `<path
            d="${path}"
            fill="none"
            stroke="${css(item.color)}"
            stroke-width="1.5"
          />`
        );
      });

      for (let i = 0; i < 4; i++) {
        parts.push(
          `<text
            x="${left + i * plotW / 3}"
            y="192"
            text-anchor="middle"
            fill="${css('--muted')}"
            font-size="9"
          >${labelTime(x0 + i * this.minutes * 60000 / 3)}</text>`
        );
      }

      this.fallback.innerHTML = parts.join('');
    }

    theme() {
      if (!this.chart) {
        if (this.state) {
          this.drawFallback(this.visibleReadings());
        }

        return;
      }

      const options = this.chart.options;

      options.scales.x.ticks.color = css('--faint');
      options.scales.x.grid.color = css('--line-soft');

      series.forEach((item, index) => {
        this.chart.data.datasets[index].borderColor =
          css(item.color);

        this.chart.data.datasets[index].backgroundColor =
          css(item.color);

        options.scales[item.axis].ticks.color =
          css(item.color);

        options.scales[item.axis].title.color =
          css(item.color);

        options.scales[item.axis].grid.color =
          css('--line-soft');
      });

      Object.assign(options.plugins.tooltip, {
        backgroundColor: css('--panel-deep'),
        titleColor: css('--text'),
        bodyColor: css('--muted'),
        borderColor: css('--line')
      });

      this.chart.update('none');
    }

    resize() {
      if (this.chart) {
        this.chart.resize();
      }
    }

    destroy() {
      if (this.chart) {
        this.chart.destroy();
      }

      if (root.gsap) {
        document.querySelectorAll('.sparkline path').forEach(path => {
          root.gsap.killTweensOf(path);
        });
      }
    }
  }

  EV.SensorCharts = SensorCharts;
})(window);
