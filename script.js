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

  function scenarioLabel(scenario) {
    const labels = {
      'under-voltage': 'Under-voltage',
      'over-voltage': 'Over-voltage',
      'over-current': 'Over-current',
      'over-temperature': 'Over-temperature'
    };

    return String(scenario)
      .split(',')
      .map(id => EV.SCENARIOS[id]?.label || labels[id] || id)
      .join(', ');
  }

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
      'Independent synthetic, NASA battery, and SynCAN model outputs'
    ],
    settings: [
      'Workspace Settings',
      'Make this monitoring workspace your own'
    ]
  };
const source = new EV.ApiSource();

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
    table.innerHTML = rows.map(r => {
      const prediction = r.prediction || {};
      const probability = prediction.status === 'ready' &&
        Number.isFinite(prediction.failure_probability)
        ? (prediction.failure_probability * 100).toFixed(1) + '%'
        : prediction.status === 'warming_up'
          ? 'Warming up'
          : 'Unavailable';
      const modelCondition = Number.isFinite(r.health)
        ? r.health.toFixed(1) + ' / 100'
        : '—';

      return `
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
        <td>${escape(modelCondition)}</td>
        <td>${escape(probability)}</td>
        <td>${escape(scenarioLabel(r.scenario || 'normal'))}</td>
        <td>
          <span class="pill ${escape(r.diagnostics.severity)}">
            ${escape(r.diagnostics.label)}
          </span>
        </td>
      </tr>
    `;
    }).join('') || `
      <tr>
        <td colspan="8" class="empty">
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
              item.prediction && item.prediction.status,
              item.prediction &&
                item.prediction.failure_probability,
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
          <td>${escape(scenarioLabel(e.scenario))}</td>
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
          <th>Model condition</th>
          <th>Failure probability · 5 min</th>
          <th>Scenario</th>
          <th>Rule diagnostics</th>
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

  function updateDatasetModelCard(prefix, model) {
    const status = model.status || 'unavailable';
    const labels = {
      ready: 'Ready',
      missing_dataset: 'Missing dataset',
      not_trained: 'Not trained',
      load_error: 'Load error',
      unavailable: 'Unavailable'
    };
    const badge = $(prefix + '-model-status');
    badge.textContent = labels[status] || status;
    badge.className = 'pill ' + (
      status === 'ready'
        ? 'normal'
        : status === 'load_error' ? 'critical' : 'warning'
    );

    const dataset = model.dataset || {};
    const detail = status === 'ready'
      ? [
          'Loaded from ' + (model.artifact_path || 'model artifact'),
          model.metadata && model.metadata.discharge_cycles
            ? model.metadata.discharge_cycles + ' discharge cycles; evaluation metrics are available.'
            : '',
          model.metadata && model.metadata.evaluation
            ? 'Evaluation: ' + JSON.stringify(model.metadata.evaluation)
            : ''
        ].filter(Boolean).join('\n')
      : [
          model.error || 'FastAPI has not returned model status.',
          dataset.directory ? 'Data folder: ' + dataset.directory : '',
          dataset.missing_files && dataset.missing_files.length
            ? 'Missing files: ' + dataset.missing_files.join(', ')
            : '',
          model.download_url ? 'Official source: ' + model.download_url : '',
          model.training_command
            ? 'Training command: ' + model.training_command
            : '',
          model.artifact_path ? 'Expected model: ' + model.artifact_path : ''
        ].filter(Boolean).join('\n');
    $(prefix + '-model-detail').textContent = detail;
  }

  function showDatasetModelError(error) {
    ['nasa', 'syncan'].forEach(prefix => {
      updateDatasetModelCard(prefix, {
        status: 'unavailable',
        error: 'FastAPI model status unavailable: ' + error.message
      });
    });
  }

  function updateState(nextState, change) {
    if (change.type === 'error') {
      showDatasetModelError(change.error);
      toast('Could not apply scenario: ' + change.error.message);
      return;
    }

    const previous = state && state.current;

    state = nextState;

    const r = state.current;
    const d = r.diagnostics;
    const datasetModels = r.datasetModels || {};
    updateDatasetModelCard(
      'nasa',
      datasetModels.nasa_battery_capacity || {}
    );
    updateDatasetModelCard(
      'syncan',
      datasetModels.syncan_intrusion_detection || {}
    );

    ['voltage', 'current', 'temperature', 'health'].forEach(key => {
      if (Number.isFinite(r[key])) {
        animations.number(
          $('value-' + key),
          r[key],
          key === 'health' ? 1 : 1,
          initialRender
        );
      } else {
        $('value-' + key).textContent = '—';
      }

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

    const activeCodes = new Set((d.faults || []).map(fault => fault.code));
    const metricFaults = (d.faults || []).reduce((faults, fault) => {
      const metric = ({
        'under-voltage': 'voltage',
        'low-voltage': 'voltage',
        'over-voltage': 'voltage',
        'over-current': 'current',
        'over-temperature': 'temperature'
      })[fault.code];

      if (metric) {
        faults[metric] = faults[metric] || [];
        faults[metric].push(fault);
      }

      return faults;
    }, {});

    document.querySelectorAll('.metric-card').forEach(card => {
      const faults = metricFaults[card.dataset.metric] || [];
      const affected = faults.length > 0;
      const metricSeverity = faults.some(
        fault => fault.severity === 'critical'
      ) ? 'critical' : 'warning';

      card.classList.toggle(
        'is-fault',
        affected && metricSeverity === 'warning'
      );

      card.classList.toggle(
        'is-critical',
        affected && metricSeverity === 'critical'
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

      lastDiagnostic = d.code;

      icons();
    }

    const prediction = r.prediction || {};
    const predictionReady =
      prediction.status === 'ready' &&
      Number.isFinite(prediction.failure_probability);

    if (predictionReady) {
      const probability = Math.min(
        1,
        Math.max(0, prediction.failure_probability)
      );
      const probabilityPercent = probability * 100;
      const condition = 100 - probabilityPercent;
      const horizonMinutes = prediction.horizon_seconds / 60;

      $('risk-value').innerHTML =
        probabilityPercent.toFixed(1) + '<span>%</span>';
      $('risk-label').textContent = 'Failure probability · next 5 min';
      $('risk-label').className = 'risk-label';
      $('risk-explanation').textContent =
        (prediction.model && prediction.model.name
          ? prediction.model.name
          : 'Trained synthetic-data model') +
        ' · based on ' +
        prediction.history_count +
        ' recent readings. Fixed forecast horizon; not a countdown.';
      $('risk-progress').style.stroke = 'var(--cyan)';
      $('overview-health').textContent = condition.toFixed(1) + '%';
      $('health-ring-container').setAttribute(
        'aria-label',
        'Model-derived condition index ' + condition.toFixed(1) + ' percent.'
      );
      $('risk-ring-container').setAttribute(
        'aria-label',
        'Model-predicted failure probability within ' +
          horizonMinutes +
          ' minutes: ' +
          probabilityPercent.toFixed(1) +
          ' percent.'
      );
      animations.ring($('risk-progress'), probabilityPercent);
      animations.ring($('health-progress'), condition);
    } else {
      const unavailable = prediction.status === 'unavailable';
      const statusText = unavailable ? 'Model unavailable' : 'Warming up';
      $('risk-value').innerHTML = '—<span></span>';
      $('risk-label').textContent = 'Failure probability · next 5 min';
      $('risk-label').className = 'risk-label';
      $('risk-explanation').textContent = unavailable
        ? (prediction.message || 'Train the model to enable predictions.') +
          ' Fixed five-minute forecast horizon; not a countdown.'
        : (prediction.history_count || 0) +
          ' / ' +
          (prediction.window_size || 30) +
          ' readings collected for the model window. Fixed five-minute ' +
          'forecast horizon; not a countdown.';
      $('risk-progress').style.stroke = 'var(--faint)';
      $('overview-health').textContent = '—';
      $('health-ring-container').setAttribute(
        'aria-label',
        'Model-derived condition index unavailable.'
      );
      $('risk-ring-container').setAttribute(
        'aria-label',
        'Failure prediction ' + statusText.toLowerCase() + '.'
      );
      animations.ring($('risk-progress'), 0);
      animations.ring($('health-progress'), 0);
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
      const affectedSystems = Object.keys(d.systems)
        .filter(system => d.systems[system] !== 'normal');

      animations.flash(affectedSystems);
      if (affectedSystems.length) {
        twin.select(affectedSystems[0]);
      }
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
              $('risk-slot').appendChild($('diagnostics-panel'));
    }

    Object.keys(routes).forEach(key => {
      $('view-' + key).hidden = key !== route;
      $('view-' + key).classList.toggle('active', key === route);
    });

    document.querySelectorAll('[data-nav]').forEach(item => {
      const active = item.dataset.nav === route;

      item.classList.toggle('active', active);

      if (active) {
        item.setAttribute('aria-current', 'page');
      } else {
        item.removeAttribute('aria-current');
      }
    });

    $('page-title').textContent = routes[route][0];

    const dot = document.createElement('span');
    dot.className = 'title-dot';
    $('page-title').appendChild(dot);

    $('page-subtitle').textContent = routes[route][1];
    document.title = routes[route][0] + ' — EV Monitor';

    setMenu(false);

    if (state && route === 'fault-history') {
      renderHistory();
    }

    if (state && route === 'live-data') {
      renderReadings(
        state.readings.slice(-15).reverse(),
        $('live-table')
      );
    }

    if (userInitiated) {
      animations.route($('view-' + route));

      $('page-title').tabIndex = -1;
      $('page-title').focus({ preventScroll: true });

      window.scrollTo({
        top: 0,
        behavior: 'auto'
      });
    }

    requestAnimationFrame(() => charts.resize());
  }

  function openRoute(name) {
    if (location.hash === '#' + name) {
      navigate(name, true);
    } else {
      location.hash = name;
    }
  }

  function syncThemeControls(theme) {
    $('theme-select').value = theme;

    $('theme-toggle').setAttribute(
      'aria-pressed',
      String(theme === 'light')
    );

    $('theme-toggle').setAttribute(
      'aria-label',
      theme === 'dark'
        ? 'Switch to light theme'
        : 'Switch to dark theme'
    );

    document.querySelector('meta[name="theme-color"]').content =
      theme === 'dark' ? '#020817' : '#edf3fa';
  }

  function setTheme(theme) {
    if (!['dark', 'light'].includes(theme)) return;

    const keys = [
      '--bg',
      '--panel',
      '--panel-deep',
      '--sidebar',
      '--text',
      '--muted',
      '--faint',
      '--line',
      '--line-soft',
      '--cyan',
      '--blue',
      '--violet',
      '--green',
      '--amber',
      '--red'
    ];

    const old = Object.fromEntries(
      keys.map(key => [
        key,
        getComputedStyle(document.documentElement)
          .getPropertyValue(key)
          .trim()
      ])
    );

    animations.cancelTheme();
    document.documentElement.dataset.theme = theme;

    const next = Object.fromEntries(
      keys.map(key => [
        key,
        getComputedStyle(document.documentElement)
          .getPropertyValue(key)
          .trim()
      ])
    );

    storage.set('theme', theme);
    syncThemeControls(theme);

    animations.theme(old, next, () => charts.theme());
  }

  function downloadReport() {
    try {
      const report = source.report();

      const blob = new Blob(
        [JSON.stringify(report, null, 2)],
        { type: 'application/json;charset=utf-8' }
      );

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');

      link.href = url;
      link.download =
        'EV-Monitor-DEMO-' +
        new Date().toISOString().replace(/[:.]/g, '-') +
        '.json';

      document.body.appendChild(link);
      link.click();
      link.remove();

      setTimeout(() => URL.revokeObjectURL(url), 10000);

      toast(
        'Demo report prepared: ' +
        report.readings.length.toLocaleString() +
        ' readings and ' +
        report.events.length +
        ' events.'
      );
    } catch (error) {
      toast('Report could not be generated. Please try again.');
      console.error('Report export failed:', error);
    }
  }

  function openDialog(dialog) {
    dialog.showModal();
    animations.dialog(dialog);
  }

  function updateClock() {
    const now = new Date();

    $('date-label').textContent = now.toLocaleDateString([], {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    });

    $('date-label').dateTime = now.toISOString();

    $('time-label').textContent = now.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });

    $('time-label').dateTime = now.toISOString();
  }

  // Initialize the interface.
  statusMarkup();
  icons();
  syncThemeControls(initialTheme);

  $('motion-toggle').checked = animations.enabled;

  navigate(location.hash.slice(1));

  if (animations.allowed()) {
    $('risk-progress').setAttribute('stroke-dashoffset', '100');
    $('health-progress').setAttribute('stroke-dashoffset', '100');
  }

  const unsubscribe = source.subscribe(updateState);

  animations.entrance();
  animations.refreshAmbient();

  updateClock();

  const clockTimer = setInterval(updateClock, 1000);

  // Routing and mobile navigation.
  listen(window, 'hashchange', () => {
    navigate(location.hash.slice(1), true);
  });

  listen($('menu-button'), 'click', () => {
    setMenu(!menuOpen);
  });

  listen($('nav-scrim'), 'click', () => {
    setMenu(false);
  });

  listen(window, 'resize', () => {
    if (window.innerWidth > 900) {
      setMenu(false);
    } else {
      $('sidebar').inert = !menuOpen;
    }
  });

  listen(document, 'keydown', event => {
    if (event.key === 'Escape' && menuOpen) {
      setMenu(false);
      $('menu-button').focus();
    }
  });

  // Preferences.
  listen($('theme-toggle'), 'click', () => {
    setTheme(
      document.documentElement.dataset.theme === 'dark'
        ? 'light'
        : 'dark'
    );
  });

  listen($('theme-select'), 'change', event => {
    setTheme(event.target.value);
  });

  listen($('motion-toggle'), 'change', event => {
    storage.set('motion', event.target.checked ? 'on' : 'off');
    animations.setEnabled(event.target.checked);

    if (state) {
      charts.update(state, true);
    }
  });

  // Simulation controls.
  listen($('simulation-button'), 'click', () => {
    if (source.running) {
      source.pause();
    } else {
      source.start();
    }
  });

  listen($('reset-button'), 'click', () => {
    source.reset();
    toast('Reset to normal. Simulation paused; history retained.');
  });

  listen($('reset-view'), 'click', () => {
    twin.reset();
  });

  listen($('ecu-systems'), 'click', event => {
    const item = event.target.closest('[data-system]');

    if (item) {
      twin.select(item.dataset.system);
    }
  });

  listen($('time-range'), 'change', event => {
    charts.setRange(event.target.value);
  });

  // Fault scenario selector.
  listen($('fault-button'), 'click', () => {
    const selected = new Set(source.scenarios);
    document.querySelectorAll('input[name="scenario"]').forEach(input => {
      input.checked = input.value === 'normal'
        ? selected.size === 0
        : selected.has(input.value);
    });

    openDialog($('fault-dialog'));
  });

  listen($('fault-dialog'), 'change', event => {
    const input = event.target;
    if (!input.matches('input[name="scenario"]')) return;

    const normal = $('fault-dialog').querySelector(
      'input[name="scenario"][value="normal"]'
    );
    const selectedFaults = $('fault-dialog').querySelectorAll(
      'input[name="scenario"]:checked:not([value="normal"])'
    );

    if (input.value === 'normal' && input.checked) {
      $('fault-dialog').querySelectorAll(
        'input[name="scenario"]:not([value="normal"])'
      ).forEach(fault => {
        fault.checked = false;
      });
    } else if (input.checked) {
      normal.checked = false;
    } else if (!selectedFaults.length) {
      normal.checked = true;
    }
  });

  listen($('apply-scenario'), 'click', event => {
    event.preventDefault();

    const selected = Array.from(document.querySelectorAll(
      'input[name="scenario"]:checked'
    ))
      .map(input => input.value)
      .filter(scenario => scenario !== 'normal');

    source.setScenarios(selected);
    $('fault-dialog').close('apply');

    toast(
      (selected.length ? scenarioLabel(selected.join(',')) : 'Normal operation') +
      ' requested for the demo feed.'
    );
  });

  // Shared actions.
  document.querySelectorAll('[data-open-history]').forEach(button => {
    listen(button, 'click', () => {
      openRoute('fault-history');
    });
  });

  document.querySelectorAll('[data-download]').forEach(button => {
    listen(button, 'click', downloadReport);
  });

  // History filters and pagination.
  document.querySelectorAll('[data-history-filter]').forEach(button => {
    listen(button, 'click', () => {
      historyFilter = button.dataset.historyFilter;
      historyPage = 0;

      document.querySelectorAll('[data-history-filter]').forEach(item => {
        const active = item === button;

        item.classList.toggle('active', active);
        item.setAttribute('aria-pressed', String(active));
      });

      renderHistory();
    });
  });

  listen($('history-search'), 'input', event => {
    historyQuery = event.target.value.trim().toLowerCase();
    historyPage = 0;
    renderHistory();
  });

  listen($('history-prev'), 'click', () => {
    historyPage--;
    renderHistory();
  });

  listen($('history-next'), 'click', () => {
    historyPage++;
    renderHistory();
  });

  // Notifications.
  listen($('notification-button'), 'click', () => {
    renderNotifications();

    document.querySelector('.notification-dot').hidden = true;

    $('notification-button').setAttribute(
      'aria-label',
      'Open notifications'
    );

    openDialog($('notifications-dialog'));
  });

  listen(
    document.querySelector('[data-close-notifications]'),
    'click',
    () => $('notifications-dialog').close()
  );

  listen($('notification-history'), 'click', () => {
    $('notifications-dialog').close();
    openRoute('fault-history');
  });

  // Clicking the backdrop closes a dialog.
  document.querySelectorAll('dialog').forEach(dialog => {
    listen(dialog, 'click', event => {
      if (event.target !== dialog) return;

      const bounds = dialog.getBoundingClientRect();

      if (
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      ) {
        dialog.close();
      }
    });
  });

  // Graceful degradation if a CDN dependency is unavailable.
  const missing = [];

  if (!window.gsap) {
    missing.push('GSAP unavailable: motion disabled');
  }

  if (!window.Chart) {
    missing.push('Chart.js unavailable: using the SVG telemetry graph');
  }

  if (!window.lucide) {
    missing.push('Lucide unavailable: text controls remain usable');
  }

  if (missing.length) {
    $('dependency-warning').textContent =
      missing.join('. ') +
      '. Check your internet connection for the full visual experience.';

    $('dependency-warning').hidden = false;
  }

  // BFCache restores keep the app instance; ordinary navigation cleans up.
  listen(window, 'pagehide', event => {
    if (event.persisted) {
      source.pause();
      return;
    }

    unsubscribe();
    source.destroy();
    charts.destroy();
    twin.destroy();
    animations.destroy();

    clearInterval(clockTimer);
    clearTimeout(toastTimer);

    controller.abort();
  });
})();