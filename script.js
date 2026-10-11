(function () {
  'use strict';

  const EV = window.EV;
  const $ = id => document.getElementById(id);

  const escape = value => String(value).replace(
    /[&<>"']/g,
    char => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[char]
  );

  const icons = () => {
    if (window.lucide) {
      window.lucide.createIcons({
        attrs: {
          'aria-hidden': 'true',
          'stroke-width': 1.65
        }
      });
    }
  };

  const storage = {
    get(key, fallback) {
      try {
        return localStorage.getItem('ev-monitor-' + key) || fallback;
      } catch (_) {
        return fallback;
      }
    },

    set(key, value) {
      try {
        localStorage.setItem('ev-monitor-' + key, value);
      } catch (_) {
        // Browser privacy restrictions must not block the application.
      }
    }
  };

  const time = timestamp => new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  const fullDate = timestamp => new Date(timestamp).toLocaleString();

  const stateLabel = state => ({
    normal: 'Normal',
    warning: 'Warning',
    critical: 'Critical'
  })[state] || 'Unknown';

  const routes = {
    dashboard: [
      'EV System Overview',
      'Real-time vehicle intelligence at a glance'
    ],
    'digital-twin': [
      'Digital Twin',
      'An inside look at the electric vehicle'
    ],
    'live-data': [
      'Live Data',
      'A single source of simulated vehicle telemetry'
    ],
    'fault-history': [
      'Fault History',
      'A traceable record of your demo session'
    ],
    'predictive-analytics': [
      'Predictive Analytics',
      'Transparent demo diagnostics — no AI model connected'
    ],
    settings: [
      'Workspace Settings',
      'Make this monitoring workspace your own'
    ]
  };

  const source = new EV.DemoSource();

  const initialTheme =
    storage.get('theme', 'dark') === 'light' ? 'light' : 'dark';

  document.documentElement.dataset.theme = initialTheme;

  const animations = new EV.Animations(
    storage.get('motion', 'on') !== 'off'
  );

  const charts = new EV.SensorCharts(
    $('sensor-chart'),
    $('chart-fallback'),
    () => animations.allowed()
  );

  const twin = new EV.DigitalTwin(
    $('vehicle-stage'),
    id => {
      document.querySelectorAll('.system-item').forEach(item => {
        const selected = item.dataset.system === id;
        item.classList.toggle('selected', selected);
        item.setAttribute('aria-pressed', String(selected));
      });
    },
    () => animations.allowed()
  );

  let state = null;
  let route = 'dashboard';
  let initialRender = true;
  let lastDiagnostic = null;
  let toastTimer = null;

  let historyFilter = 'events';
  let historyPage = 0;
  let historyQuery = '';
  let menuOpen = false;

  const controller = new AbortController();

  const listen = (target, type, handler) => {
    target.addEventListener(type, handler, {
      signal: controller.signal
    });
  };

  // Retain one live instance of each shared panel.
  const homes = [
    'twin-panel',
    'sensor-panel',
    'diagnostics-panel'
  ].map(id => {
    const node = $(id);
    const anchor = document.createComment('Home position: ' + id);

    node.before(anchor);

    return { node, anchor };
  });

  function toast(message) {
    clearTimeout(toastTimer);

    $('toast').textContent = message;
    $('toast').hidden = false;

    toastTimer = setTimeout(() => {
      $('toast').hidden = true;
    }, 4200);
  }

  function statusMarkup() {
    $('ecu-systems').innerHTML = EV.SYSTEMS.map(system => `
      <button
        class="system-item"
        data-system="${system.id}"
        data-state="normal"
        aria-pressed="false"
      >
        <span class="status-dot"></span>
        <span>
          <strong>${system.name}</strong>
          <small>Normal</small>
        </span>
      </button>
    `).join('');

    $('overview-systems').innerHTML = [
      ['battery', 'Battery', 'battery-charging'],
      ['motor', 'Motor', 'cog'],
      ['thermal', 'Thermal', 'thermometer'],
      ['communication', 'Communication', 'radio']
    ].map(([id, label, icon]) => `
      <div
        class="overview-row"
        data-overview="${id}"
        data-state="normal"
      >
        <i data-lucide="${icon}"></i>
        <span>${label}</span>
        <span class="overview-status">Normal</span>
      </div>
    `).join('');
  }

  function renderReadings(rows, table) {
    table.innerHTML = rows.map(r => `
      <tr>
        <td>
          <time datetime="${new Date(r.timestamp).toISOString()}">
            ${escape(time(r.timestamp))}
          </time>
          ${r.seeded ? '<span class="subtle-badge">SEEDED</span>' : ''}
        </td>
        <td>${r.voltage.toFixed(1)} V</td>
        <td>${r.current.toFixed(1)} A</td>
        <td>${r.temperature.toFixed(1)} °C</td>
        <td>${r.health} / 100</td>
        <td>
          <span class="pill ${escape(r.diagnostics.severity)}">
            ${escape(r.diagnostics.label)}
          </span>
        </td>
      </tr>
    `).join('') || `
      <tr>
        <td colspan="6" class="empty">
          No readings match this filter.
        </td>
      </tr>
    `;
  }

  function renderHistory() {
    if (!state) return;

    const samples = state.readings.filter(r => !r.seeded).length;
    const faults = state.events.filter(e => e.type === 'fault').length;

    $('history-summary').innerHTML = `
      <span>
        <strong>${samples.toLocaleString()}</strong>
        Session samples
      </span>
      <span>
        <strong>${faults}</strong>
        Fault events
      </span>
      <span>
        <strong>${state.events.length}</strong>
        Total events
      </span>
    `;

    let items = historyFilter === 'events'
      ? state.events
      : state.readings;

    items = items
      .filter(item => {
        const values = historyFilter === 'events'
          ? [item.type, item.title, item.scenario, item.message]
          : [
              item.scenario,
              item.diagnostics.label,
              item.seeded ? 'seeded' : 'session'
            ];

        return values
          .join(' ')
          .toLowerCase()
          .includes(historyQuery);
      })
      .slice()
      .reverse();

    const pages = Math.max(1, Math.ceil(items.length / 25));

    historyPage = Math.max(0, Math.min(historyPage, pages - 1));

    const slice = items.slice(
      historyPage * 25,
      historyPage * 25 + 25
    );

    $('history-count').textContent =
      items.length.toLocaleString() +
      ' matching ' +
      historyFilter +
      (
        historyFilter === 'readings'
          ? ' · SEEDED rows are synthetic pre-session history'
          : ' · all events belong to this browser session'
      );

    if (historyFilter === 'events') {
      $('history-head').innerHTML = `
        <tr>
          <th>Time</th>
          <th>Event</th>
          <th>Scenario</th>
          <th>Status</th>
        </tr>
      `;

      $('history-table').innerHTML = slice.map(e => `
        <tr>
          <td>
            <time datetime="${new Date(e.timestamp).toISOString()}">
              ${escape(fullDate(e.timestamp))}
            </time>
          </td>
          <td>${escape(e.title)}</td>
          <td>${escape(EV.SCENARIOS[e.scenario].label)}</td>
          <td>
            <span class="pill ${escape(e.severity)}">
              ${stateLabel(e.severity)}
            </span>
          </td>
        </tr>
      `).join('') || `
        <tr>
          <td colspan="4" class="empty">
            No events match this filter.
          </td>
        </tr>
      `;
    } else {
      $('history-head').innerHTML = `
        <tr>
          <th>Time</th>
          <th>Voltage</th>
          <th>Current</th>
          <th>Temperature</th>
          <th>Health · demo</th>
          <th>Scenario</th>
        </tr>
      `;

      renderReadings(slice, $('history-table'));
    }

    $('history-page').textContent =
      (historyPage + 1) + ' / ' + pages;

    $('history-prev').disabled = historyPage === 0;
    $('history-next').disabled = historyPage >= pages - 1;
  }

  function renderNotifications() {
    if (!state) return;

    $('notification-list').innerHTML = state.events
      .slice(-8)
      .reverse()
      .map(e => `
        <article class="notification-entry">
          <strong>${escape(e.title)}</strong>
          <time datetime="${new Date(e.timestamp).toISOString()}">
            ${escape(fullDate(e.timestamp))} · DEMO
          </time>
          ${e.message ? '<p>' + escape(e.message) + '</p>' : ''}
        </article>
      `)
      .join('');
  }

  function updateState(nextState, change) {
    const previous = state && state.current;

    state = nextState;

    const r = state.current;
    const d = r.diagnostics;

    ['voltage', 'current', 'temperature', 'health'].forEach(key => {
      animations.number(
        $('value-' + key),
        r[key],
        key === 'health' ? 0 : 1,
        initialRender
      );

      if (key !== 'health') {
        const delta = previous && previous[key]
          ? (r[key] - previous[key]) / previous[key] * 100
          : 0;

        const indicator = delta > .01
          ? '↗ '
          : delta < -.01
            ? '↘ '
            : '— ';

        $('trend-' + key).textContent = previous
          ? indicator + Math.abs(delta).toFixed(1) + '%'
          : '—';

        $('trend-' + key).title =
          'Change from previous received demo sample';
      }
    });

    const activeMetric = {
      'under-voltage': 'voltage',
      'over-current': 'current',
      'over-temperature': 'temperature'
    }[d.code];

    document.querySelectorAll('.metric-card').forEach(card => {
      const affected =
        card.dataset.metric === activeMetric ||
        (
          card.dataset.metric === 'health' &&
          d.code !== 'normal'
        );

      card.classList.toggle(
        'is-fault',
        affected && d.severity === 'warning'
      );

      card.classList.toggle(
        'is-critical',
        affected && d.severity === 'critical'
      );

      if (card.dataset.metric !== 'health') {
        $('note-' + card.dataset.metric).textContent = affected
          ? d.label + ' · demo'
          : 'Demo operating band';
      }
    });

    $('health-badge').className = 'pill ' + d.severity;
    $('health-badge').textContent = stateLabel(d.severity);

    document.querySelectorAll('.system-item').forEach(item => {
      const status = d.systems[item.dataset.system];

      item.dataset.state = status;
      item.querySelector('small').textContent = stateLabel(status);
    });

    document.querySelectorAll('.overview-row').forEach(item => {
      const status = item.dataset.overview === 'communication'
        ? 'normal'
        : d.systems[item.dataset.overview];

      item.dataset.state = status;

      item.querySelector('.overview-status').textContent =
        stateLabel(status);
    });

    // Only announce diagnostic state changes, not every sample.
    if (lastDiagnostic !== d.code) {
      $('alert-box').className = 'alert-box ' + d.severity;

      $('alert-title').textContent = d.code === 'normal'
        ? 'No active demo faults'
        : d.label + (
            d.severity === 'critical'
              ? ' critical · demo'
              : ' warning · demo'
          );

      $('alert-description').textContent = d.description;

      $('alert-box').querySelector('svg, i').outerHTML =
        '<i data-lucide="' +
        (d.code === 'normal' ? 'circle-check' : 'triangle-alert') +
        '"></i>';

      $('risk-label').textContent = d.severity === 'normal'
        ? 'Low risk'
        : d.severity === 'critical'
          ? 'High demo risk'
          : 'Elevated demo risk';

      const riskColor = d.severity === 'normal'
        ? 'green'
        : d.severity === 'critical'
          ? 'red'
          : 'amber';

      $('risk-label').style.color = `var(--${riskColor})`;
      $('risk-progress').style.stroke = `var(--${riskColor})`;

      $('risk-explanation').textContent = d.code === 'normal'
        ? 'Normal demo scenario. No immediate simulated fault.'
        : d.label + ' scenario active. Illustrative score only.';

      $('risk-value').innerHTML = d.risk + '<span>%</span>';
      $('overview-health').textContent = d.health + '%';

      $('risk-ring-container').setAttribute(
        'aria-label',
        'Simulated risk ' +
          d.risk +
          ' percent. Not an AI prediction.'
      );

      $('health-ring-container').setAttribute(
        'aria-label',
        'Illustrative demo health ' + d.health + ' percent.'
      );

      animations.ring($('risk-progress'), d.risk);
      animations.ring($('health-progress'), d.health);

      lastDiagnostic = d.code;

      icons();
    }

    $('session-state').textContent = state.running
      ? 'SIMULATION RUNNING'
      : 'SIMULATOR PAUSED';

    $('session-state').classList.toggle('running', state.running);

    $('connection-label').textContent = state.running
      ? 'Demo feed running'
      : 'Demo feed paused';

    $('connection-dot').style.background = state.running
      ? 'var(--green)'
      : 'var(--cyan)';

    $('last-updated').textContent = 'Last sample: ' + time(r.timestamp);

    $('chart-live').textContent = state.running
      ? '● DEMO LIVE'
      : 'PAUSED';

    $('chart-live').style.color = state.running
      ? 'var(--green)'
      : 'var(--faint)';

    const simulationButton = $('simulation-button');

    simulationButton.querySelector('span').textContent = state.running
      ? 'Pause Simulation'
      : 'Start Simulation';

    simulationButton.setAttribute(
      'aria-pressed',
      String(state.running)
    );

    const desiredIcon = state.running ? 'pause' : 'play';

    if (simulationButton.dataset.icon !== desiredIcon) {
      simulationButton.querySelector('svg, i').outerHTML =
        '<i data-lucide="' + desiredIcon + '"></i>';

      simulationButton.dataset.icon = desiredIcon;

      icons();
    }

    twin.update(state);
    charts.update(state, initialRender);

    if (route === 'live-data') {
      renderReadings(
        state.readings.slice(-15).reverse(),
        $('live-table')
      );
    }

    if (route === 'fault-history') {
      renderHistory();
    }

    if ($('notifications-dialog').open) {
      renderNotifications();
    }

    if (change.event && change.event.type === 'fault') {
      document.querySelector('.notification-dot').hidden = false;

      $('notification-button').setAttribute(
        'aria-label',
        'Open notifications, new simulated fault'
      );

      animations.alert();
      animations.flash(EV.SCENARIOS[r.scenario].systems);
      twin.select(EV.SCENARIOS[r.scenario].systems[0]);
    }

    initialRender = false;
  }

  function setMenu(open) {
    menuOpen = open;

    $('sidebar').classList.toggle('is-open', open);
    $('nav-scrim').hidden = !open;

    $('menu-button').setAttribute('aria-expanded', String(open));

    $('menu-button').setAttribute(
      'aria-label',
      open ? 'Close navigation' : 'Open navigation'
    );

    if (window.innerWidth <= 900) {
      $('sidebar').inert = !open;
    } else {
      $('sidebar').inert = false;
    }
  }

  function navigate(name, userInitiated = false) {
    if (!Object.prototype.hasOwnProperty.call(routes, name)) {
      name = 'dashboard';
    }

    route = name;

    homes.forEach(({ node, anchor }) => {
      anchor.after(node);
    });

    if (route === 'digital-twin') {
      $('twin-slot').appendChild($('twin-panel'));
    }

    if (route === 'live-data') {
      $('chart-slot').appendChild($('sensor-panel'));
    }

    if (route === 'predictive-analytics') {
