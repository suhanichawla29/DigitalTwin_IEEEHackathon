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
  const forecastCharts = new EV.ForecastCharts(
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
  let latestLiveState = null;
  let dashboardSourceMode = 'simulator';
  let manualCsvPreview = [];
  let manualRecords = [];
  let manualSelectedKey = null;
  let pendingManualRequest = null;
  let pendingBatchRequest = null;
  let route = 'dashboard';
  let initialRender = true;
  let lastDiagnostic = null;
  let toastTimer = null;

  let historyFilter = 'events';
  let historyPage = 0;
  let historyQuery = '';
  let menuOpen = false;
  let canHistoryPaused = false;
  let canHistoryFilter = '';
  let selectedCanMessage = null;
  let canHistoryClearedAt = 0;

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
        <td>${Number.isFinite(r.voltage) ? r.voltage.toFixed(1) + ' V' : 'Unavailable'}</td>
        <td>${Number.isFinite(r.current) ? r.current.toFixed(1) + ' A' : 'Unavailable'}</td>
        <td>${Number.isFinite(r.temperature)
          ? r.temperature.toFixed(1) + ' °C'
          : 'Unavailable'}</td>
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

  function renderCanHistory() {
    if (!state) return;

    const messages = Array.isArray(state.canMessages)
      ? state.canMessages
      : [];
    const matching = messages.filter(message =>
      Number(message.timestamp) >= canHistoryClearedAt &&
      [
        message.can_id,
        message.message_name,
        message.source_ecu,
        message.payload_hex
      ].join(' ').toLowerCase().includes(canHistoryFilter)
    );
    const newest = matching.slice().reverse();
    const selected = newest.find(message =>
      message.timestamp + ':' + message.can_id === selectedCanMessage
    ) || newest[0] || null;

    if (selected) {
      selectedCanMessage = selected.timestamp + ':' + selected.can_id;
    }

    const rowMarkup = message => {
      const signals = (message.decoded_signals || [])
        .map(signal => {
          const value = Number(signal.value);
          const rendered = Number.isFinite(value)
            ? value.toFixed(2)
            : String(signal.value);
          return escape(signal.name + ': ' + rendered +
            (signal.unit ? ' ' + signal.unit : ''));
        })
        .join(' · ');
      const key = message.timestamp + ':' + message.can_id;
      const decodeState = message.decode_status === 'decoded'
        ? 'Decoded'
        : 'Error: ' + (message.error || 'unavailable');
      const canTime = Number(message.timestamp) * 1000;
      const evAnomaly = message.ev_anomaly || {};
      const evScore = Number(evAnomaly.anomaly_score);
      const evAnomalyState = evAnomaly.status === 'evaluated'
        ? (evAnomaly.is_anomaly ? 'Anomaly' : 'Normal') +
          (Number.isFinite(evScore) ? ' · ' + evScore.toFixed(2) : '')
        : evAnomaly.status === 'warming_up'
          ? 'Warming up'
          : evAnomaly.status === 'model_unavailable'
            ? 'Model unavailable'
            : evAnomaly.status === 'not_evaluated'
              ? 'Not evaluated'
              : 'Unavailable';
      return `
        <tr
          class="can-message-row${key === selectedCanMessage ? ' selected' : ''}"
          data-can-key="${escape(key)}"
          tabindex="0"
          role="button"
          aria-label="Inspect ${escape(message.can_id)} ${escape(message.message_name || 'unknown message')}"
          aria-pressed="${key === selectedCanMessage}"
        >
          <td><time datetime="${new Date(canTime).toISOString()}">${escape(time(canTime))}</time></td>
          <td><code>${escape(message.can_id || 'Unknown')}</code></td>
          <td>${escape(message.message_name || 'Unknown')}</td>
          <td>${escape(message.source_ecu || 'Unknown')}</td>
          <td>${escape(message.dlc)}</td>
          <td><code>${escape(message.payload_hex || 'Unavailable')}</code></td>
          <td>${signals || 'Unavailable'}</td>
          <td title="${escape(evAnomaly.reason || evAnomaly.source || '')}">${escape(evAnomalyState)}</td>
          <td>${escape(decodeState)}</td>
        </tr>
      `;
    };

    $('can-history-live-count').textContent =
      matching.length + ' / ' + messages.length + ' recent frames';
    $('can-history-table').innerHTML = newest.slice(0, 25).map(rowMarkup).join('')
      || '<tr><td colspan="9" class="empty">CAN message history is empty.</td></tr>';
    $('can-history-count').textContent =
      'Showing up to 25 of ' + matching.length + ' matching frames';

    if (!selected) {
      $('can-message-detail').innerHTML =
        '<p>Select a CAN message to inspect its payload and decoded signals.</p>';
      return;
    }

    const detailSignals = (selected.decoded_signals || []).map(signal => `
      <div class="can-signal-detail">
        <span>${escape(signal.name)}</span>
        <strong>${escape(Number.isFinite(Number(signal.value))
          ? Number(signal.value).toFixed(2)
          : signal.value)}${signal.unit ? ' ' + escape(signal.unit) : ''}</strong>
      </div>
    `).join('') || '<p>No decoded signals are available for this frame.</p>';
    const selectedEv = selected.ev_anomaly || {};
    const selectedEvScore = Number(selectedEv.anomaly_score);
    const evDetail = selectedEv.status === 'evaluated'
      ? (selectedEv.is_anomaly ? 'Anomaly' : 'Normal') +
        (Number.isFinite(selectedEvScore)
          ? ' · classifier score: ' + selectedEvScore.toFixed(3)
          : '') +
        (selectedEv.reason ? ' · ' + selectedEv.reason : '')
      : selectedEv.reason ||
        (selectedEv.status === 'warming_up'
          ? 'Waiting for another decoded frame.'
          : selectedEv.status === 'model_unavailable'
            ? 'EV simulator anomaly model unavailable.'
            : 'EV simulator anomaly result unavailable.');

    $('can-message-detail').innerHTML = `
      <div class="can-detail-payload">
        <span>Raw payload · ${escape(selected.dlc)} bytes</span>
        <code>${escape(selected.payload_hex || 'Unavailable')}</code>
      </div>
      <div class="can-detail-signals">
        <span>Decoded signals · ${escape(selected.message_name || 'Unknown message')}</span>
        ${detailSignals}
      </div>
      <p class="can-decode-note">
        ${escape(selected.decode_status === 'decoded'
          ? 'DBC decoder: decoded'
          : 'DBC decoder error: ' + (selected.error || 'unknown error'))}
        · EV simulator detector (${escape(selectedEv.source || 'unavailable')}): ${escape(evDetail)}
      </p>
    `;
  }

  function selectCanMessage(event) {
    const row = event.target.closest('tr[data-can-key]');
    if (!row) return;
    selectedCanMessage = row.dataset.canKey;
    renderCanHistory();
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

  function updateForecastCard(prefix, horizon) {
    const status = horizon && horizon.status === 'ready'
      ? 'Ready'
      : 'Collecting data';
    const statusElement = $('forecast-' + prefix + '-status');
    statusElement.textContent = status;
    statusElement.className = 'pill ' + (
      status === 'Ready' ? 'normal' : 'warning'
    );

    ['voltage', 'temperature'].forEach(signal => {
      const result = horizon && horizon.signals
        ? horizon.signals[signal]
        : null;
      const actual = result && Number.isFinite(result.actual)
        ? result.actual
        : null;
      const predicted = result && Number.isFinite(result.predicted)
        ? result.predicted
        : null;
      const unit = signal === 'voltage' ? 'V' : '°C';
      $(`forecast-${prefix}-${signal}`).textContent =
        (actual === null ? '—' : actual.toFixed(1) + ' ' + unit) +
        ' → ' +
        (predicted === null ? '—' : predicted.toFixed(1) + ' ' + unit);
    });

    const warningMessages = [];
    ['voltage', 'temperature'].forEach(signal => {
      const result = horizon && horizon.signals
        ? horizon.signals[signal]
        : null;
      (result && result.warning_assessment || []).forEach(warning => {
        warningMessages.push(warning.message);
      });
    });
    const warningElement = $('forecast-' + prefix + '-warning');
    warningElement.textContent = warningMessages.length
      ? warningMessages.join(' ')
      : status === 'Ready'
        ? 'Recent trend does not project a warning-limit crossing within this horizon.'
        : 'Collecting telemetry for this forecast horizon.';
    warningElement.classList.toggle(
      'is-warning',
      warningMessages.length > 0
    );

    const comparisons = horizon && horizon.chronological_comparison || {};
    const comparisonLines = ['voltage', 'temperature'].map(signal => {
      const comparison = comparisons[signal];
      if (!comparison || comparison.status !== 'evaluated') return null;
      const metrics = comparison.metrics;
      const unit = signal === 'voltage' ? 'V' : '°C';
      return signal + ': trend MAE ' +
        metrics.linear_trend_mae.toFixed(2) + ' ' + unit +
        ', persistence MAE ' +
        metrics.persistence_mae.toFixed(2) + ' ' + unit +
        ' (n=' + comparison.sample_count + ')';
    }).filter(Boolean);
    $('forecast-' + prefix + '-comparison').textContent =
      comparisonLines.length
        ? 'Rolling-origin chronological MAE — ' +
          comparisonLines.join('; ') + '.'
        : 'Chronological comparison needs at least 10 held-out horizon pairs.';
  }

  function renderMultiLevelForecast(forecasts) {
    forecastCharts.update(forecasts);
    const ready = forecasts && forecasts.status === 'ready';
    const overall = $('forecast-overall-status');
    overall.textContent = ready ? 'Ready' : 'Collecting data';
    overall.className = 'pill ' + (ready ? 'normal' : 'warning');
    $('forecast-history-count').textContent = forecasts
      ? (forecasts.history_count === forecasts.total_history_count
          ? forecasts.total_history_count + ' persisted readings'
          : forecasts.history_count + ' recent of ' +
            forecasts.total_history_count + ' persisted readings') +
        ' · minimum ' +
        forecasts.minimum_history
      : '0 readings · minimum 15';

    const lastReading = forecasts && forecasts.last_reading;
    $('forecast-last-updated').textContent = lastReading
      ? 'Last persisted reading: ' + time(lastReading.timestamp * 1000)
      : 'No persisted readings yet';

    updateForecastCard(
      'short',
      forecasts && forecasts.short_term
    );
    updateForecastCard(
      'medium',
      forecasts && forecasts.medium_term
    );
  }

  function formatManualValue(value, unit) {
    return Number.isFinite(value) ? value.toFixed(2) + ' ' + unit : 'Missing';
  }

  function manualAssessmentStatus(record) {
    return record.result?.assessment?.status ||
      record.submission_status ||
      'invalid_input';
  }

  function renderManualResult(record) {
    const result = record.result || {};
    const assessment = result.assessment || {};
    const status = manualAssessmentStatus(record);
    const statusClass = ['normal', 'warning', 'critical'].includes(status)
      ? status
      : 'offline';
    const normalized = result.normalized_readings || {};
    const rules = result.triggered_rules || [];
    const comparison = result.comparison || {};
    const model = result.model_result || {};
    const errors = record.validation?.errors || result.errors || [];
    const missing = result.missing_fields || [];
    const suggestions = result.suggested_checks || [];
    const content = $('manual-result-content');
    const ruleMarkup = rules.length
      ? `<ul>${rules.map(rule => `
          <li><strong>${escape(rule.label || rule.code)}</strong>:
            observed ${escape(rule.observed === null ? 'missing' : rule.observed)}
            ${escape(rule.unit || '')};
            ${escape(rule.threshold || 'configured rule triggered')}.
          </li>`).join('')}</ul>`
      : '<p>No threshold rules were triggered.</p>';
    const compareMarkup = Object.keys(comparison).length
      ? `<ul>${Object.entries(comparison).map(([name, item]) => `
          <li>${escape(name)} changed ${escape(Number(item.change).toFixed(2))}
            ${escape(item.unit)} from previous reading
            (${escape(fullDate(item.previous_timestamp * 1000))}).</li>
        `).join('')}</ul>`
      : '<p>No earlier compatible reading is available for comparison.</p>';
    const errorMarkup = errors.length
      ? `<ul>${errors.map(item => `<li>${escape(item.field)}: ${escape(item.message)}</li>`).join('')}</ul>`
      : '';
    const limitations = (result.limitations || []).map(item =>
      `<li>${escape(item)}</li>`
    ).join('');
    const suggestionMarkup = suggestions.length
      ? `<ul class="manual-suggestion">${suggestions.map(item => `<li>${escape(item)}</li>`).join('')}</ul>`
      : '<p>Suggestions are not a confirmed root cause.</p>';

    $('manual-result-empty').hidden = true;
    $('manual-result-status').className = 'pill ' + statusClass;
    $('manual-result-status').textContent =
      assessment.label || (
        status === 'invalid_input' ? 'Invalid input' : stateLabel(status)
      );
    content.hidden = false;
    content.innerHTML = `
      <div class="manual-result-grid">
        <section class="manual-result-block">
          <h4>Assessment · ${escape(record.source || 'manual')}</h4>
          <p>${escape(fullDate((record.timestamp || record.created_at) * 1000))}</p>
          <p>Voltage ${escape(formatManualValue(normalized.voltage, 'V'))} ·
            current ${escape(formatManualValue(normalized.current, 'A'))} ·
            temperature ${escape(formatManualValue(normalized.temperature, '°C'))}</p>
          ${missing.length ? `<p>Missing signals: ${escape(missing.join(', '))}.</p>` : ''}
          ${errorMarkup}
        </section>
        <section class="manual-result-block">
          <h4>Threshold diagnostics</h4>
          ${ruleMarkup}
        </section>
        <section class="manual-result-block">
          <h4>EV simulator model · ${escape(model.status || 'not evaluated')}</h4>
          <p>${escape(model.reason || model.message || model.score_type ||
            'Model output is reported separately from threshold diagnostics.')}</p>
          ${Number.isFinite(model.anomaly_score)
            ? `<p>Model score: ${escape(model.anomaly_score)}</p>`
            : ''}
          <p>Not a model-native explanation unless explicitly provided by the detector.</p>
        </section>
        <section class="manual-result-block">
          <h4>Earlier-reading comparison</h4>
          ${compareMarkup}
          <p>CAN: ${escape(result.can_result?.status || 'not processed')}
            ${result.can_result?.message_name
              ? ' · ' + escape(result.can_result.message_name) +
                ' · ' + escape(result.can_result.payload_hex || '')
              : ''}</p>
        </section>
        <section class="manual-result-block">
          <h4>Limitations</h4>
          <ul>${limitations || '<li>No additional limitation metadata returned.</li>'}</ul>
        </section>
        <section class="manual-result-block">
          <h4>Suggested checks · not confirmed causes</h4>
          ${suggestionMarkup}
        </section>
      </div>
    `;
  }

  function renderManualHistory(records) {
    const rows = $('manual-history-rows');
    rows.innerHTML = records.map(record => {
      const result = record.result || {};
      const normalized = result.normalized_readings || {};
      const rules = (result.triggered_rules || [])
        .map(rule => rule.label || rule.code)
        .join(', ');
      const status = manualAssessmentStatus(record);
      const message = rules ||
        result.errors?.map(item => item.message).join('; ') ||
        result.model_result?.reason ||
        'No threshold rules triggered.';
      return `
        <tr tabindex="0" role="button"
            data-manual-key="${escape(record.idempotency_key)}"
            aria-label="Inspect ${escape(record.source)} submission from ${escape(fullDate((record.timestamp || record.created_at) * 1000))}">
          <td>${escape(fullDate((record.timestamp || record.created_at) * 1000))}</td>
          <td>${escape(record.source)}</td>
          <td><span class="pill ${['normal', 'warning', 'critical'].includes(status) ? status : 'offline'}">${escape(result.assessment?.label || status)}</span></td>
          <td>${escape(result.model_result?.status || 'not evaluated')}</td>
          <td>${escape(message)} · V ${escape(formatManualValue(normalized.voltage, 'V'))}, A ${escape(formatManualValue(normalized.current, 'A'))}, °C ${escape(formatManualValue(normalized.temperature, '°C'))}</td>
        </tr>`;
    }).join('') || '<tr><td colspan="5" class="empty">No saved submissions for this source.</td></tr>';
  }

  function manualDashboardState(records, forecasts, sourceName) {
    const processed = records
      .filter(record =>
        record.submission_status === 'processed' &&
        record.result?.status === 'processed' &&
        Number.isFinite(Number(record.timestamp))
      )
      .slice()
      .sort((left, right) => left.timestamp - right.timestamp);
    const readings = processed.map(record => {
      const result = record.result;
      const values = result.normalized_readings || {};
      const diagnostics = EV.deriveDiagnostics({
        diagnostics: result.diagnostics || { faults: [] }
      });
      return {
        timestamp: Number(record.timestamp) * 1000,
        voltage: values.voltage === null ? null : Number(values.voltage),
        current: values.current === null ? null : Number(values.current),
        temperature: values.temperature === null ? null : Number(values.temperature),
        sensorAvailability: {
          voltage: values.voltage !== null && values.voltage !== undefined,
          current: values.current !== null && values.current !== undefined,
          temperature: values.temperature !== null && values.temperature !== undefined
        },
        health: null,
        prediction: {
          status: 'unavailable',
          failure_probability: null,
          history_count: 0,
          window_size: 30,
          horizon_seconds: 300,
          message: 'The live simulator failure-probability model is not used for manual input.'
        },
        forecasts,
        datasetModels: latestLiveState?.current?.datasetModels || {},
        canMessages: [],
        scenario: sourceName === 'manual' ? 'Manual input' : 'Preset simulated',
        seeded: false,
        source: sourceName === 'manual' ? 'MANUAL_INPUT' : 'SIMULATED_PRESET',
        diagnostics
      };
    });

    const events = [];
    let previousFault = false;
    processed.forEach((record, index) => {
      const result = record.result;
      const diagnostic = result.diagnostics || { faults: [] };
      const faults = diagnostic.faults || [];
      const modelAnomaly =
        result.assessment?.model_result === 'model_detected_anomaly';
      const active = faults.length > 0 || modelAnomaly;
      const timestamp = Number(record.timestamp) * 1000;
      if (active) {
        events.push({
          timestamp,
          type: 'fault',
          title: faults.map(fault => fault.label).join(', ') ||
            'EV simulator model anomaly',
          scenario: sourceName === 'manual' ? 'Manual input' : 'Preset simulated',
          severity: faults.some(fault => fault.severity === 'critical')
            ? 'critical'
            : 'warning',
          message: (faults.map(fault => fault.description).join(' ') ||
            result.model_result?.reason || 'Model reported an anomaly.') +
            ' Submission: ' + record.idempotency_key,
          eventId: record.event_id
        });
      } else if (previousFault) {
        events.push({
          timestamp,
          type: 'recovery',
          title: 'Returned to normal operation',
          scenario: sourceName === 'manual' ? 'Manual input' : 'Preset simulated',
          severity: 'normal',
          message: 'A later submitted reading no longer triggered a fault rule.',
          eventId: record.event_id
        });
      }
      previousFault = active;
      readings[index].manualSubmissionKey = record.idempotency_key;
    });

    const latest = readings[readings.length - 1];
    if (!latest) return null;
    return {
      current: latest,
      readings: readings.slice(-300),
      events,
      canMessages: [],
      running: false
    };
  }

  function updateManualSourceBanner(snapshot) {
    const sourceName = dashboardSourceMode;
    const label = sourceName === 'manual'
      ? 'MANUAL INPUT'
      : sourceName === 'preset_simulated'
        ? 'PRESET SIMULATED'
        : 'LIVE SIMULATOR';
    $('manual-source-status').className = 'pill ' +
      (sourceName === 'simulator' ? 'normal' : 'warning');
    $('manual-source-status').textContent = label;
    const timestamp = snapshot?.current?.timestamp;
    $('manual-source-timestamp').textContent = timestamp
      ? 'Displaying selected source · last sample ' + fullDate(timestamp)
      : sourceName === 'simulator'
        ? 'Displaying the existing simulated CAN feed.'
        : 'No processed readings are available for this source yet.';
    $('forecast-overall-status').setAttribute(
      'aria-label',
      'Forecast status for ' + label.toLowerCase()
    );
    $('multilevel-forecast-title').nextElementSibling.textContent =
      sourceName === 'simulator'
        ? 'Recent-trend projections from persisted, DBC-decoded simulator telemetry'
        : 'Recent-trend projections from only the selected, timestamped input source';
  }

  async function loadManualDashboard(sourceName = dashboardSourceMode) {
    if (sourceName === 'simulator') return;
    $('manual-source-timestamp').textContent = 'Loading saved ' +
      (sourceName === 'manual' ? 'manual input' : 'preset example') +
      ' history…';
    try {
      const [history, forecasts] = await Promise.all([
        EV.getManualHistory(sourceName, 300),
        EV.getSourceForecast(sourceName)
      ]);
      if (dashboardSourceMode !== sourceName) return;
      manualRecords = history.submissions || [];
      renderManualHistory(manualRecords);
      const snapshot = manualDashboardState(
        manualRecords,
        forecasts,
        sourceName
      );
      updateManualSourceBanner(snapshot);
      renderMultiLevelForecast(forecasts);
      if (snapshot) {
        lastDiagnostic = null;
        updateState(snapshot, {});
      } else {
        setManualEmptyDashboard();
        renderMultiLevelForecast(forecasts);
        updateManualSourceBanner(null);
        $('manual-source-timestamp').textContent =
          'No processed readings are available for this source yet. Submissions remain saved in its history.';
        $('manual-result-empty').hidden = false;
      }
    } catch (error) {
      $('manual-source-timestamp').textContent =
        'Could not load selected-source history: ' + error.message;
      $('manual-source-status').className = 'pill critical';
      $('manual-source-status').textContent = 'SOURCE ERROR';
      toast('Could not load manual dashboard data: ' + error.message);
      console.error('Manual dashboard load error:', error);
    }
  }

  function setManualEmptyDashboard() {
    state = { current: null, readings: [], events: [], canMessages: [], running: false };
    charts.clear();
    twin.update(null);
    ['voltage', 'current', 'temperature', 'health'].forEach(key => {
      $('value-' + key).textContent = '—';
      const trend = $('trend-' + key);
      if (trend) trend.textContent = '—';
    });
    $('health-badge').className = 'pill offline';
    $('health-badge').textContent = 'No data';
    $('alert-box').className = 'alert-box normal';
    $('alert-title').textContent = 'No selected-source readings';
    $('alert-description').textContent =
      'Submit data or choose another dashboard source.';
    $('session-state').textContent = dashboardSourceMode === 'manual'
      ? 'MANUAL INPUT · EMPTY'
      : 'PRESET EXAMPLES · EMPTY';
    $('connection-label').textContent = 'No saved readings for this source';
    $('last-updated').textContent = 'No source timestamp';
    $('chart-live').textContent = 'NO DATA';
    $('overview-health').textContent = '—';
    $('risk-value').innerHTML = '—<span></span>';
    $('risk-explanation').textContent =
      'A source-specific forecast is unavailable until compatible readings exist.';
    $('manual-source-status').textContent =
      dashboardSourceMode === 'manual' ? 'MANUAL INPUT' : 'PRESET SIMULATED';
    document.querySelectorAll('.system-item').forEach(item => {
      item.dataset.state = 'offline';
      item.querySelector('small').textContent = 'No data';
    });
    document.querySelectorAll('.overview-row').forEach(item => {
      item.dataset.state = 'offline';
      item.querySelector('.overview-status').textContent = 'No data';
    });
    renderHistory();
    renderCanHistory();
  }

  function csvRecords(text) {
    const records = [];
    let fields = [];
    let field = '';
    let quoted = false;
    let line = 1;
    let recordLine = 1;
    let malformed = null;

    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (quoted) {
        if (character === '"' && text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else if (character === '"') {
          quoted = false;
        } else {
          field += character;
          if (character === '\n') line += 1;
        }
      } else if (character === '"') {
        if (field.length) malformed = 'Unexpected quote in an unquoted field.';
        quoted = true;
      } else if (character === ',') {
        fields.push(field.trim());
        field = '';
      } else if (character === '\n' || character === '\r') {
        fields.push(field.trim());
        field = '';
        const values = fields;
        if (values.some(value => value !== '') || malformed) {
          records.push({ line: recordLine, fields: values, error: malformed });
        }
        fields = [];
        malformed = null;
        if (character === '\r' && text[index + 1] === '\n') index += 1;
        line += 1;
        recordLine = line;
      } else {
        field += character;
      }
    }

    fields.push(field.trim());
    if (fields.some(value => value !== '') || malformed) {
      records.push({
        line: recordLine,
        fields,
        error: quoted ? 'Quoted field was not closed.' : malformed
      });
    }
    return records;
  }

  function validateCsvPreview(raw = $('manual-csv-input').value, render = true) {
    const parsed = csvRecords(raw);
    if (!parsed.length) {
      manualCsvPreview = [];
      if (render) {
        $('manual-csv-summary').textContent = 'Paste CSV data to preview rows.';
        renderCsvPreview();
      }
      return manualCsvPreview;
    }

    const headerRecord = parsed.shift();
    const headers = headerRecord.fields.map(header => header.toLowerCase());
    const allowed = new Set([
      'timestamp',
      'voltage_v',
      'current_a',
      'temperature_c',
      'can_id',
      'raw_payload'
    ]);
    const headerErrors = [];
    if (!headers.includes('timestamp')) headerErrors.push('Missing required timestamp header.');
    if (headers.some(header => !allowed.has(header))) {
      headerErrors.push('Unsupported header(s): ' +
        headers.filter(header => !allowed.has(header)).join(', ') + '.');
    }
    if (new Set(headers).size !== headers.length) {
      headerErrors.push('Duplicate column names are not allowed.');
    }
    if (!['voltage_v', 'current_a', 'temperature_c'].some(name => headers.includes(name)) &&
        !(headers.includes('can_id') && headers.includes('raw_payload'))) {
      headerErrors.push('Include at least one supported signal column or both CAN columns.');
    }
    const rows = parsed.map(record => {
      const errors = [];
      if (record.error) errors.push(record.error);
      if (headerErrors.length) errors.push(...headerErrors);
      if (record.fields.length !== headers.length) {
        errors.push('Expected ' + headers.length + ' fields, found ' +
          record.fields.length + '.');
      }
      const row = {};
      headers.forEach((header, index) => {
        const value = record.fields[index] ?? '';
        if (header === 'timestamp') {
          if (!value || !Number.isFinite(Date.parse(value))) {
            errors.push('Timestamp must be ISO-8601 or Unix seconds.');
          } else {
            row.timestamp = /^\d+(?:\.\d+)?$/.test(value)
              ? new Date(Number(value) * 1000).toISOString()
              : new Date(value).toISOString();
          }
          return;
        }
        const signal = {
          voltage_v: ['voltage', 0, 1000],
          current_a: ['current', 0, 1000],
          temperature_c: ['temperature', -40, 200]
        }[header];
        if (signal) {
          if (value === '') {
            row[signal[0]] = null;
          } else if (!Number.isFinite(Number(value))) {
            errors.push(header + ' must be numeric.');
          } else if (Number(value) < signal[1] || Number(value) > signal[2]) {
            errors.push(header + ' is outside the DBC physical range.');
          } else {
            row[signal[0]] = Number(value);
          }
        } else if (header === 'can_id' && value) {
          row.can_id = value;
        } else if (header === 'raw_payload' && value) {
          row.raw_payload = value;
        }
      });
      if (Boolean(row.can_id) !== Boolean(row.raw_payload)) {
        errors.push('CAN ID and raw payload must be supplied together.');
      }
      if (
        row.can_id &&
        (!/^(?:0x[0-9a-f]+|\d+)$/i.test(row.can_id) ||
          !/^(?:[0-9a-f]{2}(?:[\s:_-]*[0-9a-f]{2}){0,7})$/i.test(row.raw_payload))
      ) {
        errors.push('CAN ID or payload format is invalid; payload must be 1–8 hex bytes.');
      }
      if (
        [row.voltage, row.current, row.temperature].every(value => value === null || value === undefined) &&
        !row.can_id
      ) {
        errors.push('Provide at least one sensor value or a CAN frame.');
      }
      return { line: record.line, row, errors, selected: errors.length === 0 };
    });

    const seenTimestamps = new Set();
    rows.forEach(item => {
      if (item.errors.length || !item.row.timestamp) return;
      const stamp = new Date(item.row.timestamp).getTime();
      if (seenTimestamps.has(stamp)) {
        item.errors.push('Duplicate timestamp; edit or skip this row.');
        item.selected = false;
      } else {
        seenTimestamps.add(stamp);
      }
    });
    manualCsvPreview = rows;
    const validCount = rows.filter(item => !item.errors.length).length;
    const invalidCount = rows.length - validCount;
    if (render) {
      $('manual-csv-summary').textContent =
        validCount + ' valid row(s), ' + invalidCount +
        ' row(s) needing correction or skipping.' +
        (headerErrors.length ? ' ' + headerErrors.join(' ') : '');
      renderCsvPreview();
    }
    return manualCsvPreview;
  }

  function renderCsvPreview() {
    $('manual-preview-rows').innerHTML = manualCsvPreview.map(item => `
      <tr class="${item.errors.length ? 'is-invalid' : 'is-valid'}">
        <td><input type="checkbox" data-csv-row="${item.line}"
          aria-label="Include CSV row ${item.line}" ${item.selected ? 'checked' : ''}
          ${item.errors.length || item.submitted ? 'disabled' : ''}></td>
        <td>${item.line}</td>
        <td>${escape(item.row.timestamp || item.row.timestamp_text || 'Invalid')}</td>
        <td>${escape([
          item.row.voltage !== undefined ? 'V ' + item.row.voltage : '',
          item.row.current !== undefined ? 'A ' + item.row.current : '',
          item.row.temperature !== undefined ? '°C ' + item.row.temperature : '',
          item.row.can_id ? 'CAN ' + item.row.can_id : ''
        ].filter(Boolean).join(' · ') || 'No readable values')}</td>
        <td>${escape(item.submitted
          ? 'Submitted · ' + item.submitted
          : item.errors.join(' ') || 'Ready to submit')}</td>
      </tr>
    `).join('') || '<tr><td colspan="5" class="empty">Paste or upload CSV, then validate it.</td></tr>';
    const selected = manualCsvPreview.filter(item =>
      item.selected && !item.errors.length
    ).length;
    $('manual-submit-batch').disabled = selected === 0;
  }

  function newIdempotencyKey() {
    return window.crypto?.randomUUID
      ? window.crypto.randomUUID()
      : 'manual-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  function idempotentPayload(payload, pending) {
    const signature = JSON.stringify(
      Object.fromEntries(
        Object.entries(payload).filter(([key]) => key !== 'idempotency_key')
      )
    );
    if (pending && pending.signature === signature) {
      return pending;
    }
    return {
      signature,
      payload: { ...payload, idempotency_key: newIdempotencyKey() }
    };
  }

  function manualPayloadFromForm(form, sourceName) {
    const fields = new FormData(form);
    const timestampValue = String(fields.get('timestamp') || '');
    const payload = {
      idempotency_key: newIdempotencyKey(),
      source: sourceName,
      timestamp: timestampValue
        ? new Date(timestampValue).toISOString()
        : new Date().toISOString(),
      units: { voltage: 'V', current: 'A', temperature: '°C' }
    };
    ['voltage', 'current', 'temperature'].forEach(name => {
      const raw = String(fields.get(name) || '').trim();
      payload[name] = raw === '' ? null : Number(raw);
    });
    const canId = String(fields.get('can_id') || '').trim();
    const rawPayload = String(fields.get('raw_payload') || '').trim();
    if (canId || rawPayload) {
      payload.can_id = canId;
      payload.raw_payload = rawPayload;
    }
    return payload;
  }

  function setManualBusy(busy, message) {
    $('manual-submit-single').disabled = busy;
    $('manual-submit-preset').disabled = busy ||
      !$('manual-preset-select').value;
    $('manual-submit-batch').disabled = busy ||
      !manualCsvPreview.some(item => item.selected && !item.errors.length);
    if (busy) {
      $('manual-result-status').className = 'pill warning';
      $('manual-result-status').textContent = 'Submitting…';
    }
    if (message) $('manual-result-empty').textContent = message;
  }

  async function showManualSubmission(record, message) {
    renderManualResult(record);
    if (message) toast(message);
    if (dashboardSourceMode !== 'simulator') {
      await loadManualDashboard(dashboardSourceMode);
      renderManualResult(record);
    } else {
      EV.getManualHistory(record.source, 100)
        .then(history => renderManualHistory(history.submissions || []))
        .catch(error => {
          console.error('Manual history refresh failed:', error);
          toast('Submission saved, but history refresh failed: ' + error.message);
        });
    }
  }

  function selectManualMode(mode) {
    document.querySelectorAll('[data-manual-mode]').forEach(tab => {
      const selected = tab.dataset.manualMode === mode;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', String(selected));
    });
    ['single', 'batch', 'preset'].forEach(name => {
      $('manual-mode-' + name).hidden = name !== mode;
    });
  }

  function setCurrentLocalTimestamp(input) {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    input.value = now.toISOString().slice(0, 16);
  }

  function populatePreset(name) {
    const templates = {
      normal: {
        voltage: '400', current: '35', temperature: '45',
        description: 'Normal-operation example: 400 V, 35 A, 45 °C.'
      },
      'rising-temperature': {
        voltage: '400', current: '60', temperature: '85',
        description: 'High-temperature example: 85 °C exceeds the configured 80 °C rule threshold.'
      },
      'voltage-drop': {
        voltage: '270', current: '35', temperature: '45',
        description: 'Low-voltage example: 270 V is below the configured 300 V rule threshold.'
      },
      'missing-sensor': {
        voltage: '400', current: '35', temperature: '',
        description: 'Sensor-failure example: temperature is intentionally omitted; no value is inferred.'
      }
    };
    const template = templates[name];
    const isBurst = name === 'can-activity';
    $('manual-preset-single-fields').hidden = isBurst;
    $('manual-preset-batch-fields').hidden = !isBurst;
    if (!name) {
      $('manual-preset-description').textContent =
        'Choose a template to populate editable fields. Templates are examples, not measured vehicle data.';
      $('manual-submit-preset').disabled = true;
      return;
    }
    if (isBurst) {
      const start = Date.now() / 1000;
      const lines = ['timestamp,voltage_V,current_A,temperature_C,can_id,raw_payload'];
      for (let index = 0; index < 6; index += 1) {
        lines.push([
          new Date((start + index * 0.15) * 1000).toISOString(),
          '400', '35', '45', '0x100', '"A0 0F 5E 01 52 03 00 00"'
        ].join(','));
      }
      $('manual-preset-csv').value = lines.join('\n');
      $('manual-preset-description').textContent =
        'Six editable, valid DBC telemetry frames within a two-second interval. The CAN-rate diagnostic evaluates these submitted frames.';
    } else {
      $('manual-preset-voltage').value = template.voltage;
      $('manual-preset-current').value = template.current;
      $('manual-preset-temperature').value = template.temperature;
      setCurrentLocalTimestamp($('manual-preset-timestamp'));
      $('manual-preset-description').textContent = template.description;
    }
    $('manual-submit-preset').disabled = false;
  }

  function renderFaultLab(snapshot) {
    const active = snapshot && snapshot.active;
    const run = active || snapshot && snapshot.latest;
    const status = snapshot && snapshot.status || 'normal';
    const statusElement = $('fault-lab-status');
    const labels = {
      active: 'Scenario active',
      stopped: 'Scenario stopped',
      recovered: 'Recovered to normal',
      interrupted: 'Interrupted · normal resumed',
      normal: 'Normal operation'
    };
    statusElement.textContent = labels[status] || 'Normal operation';
    statusElement.className = 'pill ' + (
      status === 'active' ? 'critical' :
      status === 'normal' || status === 'recovered' ? 'normal' : 'warning'
    );

    $('fault-lab-start').disabled = Boolean(active);
    $('fault-lab-scenario').disabled = Boolean(active);
    $('fault-lab-stop').disabled = !active;
    $('fault-lab-reset').disabled = !run || status === 'normal' ||
      status === 'recovered';

    if (!run) {
      $('fault-lab-explanation').textContent =
        'Start a scenario to compare actual simulated readings with their baseline and applicable rule.';
      $('fault-lab-detector').textContent =
        'Detector output will appear when the existing diagnostics evaluate a sample.';
      $('fault-lab-recommendation').textContent =
        'Suggestions are illustrative and are not confirmed root causes.';
      $('fault-lab-timeline').innerHTML =
        '<li>Normal operation · waiting for a scenario.</li>';
      $('fault-lab-delay').textContent =
        'Detection delay will be calculated from scenario and detection timestamps.';
      return;
    }

    const baseline = run.baseline || {};
    const latest = run.latest_reading || {};
    const definition = run.scenario || {};
    const showValue = (value, unit) => Number.isFinite(value)
      ? value.toFixed(1) + unit
      : 'Unavailable';
    const delta = (value, base, unit) =>
      Number.isFinite(value) && Number.isFinite(base)
        ? (value - base >= 0 ? '+' : '') +
          (value - base).toFixed(1) + unit
        : 'Unavailable';
    const scenarioId = run.scenario_id;
    const signalDetails = [
      'Voltage ' + showValue(latest.voltage, ' V') +
        ' (baseline ' + showValue(baseline.voltage, ' V') +
        ', change ' + delta(latest.voltage, baseline.voltage, ' V') + ')',
      'Current ' + showValue(latest.current, ' A') +
        ' (baseline ' + showValue(baseline.current, ' A') +
        ', change ' + delta(latest.current, baseline.current, ' A') + ')',
      'Temperature ' + showValue(latest.temperature, ' °C') +
        ' (baseline ' + showValue(baseline.temperature, ' °C') +
        ', change ' + delta(latest.temperature, baseline.temperature, ' °C') + ')'
    ];
    $('fault-lab-explanation').textContent =
      (run.scenario_name || 'Fault scenario') + '. ' +
      (definition.description || '') + ' ' +
      signalDetails.join('; ') + '. Applicable rule: ' +
      (definition.threshold || 'See detector rule output.') + '.';

    const faults = latest.diagnostic_faults || [];
    const detector = latest.ev_simulator_detector || {};
    const diagnosticOutput = faults.length
      ? faults.map(fault => fault.label + ': ' + fault.description).join(' ')
      : latest.timestamp
        ? 'Python rule-based diagnostics: no applicable fault rule triggered in the latest sample.'
        : 'Waiting for the first scenario sample.';
    const evOutput = detector.status === 'evaluated'
      ? ' EV simulator anomaly detector: ' +
        (detector.is_anomaly ? 'Anomaly' : 'Normal') +
        ' (score ' + Number(detector.anomaly_score).toFixed(3) + '). ' +
        detector.reason
      : detector.status === 'warming_up'
        ? ' EV simulator anomaly detector: warming up. ' + (detector.reason || '')
        : detector.reason
          ? ' EV simulator anomaly detector: not evaluated. ' + detector.reason
          : '';
    $('fault-lab-detector').textContent =
      diagnosticOutput + evOutput;
    $('fault-lab-recommendation').textContent =
      definition.recommendation ||
      'Suggestions are illustrative and are not confirmed root causes.';

    const timeline = Array.isArray(run.timeline) ? run.timeline : [];
    $('fault-lab-timeline').innerHTML = timeline.map(item => `
      <li>
        <time datetime="${new Date(item.timestamp * 1000).toISOString()}">
          ${escape(fullDate(item.timestamp * 1000))}
        </time>
        <strong>${escape(item.title || item.type)}</strong>
        ${item.detector ? '<span>' + escape(item.detector) + '</span>' : ''}
      </li>
    `).join('') || '<li>Timeline will update after the first sample.</li>';

    if (run.detection_at !== null && run.detection_at !== undefined) {
      $('fault-lab-delay').textContent = run.detected
        ? 'Detection delay: ' +
          Number(run.detection_delay_seconds).toFixed(2) +
          ' seconds from scenario start to detector output.'
        : 'Not detected before the scenario ended.';
    } else if (status === 'active') {
      $('fault-lab-delay').textContent = run.first_abnormal_at
        ? 'Abnormal signal observed; awaiting detector output.'
        : 'Waiting for an abnormal reading and detector result.';
    } else {
      $('fault-lab-delay').textContent =
        'Not detected before the scenario ended.';
    }

    if (active && definition.component) {
      twin.select(definition.component);
    } else if (status === 'recovered' || status === 'interrupted') {
      twin.clearSelection();
    }
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
        const delta = previous &&
          Number.isFinite(previous[key]) &&
          Number.isFinite(r[key]) &&
          previous[key] !== 0
          ? (r[key] - previous[key]) / previous[key] * 100
          : 0;

        const indicator = delta > .01
          ? '↗ '
          : delta < -.01
            ? '↘ '
            : '— ';

        $('trend-' + key).textContent =
          key === 'temperature' &&
          r.sensorAvailability.temperature === false
          ? 'Unavailable'
          : previous && Number.isFinite(previous[key]) &&
            Number.isFinite(r[key])
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
          : card.dataset.metric === 'temperature' &&
            r.sensorAvailability.temperature === false
            ? 'Sensor reading unavailable'
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
        ? d.systems.communication
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

    const simulatorMode = dashboardSourceMode === 'simulator';
    const sourceLabel = dashboardSourceMode === 'manual'
      ? 'MANUAL INPUT'
      : dashboardSourceMode === 'preset_simulated'
        ? 'PRESET EXAMPLES'
        : 'LIVE SIMULATOR';
    $('session-state').textContent = simulatorMode
      ? state.running ? 'SIMULATION RUNNING' : 'SIMULATOR PAUSED'
      : sourceLabel + ' · STATIC';

    $('session-state').classList.toggle(
      'running',
      simulatorMode && state.running
    );

    $('connection-label').textContent = simulatorMode
      ? state.running ? 'Demo feed running' : 'Demo feed paused'
      : sourceLabel.toLowerCase().replace('_', ' ') + ' selected';

    $('connection-dot').style.background = simulatorMode && state.running
      ? 'var(--green)'
      : 'var(--cyan)';

    $('last-updated').textContent = (simulatorMode ? 'Last sample: ' : 'Source timestamp: ') +
      time(r.timestamp);
    updateManualSourceBanner(state);
    $('chart-sampling-note').textContent = simulatorMode
      ? '2 s sampling · independently scaled, labelled axes'
      : 'Selected-source samples · independently scaled, labelled axes';

    $('chart-live').textContent = simulatorMode && state.running
      ? '● DEMO LIVE'
      : simulatorMode ? 'PAUSED' : sourceLabel;

    $('chart-live').style.color = simulatorMode && state.running
      ? 'var(--green)'
      : 'var(--faint)';

    const simulationButton = $('simulation-button');

    simulationButton.querySelector('span').textContent =
      simulatorMode && state.running ? 'Pause Simulation' : 'Start Simulation';
    simulationButton.disabled = !simulatorMode;
    $('reset-button').disabled = !simulatorMode;

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
    renderMultiLevelForecast(r.forecasts);
    renderFaultLab(r.faultLab);
    if (!canHistoryPaused) {
      renderCanHistory();
    }

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

  function handleLiveSourceUpdate(nextState, change) {
    latestLiveState = nextState;
    if (dashboardSourceMode === 'simulator') {
      updateState(nextState, change);
    }
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

    requestAnimationFrame(() => {
      charts.resize();
      forecastCharts.resize();
    });
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

    animations.theme(old, next, () => {
      charts.theme();
      forecastCharts.theme();
    });
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
  setCurrentLocalTimestamp($('manual-reading-form').elements.timestamp);
  $('manual-history-source').value = 'manual';
  updateManualSourceBanner(null);
  EV.getManualHistory('manual', 100)
    .then(history => {
      manualRecords = history.submissions || [];
      renderManualHistory(manualRecords);
    })
    .catch(error => {
      $('manual-history-rows').innerHTML =
        `<tr><td colspan="5" class="empty">History could not be loaded: ${escape(error.message)}</td></tr>`;
      console.error('Initial manual history load failed:', error);
    });

  if (animations.allowed()) {
    $('risk-progress').setAttribute('stroke-dashoffset', '100');
    $('health-progress').setAttribute('stroke-dashoffset', '100');
  }

  const unsubscribe = source.subscribe(handleLiveSourceUpdate);

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

  listen($('dashboard-source-mode'), 'change', event => {
    dashboardSourceMode = event.target.value;
    lastDiagnostic = null;
    historyPage = 0;
    $('manual-history-source').value = dashboardSourceMode === 'simulator'
      ? 'manual'
      : dashboardSourceMode;
    if (dashboardSourceMode === 'simulator') {
      source.start();
      if (latestLiveState?.current) {
        updateState(latestLiveState, {});
      }
    } else {
      source.pause();
      loadManualDashboard(dashboardSourceMode);
    }
  });

  listen($('manual-history-source'), 'change', async event => {
    try {
      const history = await EV.getManualHistory(event.target.value, 300);
      manualRecords = history.submissions || [];
      renderManualHistory(manualRecords);
    } catch (error) {
      toast('Could not load manual submission history: ' + error.message);
      console.error('Manual history load error:', error);
    }
  });

  document.querySelectorAll('[data-manual-mode]').forEach(tab => {
    listen(tab, 'click', () => selectManualMode(tab.dataset.manualMode));
  });

  listen($('manual-reading-form'), 'submit', async event => {
    event.preventDefault();
    setManualBusy(true, 'Validating and processing this reading through the backend…');
    $('manual-result-empty').hidden = false;
    $('manual-result-content').hidden = true;
    try {
      const attempt = idempotentPayload(
        manualPayloadFromForm($('manual-reading-form'), 'manual'),
        pendingManualRequest
      );
      pendingManualRequest = attempt;
      const record = await EV.submitManualReading(attempt.payload);
      await showManualSubmission(
        record,
        record.submission_status === 'processed'
          ? 'Manual reading was processed and persisted.'
          : 'Input was rejected by server validation; details are shown below.'
      );
    } catch (error) {
      $('manual-result-empty').textContent =
        'Submission failed: ' + error.message;
      $('manual-result-status').className = 'pill critical';
      $('manual-result-status').textContent = 'Request failed';
      toast('Could not submit manual reading: ' + error.message);
      console.error('Manual reading submission error:', error);
    } finally {
      setManualBusy(false);
    }
  });

  listen($('manual-reset-form'), 'click', () => {
    $('manual-reading-form').reset();
    setCurrentLocalTimestamp($('manual-reading-form').elements.timestamp);
    $('manual-result-content').hidden = true;
    $('manual-result-empty').hidden = false;
    $('manual-result-empty').textContent =
      'Submit a reading or validated CSV to see the server-side assessment, rules, model compatibility, and evidence here.';
    $('manual-result-status').className = 'pill offline';
    $('manual-result-status').textContent = 'No submission yet';
  });

  listen($('manual-clear-results'), 'click', () => {
    $('manual-result-content').hidden = true;
    $('manual-result-empty').hidden = false;
    $('manual-result-empty').textContent =
      'Results cleared from this panel. Persisted submissions and diagnostic history were not deleted.';
    $('manual-result-status').className = 'pill offline';
    $('manual-result-status').textContent = 'Results cleared';
  });

  listen($('manual-preview-csv'), 'click', () => validateCsvPreview());

  listen($('manual-csv-file'), 'change', async event => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      $('manual-csv-input').value = await file.text();
      validateCsvPreview();
    } catch (error) {
      $('manual-csv-summary').textContent =
        'Could not read selected file: ' + error.message;
      toast('Could not read CSV file: ' + error.message);
    }
  });

  listen($('manual-preview-rows'), 'change', event => {
    const checkbox = event.target.closest('input[data-csv-row]');
    if (!checkbox) return;
    const row = manualCsvPreview.find(item =>
      String(item.line) === checkbox.dataset.csvRow
    );
    if (row) row.selected = checkbox.checked;
    renderCsvPreview();
  });

  listen($('manual-submit-batch'), 'click', async () => {
    const baseRows = manualCsvPreview
      .filter(item => item.selected && !item.errors.length)
      .map(item => ({
        ...item.row,
        source: 'manual',
        units: { voltage: 'V', current: 'A', temperature: '°C' }
      }));
    if (!baseRows.length) return;
    const signature = JSON.stringify(baseRows);
    if (!pendingBatchRequest || pendingBatchRequest.signature !== signature) {
      pendingBatchRequest = {
        signature,
        rows: baseRows.map(row => ({
          ...row,
          idempotency_key: newIdempotencyKey()
        }))
      };
    }
    const rows = pendingBatchRequest.rows;
    setManualBusy(true, 'Submitting ' + rows.length +
      ' selected CSV rows in chronological order…');
    try {
      const response = await EV.submitManualBatch(rows);
      const selectedPreview = manualCsvPreview.filter(item =>
        item.selected && !item.errors.length
      );
      response.results.forEach((item, index) => {
        const preview = selectedPreview[index];
        if (!preview) return;
        preview.selected = false;
        preview.submitted = item.submission_status;
        if (item.submission_status !== 'processed') {
          preview.errors = [
            ...(item.result?.errors || []).map(error =>
              error.field + ': ' + error.message
            ),
            'Edit the CSV and validate again before retrying.'
          ];
        }
      });
      renderCsvPreview();
      pendingBatchRequest = null;
      const processed = response.results.filter(item =>
        item.submission_status === 'processed'
      );
      const latest = processed[processed.length - 1] ||
        response.results[response.results.length - 1];
      if (latest) await showManualSubmission(latest);
      $('manual-csv-summary').textContent =
        response.processed + ' processed, ' + response.invalid +
        ' invalid out of ' + response.submitted +
        ' selected row(s). Invalid rows remain visible in the preview; edit and revalidate to retry.';
      toast('CSV batch complete: ' + response.processed +
        ' processed, ' + response.invalid + ' invalid.');
    } catch (error) {
      $('manual-csv-summary').textContent =
        'Batch submission failed: ' + error.message;
      toast('Could not submit CSV batch: ' + error.message);
      console.error('Manual batch submission error:', error);
    } finally {
      setManualBusy(false);
    }
  });

  listen($('manual-preset-select'), 'change', event => {
    populatePreset(event.target.value);
  });

  listen($('manual-submit-preset'), 'click', async () => {
    const preset = $('manual-preset-select').value;
    if (!preset) return;
    $('manual-submit-preset').disabled = true;
    $('manual-result-status').className = 'pill warning';
    $('manual-result-status').textContent = 'Submitting…';
    $('manual-result-empty').hidden = false;
    $('manual-result-empty').textContent =
      'Submitting simulated example through the same backend pipeline…';
    try {
      let response;
      if (preset === 'can-activity') {
        const oldPreview = manualCsvPreview;
        const preview = validateCsvPreview(
          $('manual-preset-csv').value,
          false
        );
        const baseRows = preview.filter(item => !item.errors.length).map(item => ({
          ...item.row,
          source: 'preset_simulated',
          units: { voltage: 'V', current: 'A', temperature: '°C' }
        }));
        manualCsvPreview = oldPreview;
        if (baseRows.length !== 6) {
          throw new Error('CAN activity preset must contain six valid, editable DBC frames.');
        }
        const signature = JSON.stringify(baseRows);
        if (!pendingBatchRequest || pendingBatchRequest.signature !== signature) {
          pendingBatchRequest = {
            signature,
            rows: baseRows.map(row => ({
              ...row,
              idempotency_key: newIdempotencyKey()
            }))
          };
        }
        const rows = pendingBatchRequest.rows;
        response = await EV.submitManualBatch(rows);
        pendingBatchRequest = null;
        const processed = response.results.filter(item =>
          item.submission_status === 'processed'
        );
        const latest = processed[processed.length - 1] ||
          response.results[response.results.length - 1];
        if (latest) await showManualSubmission(latest);
        $('manual-csv-summary').textContent =
          response.processed + ' processed, ' + response.invalid +
          ' invalid CAN activity rows.';
        toast('Simulated CAN burst submitted: ' + response.processed +
          ' processed, ' + response.invalid + ' invalid.');
      } else {
        const basePayload = {
          source: 'preset_simulated',
          timestamp: new Date(
            $('manual-preset-timestamp').value
          ).toISOString(),
          voltage: $('manual-preset-voltage').value === ''
            ? null : Number($('manual-preset-voltage').value),
          current: $('manual-preset-current').value === ''
            ? null : Number($('manual-preset-current').value),
          temperature: $('manual-preset-temperature').value === ''
            ? null : Number($('manual-preset-temperature').value),
          units: { voltage: 'V', current: 'A', temperature: '°C' }
        };
        const attempt = idempotentPayload(
          basePayload,
          pendingManualRequest
        );
        pendingManualRequest = attempt;
        response = await EV.submitManualReading(attempt.payload);
        await showManualSubmission(
          response,
          response.submission_status === 'processed'
            ? 'Simulated preset was processed and persisted.'
            : 'Preset rejected by server validation; details are shown below.'
        );
      }
    } catch (error) {
      $('manual-result-empty').textContent =
        'Preset submission failed: ' + error.message;
      $('manual-result-status').className = 'pill critical';
      $('manual-result-status').textContent = 'Request failed';
      toast('Could not submit simulated preset: ' + error.message);
      console.error('Manual preset submission error:', error);
    } finally {
      $('manual-submit-preset').disabled = !$('manual-preset-select').value;
    }
  });

  listen($('manual-history-rows'), 'click', event => {
    const row = event.target.closest('tr[data-manual-key]');
    if (!row) return;
    const record = manualRecords.find(item =>
      item.idempotency_key === row.dataset.manualKey
    );
    if (record) {
      manualSelectedKey = record.idempotency_key;
      renderManualResult(record);
    }
  });

  listen($('manual-history-rows'), 'keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('tr[data-manual-key]');
    if (!row) return;
    event.preventDefault();
    const record = manualRecords.find(item =>
      item.idempotency_key === row.dataset.manualKey
    );
    if (record) renderManualResult(record);
  });

  listen($('fault-lab-start'), 'click', async () => {
    const button = $('fault-lab-start');
    button.disabled = true;
    try {
      const result = await EV.startFaultLab(
        $('fault-lab-scenario').value
      );
      if (result.active && result.active.scenario.component) {
        twin.select(result.active.scenario.component);
      }
      source.start();
      toast((result.active?.scenario_name || 'Fault scenario') + ' started.');
    } catch (error) {
      console.error('Fault simulation start error:', error);
      toast('Could not start scenario: ' + error.message);
      button.disabled = false;
    }
  });

  listen($('fault-lab-stop'), 'click', async () => {
    $('fault-lab-stop').disabled = true;
    try {
      const result = await EV.stopFaultLab();
      source.refresh();
      toast(
        result.latest?.detected === false
          ? 'Scenario stopped; no detector result was recorded.'
          : 'Scenario stopped. Reset to Normal to record recovery.'
      );
    } catch (error) {
      console.error('Fault simulation stop error:', error);
      toast('Could not stop scenario: ' + error.message);
      $('fault-lab-stop').disabled = false;
    }
  });

  listen($('fault-lab-reset'), 'click', async () => {
    $('fault-lab-reset').disabled = true;
    try {
      await EV.resetFaultLab();
      twin.clearSelection();
      source.refresh();
      toast('Fault scenario reset to normal operation.');
    } catch (error) {
      console.error('Fault simulation reset error:', error);
      toast('Could not reset scenario: ' + error.message);
      $('fault-lab-reset').disabled = false;
    }
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

  listen($('can-history-filter'), 'input', event => {
    canHistoryFilter = event.target.value.trim().toLowerCase();
    renderCanHistory();
  });

  listen($('can-history-toggle'), 'click', () => {
    canHistoryPaused = !canHistoryPaused;
    $('can-history-toggle').textContent = canHistoryPaused
      ? 'Resume history'
      : 'Pause history';
    $('can-history-toggle').setAttribute(
      'aria-pressed',
      String(canHistoryPaused)
    );
    if (!canHistoryPaused) renderCanHistory();
  });

  listen($('can-history-clear'), 'click', async () => {
    try {
      const result = await EV.clearCanMessages();
      const clearedAt = Number(result.cleared_at);
      if (!Number.isFinite(clearedAt)) {
        throw new Error('API did not return a valid CAN history clear time');
      }
      canHistoryClearedAt = clearedAt;
      selectedCanMessage = null;
      if (state) state.canMessages = [];
      renderCanHistory();
    } catch (error) {
      console.error('CAN history clear error:', error);
      toast('Could not clear CAN history: ' + error.message);
    }
  });

  listen($('can-history-table'), 'click', selectCanMessage);
  listen($('can-history-table'), 'keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('tr[data-can-key]');
    if (!row) return;
    event.preventDefault();
    selectedCanMessage = row.dataset.canKey;
    renderCanHistory();
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
    forecastCharts.destroy();
    twin.destroy();
    animations.destroy();

    clearInterval(clockTimer);
    clearTimeout(toastTimer);

    controller.abort();
  });
})();