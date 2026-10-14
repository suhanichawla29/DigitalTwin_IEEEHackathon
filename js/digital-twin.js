/*
 * digital-twin.js
 * ---------------------------------------------------------------------------
 * Controller for the Digital Twin panel.
 *
 * Owns the shared component-selection state and the selected-component
 * details panel, and bridges the dashboard data flow (script.js) to the
 * Three.js viewer (digital-twin-3d.js).
 *
 * The viewer module is loaded lazily so that a scripting/WebGL failure
 * degrades to a clear message instead of breaking the whole dashboard.
 */

(function (root) {
  'use strict';

  const EV = root.EV = root.EV || {};

  // Capture this script's own URL while it is still the executing script.
  // `document.currentScript` is only valid during synchronous execution, so it
  // MUST be read here. Reading it later (inside the async 3D loader) returns
  // null or, worse, the caller's script (script.js), which previously caused
  // the app to dynamically import itself and crash.
  const SELF_URL = (document.currentScript && document.currentScript.src) || '';

  const MODULE_URL = SELF_URL
    ? SELF_URL.replace(/[^/]*$/, 'digital-twin-3d.js')
    : new URL('js/digital-twin-3d.js', document.baseURI).href;

  const COLORS = {
    battery: '#17dfba',
    motor: '#00d9ff',
    thermal: '#a278ff',
    bms: '#ffc866',
    vcu: '#53acff'
  };

  const NAMES = {
    battery: 'Battery Pack',
    motor: 'Motor Controller',
    thermal: 'Thermal System',
    bms: 'Battery Management System',
    vcu: 'Vehicle Control Unit'
  };

  const DETAILS = {
    battery:
      'High-voltage traction battery along the vehicle floor (conceptual layout).',
    motor:
      'Traction inverter and motor at the rear axle (conceptual layout).',
    thermal:
      'Coolant loop and front radiator managing pack temperature.',
    bms:
      'Battery management controller monitoring the pack.',
    vcu:
      'Vehicle control unit coordinating the EV subsystems.'
  };

  const STATUS_LABELS = {
    normal: 'Normal',
    warning: 'Warning',
    critical: 'Critical',
    offline: 'Unavailable'
  };

  const statusLabel = status => STATUS_LABELS[status] || 'Unknown';

  const reducedMotion = () =>
    !!(root.matchMedia &&
      root.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function webglSupported() {
    try {
      const canvas = document.createElement('canvas');
      return !!(
        root.WebGLRenderingContext &&
        (canvas.getContext('webgl2') || canvas.getContext('webgl'))
      );
    } catch (_) {
      return false;
    }
  }

  function moduleUrl() {
    return MODULE_URL;
  }

  class DigitalTwin {
    constructor(stage, onSelect, motionAllowed) {
      this.stage = stage;
      this.onSelect = onSelect || (() => {});
      this.motionAllowed = motionAllowed || (() => true);

      this.state = null;
      this.selected = null;
      this.statuses = {
        battery: 'normal',
        motor: 'normal',
        thermal: 'normal',
        bms: 'normal',
        vcu: 'normal'
      };

      this.ready = false;
      this.destroyed = false;
      this.viewer = null;
      this.readoutTimer = null;

      this.autoRotate = !reducedMotion();
      this.cutaway = false;

      this.controller = new AbortController();

      this.mount();
      this.load3D();
    }

    /* -------------------------------------------------------------- */
    /* DOM setup                                                      */
    /* -------------------------------------------------------------- */
    mount() {
      this.stage.classList.add('twin-stage-3d');
      this.stage.innerHTML = '';

      const host = document.createElement('div');
      host.className = 'twin-canvas-host';
      this.stage.appendChild(host);
      this.canvasHost = host;

      const fallback = document.createElement('div');
      fallback.className = 'twin-3d-fallback';
      fallback.hidden = true;
      this.stage.appendChild(fallback);
      this.fallbackEl = fallback;

      const options = { signal: this.controller.signal };

      const autoButton = document.getElementById('toggle-autorotate');
      const cutawayButton = document.getElementById('toggle-cutaway');
      const detail = document.getElementById('component-detail');

      if (autoButton) {
        autoButton.addEventListener('click', () => {
          this.setAutoRotate(!this.autoRotate);
        }, options);
      }

      if (cutawayButton) {
        cutawayButton.addEventListener('click', () => {
          this.setCutaway(!this.cutaway);
        }, options);
      }

      if (detail) {
        detail.addEventListener('click', event => {
          if (event.target.closest('[data-clear-component]')) {
            this.clearSelection();
          }
        }, options);
      }

      this.syncControls();
      this.describe();
    }

    showFallback(title, message) {
      if (!this.fallbackEl) return;

      this.fallbackEl.hidden = false;
      this.fallbackEl.innerHTML =
        '<strong>' + title + '</strong><p>' + message + '</p>';
    }

    /* -------------------------------------------------------------- */
    /* 3D viewer                                                      */
    /* -------------------------------------------------------------- */
    async load3D() {
      if (!webglSupported()) {
        this.showFallback(
          'WebGL is not available',
          'This browser cannot render the 3D digital twin. The component list and demo details remain usable.'
        );
        return;
      }

      try {
        const module = await import(/* webpackIgnore: true */ moduleUrl());

        if (this.destroyed) return;

        this.viewer = module.createViewer(this.canvasHost, {
          reducedMotion: reducedMotion(),
          onSelect: id => this.select(id)
        });

        this.viewer.setAutoRotate(this.autoRotate);
        this.viewer.setCutaway(this.cutaway);
        this.applyStatuses();
        this.viewer.select(this.selected);

        this.ready = true;
        this.syncControls();
        this.describe();
        this.startReadout();
      } catch (error) {
        console.error('Digital Twin 3D viewer failed to load:', error);
        this.showFallback(
          '3D viewer unavailable',
          'The 3D engine could not be loaded. The component list and demo details remain usable.'
        );
      }
    }

    startReadout() {
      const readout = document.getElementById('twin-readout');

      if (!readout || this.readoutTimer) return;

      this.readoutTimer = root.setInterval(() => {
        if (!this.viewer) return;

        const degrees = Math.round(this.viewer.getRotationDegrees());
        const value = readout.querySelector('b');

        if (value) {
          value.textContent = String(degrees).padStart(3, '0') + '°';
        }
      }, 120);
    }

    /* -------------------------------------------------------------- */
    /* Controls                                                       */
    /* -------------------------------------------------------------- */
    syncControls() {
      const autoButton = document.getElementById('toggle-autorotate');
      const cutawayButton = document.getElementById('toggle-cutaway');

      if (autoButton) {
        autoButton.setAttribute('aria-pressed', String(this.autoRotate));
        autoButton.classList.toggle('active', this.autoRotate);
      }

      if (cutawayButton) {
        cutawayButton.setAttribute('aria-pressed', String(this.cutaway));
        cutawayButton.classList.toggle('active', this.cutaway);
      }
    }

    setAutoRotate(enabled) {
      this.autoRotate = !!enabled;

      if (this.viewer) this.viewer.setAutoRotate(this.autoRotate);

      this.syncControls();
    }

    setCutaway(enabled) {
      this.cutaway = !!enabled;

      if (this.viewer) this.viewer.setCutaway(this.cutaway);

      this.syncControls();
    }

    /* -------------------------------------------------------------- */
    /* Selection                                                      */
    /* -------------------------------------------------------------- */
    select(id) {
      if (!NAMES[id]) return;

      this.selected = id;

      if (this.viewer) this.viewer.select(id);

      document.querySelectorAll('.system-item').forEach(item => {
        const selected = item.dataset.system === id;

        item.classList.toggle('selected', selected);
        item.setAttribute('aria-pressed', String(selected));
      });

      this.describe();

      if (this.onSelect) this.onSelect(id);
    }

    clearSelection() {
      this.selected = null;

      if (this.viewer) this.viewer.select(null);

      document.querySelectorAll('.system-item').forEach(item => {
        item.classList.remove('selected');
        item.setAttribute('aria-pressed', 'false');
      });

      this.describe();

      if (this.onSelect) this.onSelect(null);
    }

    describe() {
      const detail = document.getElementById('ecu-inspector-content');
      if (!detail) return;

      const overview = !this.selected;
      const id = this.selected || 'motor';
      const reading = this.state && this.state.current;
      const diagnostics = reading && reading.diagnostics;
      const status = overview
        ? (diagnostics && diagnostics.severity) || 'offline'
        : this.statuses[id] || 'offline';
      const pillClass = STATUS_LABELS[status] ? status : 'offline';
      const escape = value => String(value).replace(
        /[&<>"']/g,
        character => ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;'
        })[character]
      );
      const formatValue = (raw, unit) =>
        raw === null || raw === undefined || !Number.isFinite(Number(raw))
          ? 'Unavailable'
          : Number(raw).toFixed(1) + ' ' + unit;
      const telemetry = [
        ['Voltage', reading && reading.voltage, 'V'],
        ['Current', reading && reading.current, 'A'],
        ['Temperature', reading && reading.temperature, '°C']
      ];
      const faults = diagnostics && Array.isArray(diagnostics.faults)
        ? diagnostics.faults
        : [];
      const messages = this.state && Array.isArray(this.state.canMessages)
        ? this.state.canMessages.slice(-3).reverse()
        : [];
      const messageMarkup = messages.length
        ? messages.map(message => {
          const timestamp = Number(message.timestamp);
          const messageTime = Number.isFinite(timestamp)
            ? new Date(timestamp * 1000).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit'
            })
            : 'Unavailable';
          const bytes = Array.isArray(message.payload_bytes)
            ? message.payload_bytes
                .map(byte => Number(byte).toString(16).padStart(2, '0'))
                .join(' ')
                .toUpperCase()
            : '';
          const payload = message.payload_hex || bytes || 'Unavailable';
          const signals = Array.isArray(message.decoded_signals)
            ? message.decoded_signals.map(signal => {
              const value = signal.value === null ||
                signal.value === undefined ||
                !Number.isFinite(Number(signal.value))
                ? 'Unavailable'
                : Number(signal.value).toFixed(2) +
                  (signal.unit ? ' ' + signal.unit : '');
              return (
                '<span><b>' + escape(signal.name || 'Unknown signal') +
                ':</b> ' + escape(value) + '</span>'
              );
            }).join('')
            : '';

          return (
            '<li class="ecu-can-record">' +
              '<div class="ecu-can-record-head">' +
                '<time>' + escape(messageTime) + '</time>' +
                '<code>' + escape(message.can_id || 'Unavailable') + '</code>' +
              '</div>' +
              '<strong>' +
                escape(message.message_name || 'Unavailable') +
              '</strong>' +
              '<code class="ecu-can-payload">' + escape(payload) + '</code>' +
              '<div class="ecu-can-signals">' +
                (signals || '<span>Decoded signals: Unavailable</span>') +
              '</div>' +
              '<small>' +
                escape(message.decode_status === 'decoded'
                  ? 'DBC decoded'
                  : message.decode_status === 'error'
                    ? 'Decoder error: ' +
                      (message.error || 'Unavailable')
                    : 'Decoder status: Unavailable') +
              '</small>' +
            '</li>'
          );
        }).join('')
        : '<li class="ecu-empty">No CAN frames received yet.</li>';

      detail.innerHTML =
        '<div class="ecu-selected-component">' +
          '<div>' +
            '<span>' + (overview
              ? 'No component selected · vehicle-wide view'
              : 'Selected component') + '</span>' +
            '<strong>' + escape(overview ? 'Vehicle Overview' : NAMES[id]) +
            '</strong>' +
          '</div>' +
          '<span class="pill ' + pillClass + '">' +
            statusLabel(status) +
          '</span>' +
          (overview
            ? ''
            : '<button class="text-button detail-clear" data-clear-component>' +
              'Clear selection</button>') +
        '</div>' +
        '<p class="ecu-component-description">' +
          escape(overview
            ? 'Live vehicle telemetry, rule-based diagnostics, and recent decoded CAN frames.'
            : DETAILS[id]) +
        '</p>' +
        '<div class="ecu-inspector-grid">' +
          '<section class="ecu-inspector-block">' +
            '<h4>Latest vehicle telemetry</h4>' +
            '<ul class="ecu-telemetry-list">' +
              telemetry.map(([label, value, unit]) =>
                '<li><span>' + label + '</span><strong>' +
                escape(formatValue(value, unit)) + '</strong></li>'
              ).join('') +
            '</ul>' +
          '</section>' +
          '<section class="ecu-inspector-block">' +
            '<h4>Active diagnostic alerts</h4>' +
            (faults.length
              ? '<ul class="ecu-alert-list">' + faults.map(fault =>
                '<li>' +
                  '<div><strong>' +
                    escape(fault.label || fault.code || 'Unavailable') +
                  '</strong><span class="pill ' +
                    escape(STATUS_LABELS[fault.severity]
                      ? fault.severity
                      : 'offline') + '">' +
                    escape(statusLabel(fault.severity)) +
                  '</span></div>' +
                  '<p>' + escape(fault.description || 'Unavailable') + '</p>' +
                '</li>'
              ).join('') + '</ul>'
              : '<p class="ecu-empty">No active diagnostic alerts.</p>') +
          '</section>' +
          '<section class="ecu-inspector-block">' +
            '<h4>Recent CAN messages</h4>' +
            '<ul class="ecu-can-list">' + messageMarkup + '</ul>' +
          '</section>' +
        '</div>' +
        '<p class="ecu-inspector-source">' +
          'Shared live telemetry · rule-based diagnostics · simulated CAN feed' +
        '</p>';
    }

    /* -------------------------------------------------------------- */
    /* Data flow                                                      */
    /* -------------------------------------------------------------- */
    applyStatuses() {
      if (!this.viewer) return;

      Object.keys(this.statuses).forEach(id => {
        this.viewer.setStatus(id, this.statuses[id]);
      });
    }

    update(state) {
      this.state = state;

      const systems = state && state.current
        ? state.current.diagnostics.systems
        : null;

      Object.keys(this.statuses).forEach(id => {
        this.statuses[id] = systems
          ? (systems[id] || 'normal')
          : 'offline';
      });

      // Live-data descriptors are re-applied on every sample.
      this.applyStatuses();

      this.describe();
    }

    reset() {
      if (this.viewer) this.viewer.resetView();
    }

    destroy() {
      this.destroyed = true;
      this.controller.abort();

      if (this.readoutTimer) {
        root.clearInterval(this.readoutTimer);
        this.readoutTimer = null;
      }

      if (this.viewer) {
        this.viewer.dispose();
        this.viewer = null;
      }
    }
  }

  EV.DigitalTwin = DigitalTwin;
  EV.TWIN_COLORS = COLORS;
})(window);
