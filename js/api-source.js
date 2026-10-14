(function (root) {
  'use strict';

  const EV = root.EV = root.EV || {};
  const API_URL = 'http://127.0.0.1:8000/api/readings';
  const RESET_URL = 'http://127.0.0.1:8000/api/reset';
  const CAN_MESSAGES_URL = 'http://127.0.0.1:8000/api/can/messages';

  // Map frontend scenario IDs to Python API scenario IDs.
  const SCENARIO_MAP = {
    normal: 'normal',
    'under-voltage': 'low_voltage',
    'low-voltage': 'low_voltage',
    'over-voltage': 'over_voltage',
    'over-current': 'over_current',
    'over-temperature': 'over_temperature',
    'multiple-faults': 'multiple_faults',
    low_voltage: 'low_voltage',
    over_voltage: 'over_voltage',
    over_current: 'over_current',
    over_temperature: 'over_temperature',
    multiple_faults: 'multiple_faults',
    'gradual-degradation': 'gradual_degradation',
    'severe-degradation': 'severe_degradation',
    gradual_degradation: 'gradual_degradation',
    severe_degradation: 'severe_degradation'
  };

  function mapScenario(scenario) {
    if (!Object.prototype.hasOwnProperty.call(SCENARIO_MAP, scenario)) {
      throw new RangeError('Unsupported scenario: ' + scenario);
    }

    return SCENARIO_MAP[scenario];
  }

  async function getReadings(scenario = 'normal') {
    const url = new URL(API_URL);

    if (Array.isArray(scenario)) {
      const faults = scenario.map(mapScenario);

      if (faults.includes('normal')) {
        if (faults.length !== 1) {
          throw new RangeError('Normal operation cannot be combined with faults');
        }

        url.searchParams.set('scenario', 'normal');
      } else if (faults.length) {
        faults.forEach(fault => url.searchParams.append('faults', fault));
      } else {
        url.searchParams.set('scenario', 'normal');
      }
    } else {
      url.searchParams.set('scenario', mapScenario(scenario));
    }

    const response = await fetch(url);

    if (!response.ok) {
      let message = 'Failed to fetch EV readings';

      try {
        const body = await response.json();
        const detail =
          body.detail?.message ||
          body.detail ||
          body.error;

        if (detail) {
          message = typeof detail === 'string'
            ? detail
            : JSON.stringify(detail);
        }
      } catch (_) {
        // Keep the fallback error message.
      }

      throw new Error(message);
    }

    const data = await response.json();

    if (data.error) {
      throw new Error(data.error);
    }

    return data;
  }

  async function resetEpisode() {
    const response = await fetch(RESET_URL, { method: 'POST' });
    if (response.ok) return;

    let message = 'Failed to reset the simulation episode';
    try {
      const body = await response.json();
      const detail = body.detail?.message || body.detail || body.error;
      if (detail) {
        message = typeof detail === 'string'
          ? detail
          : JSON.stringify(detail);
      }
    } catch (_) {
      // Keep the fallback error message.
    }

    throw new Error(message);
  }

  async function clearCanMessages() {
    const response = await fetch(CAN_MESSAGES_URL, { method: 'DELETE' });
    if (!response.ok) {
      throw new Error('Failed to clear simulated CAN message history');
    }
    return response.json();
  }

  /*
   * Map the backend's demo fault codes onto the five monitored systems so the
   * dashboard and the 3D digital twin stay in sync with the actual API result.
   * Severities here mirror the thresholds in backend/diagnostics.py.
   */
  const FAULT_SYSTEMS = {
    'over-temperature': [
      { id: 'thermal', severity: 'critical' },
      { id: 'bms', severity: 'warning' }
    ],
    'over-current': [
      { id: 'motor', severity: 'critical' },
      { id: 'vcu', severity: 'critical' }
    ],
    'under-voltage': [
      { id: 'battery', severity: 'warning' },
      { id: 'bms', severity: 'warning' }
    ],
    'over-voltage': [
      { id: 'battery', severity: 'warning' }
    ]
  };

  const RANK = { normal: 0, warning: 1, critical: 2 };

  function deriveDiagnostics(raw) {
    const api = raw.diagnostics || {};
    const faults = Array.isArray(api.faults) ? api.faults : [];

    const systems = {
      battery: 'normal',
      motor: 'normal',
      thermal: 'normal',
      bms: 'normal',
      vcu: 'normal',
      communication: 'normal'
    };

    let severity = 'normal';

    faults.forEach(fault => {
      const faultSeverity = fault.severity === 'critical'
        ? 'critical'
        : 'warning';

      if (RANK[faultSeverity] > RANK[severity]) {
        severity = faultSeverity;
      }

      (FAULT_SYSTEMS[fault.code] || []).forEach(({ id, severity: mapped }) => {
        if (RANK[mapped] > RANK[systems[id]]) {
          systems[id] = mapped;
        }
      });
    });

    const primary = faults[0];

    return {
      code: primary ? primary.code : 'normal',
      label: primary ? primary.label : 'Normal operation',
      severity,
      description: primary
        ? faults
            .map(fault => fault.description || fault.label)
            .join(' ')
        : 'No demo fault rules were triggered by the Python API.',
      faults,
      systems
    };
  }

  class ApiSource {
    constructor() {
      this.running = false;
      this.timer = null;
      this.listeners = new Set();
      this.readings = [];
      this.events = [];
      this.current = null;
      this.scenario = 'normal';
      this.scenarios = [];
      this.legacyScenario = null;
      this.busy = false;
      this.lastFaultKey = '';
      this.pendingTick = false;
      this.pendingForce = false;
      this.resetting = false;
      this.resumeAfterReset = false;
    }

    subscribe(callback) {
      this.listeners.add(callback);
      this.start();

      return () => this.listeners.delete(callback);
    }

    async tick(force = false) {
      if (this.resetting) {
        this.pendingTick = true;
        this.pendingForce = this.pendingForce || force;
        return;
      }

      if (!this.running && !force) return;

      // Queue a new request if one is already running.
      if (this.busy) {
        this.pendingTick = true;
        this.pendingForce = this.pendingForce || force;
        return;
      }

      this.busy = true;
      this.pendingTick = false;
      this.pendingForce = false;

      try {
        const requestedScenario = this.scenario;
        const requestedFaults = [...this.scenarios];
        const raw = await getReadings(
          this.legacyScenario || requestedFaults
        );

        const apiDiagnostics = raw.diagnostics || {};

        const apiFaults = Array.isArray(apiDiagnostics.faults)
          ? apiDiagnostics.faults
          : [];

        const hasFaults =
          apiDiagnostics.status === 'FAULT' ||
          apiFaults.length > 0 ||
          raw.ecu_status === 'FAULT';

        const severity = apiFaults.some(f => f.severity === 'critical')
          ? 'critical'
          : hasFaults ? 'warning' : 'normal';

        const label = apiFaults.length
          ? apiFaults.map(f => f.label).join(', ')
          : 'Normal operation';

        const description = apiFaults.length
          ? apiFaults.map(f => f.description).join(' ')
          : (
            apiDiagnostics.message ||
            'No diagnostic faults detected.'
          );

        const codeMap = {
          'over-temperature': 'over-temperature',
          'over-current': 'over-current',
          'under-voltage': 'under-voltage',
          'low-voltage': 'under-voltage',
          'over-voltage': 'over-voltage'
        };

        const faultCodes = apiFaults.map(f =>
          codeMap[f.code] || f.code
        );

        const diagnostics = {
          code: faultCodes.length
            ? faultCodes.join(',')
            : 'normal',

          label,
          severity,
          description,
          faults: apiFaults,

          systems: {
            battery: apiFaults.some(f =>
              [
                'under-voltage',
                'low-voltage',
                'over-voltage'
              ].includes(f.code)
            ) ? 'warning' : 'normal',

            motor: apiFaults.some(f =>
              f.code === 'over-current'
            ) ? 'critical' : 'normal',

            thermal: apiFaults.some(f =>
              f.code === 'over-temperature'
            ) ? 'critical' : 'normal',

            bms: apiFaults.some(f =>
              [
                'under-voltage',
                'low-voltage',
                'over-voltage',
                'over-temperature'
              ].includes(f.code)
            ) ? 'warning' : 'normal',

            vcu: apiFaults.some(f =>
              f.code === 'over-current'
            ) ? 'critical' : 'normal',

            communication: 'normal'
          }
        };

        const prediction = raw.prediction || {
          status: 'unavailable',
          history_count: 0,
          window_size: 30,
          failure_probability: null,
          horizon_seconds: 300,
          message: 'Prediction metadata was not returned by the API.'
        };
        const timestamp = Number(raw.timestamp);
        const probability = prediction.status === 'ready' &&
          Number.isFinite(prediction.failure_probability)
          ? prediction.failure_probability
          : null;
        const health = probability === null
          ? null
          : (1 - probability) * 100;

        const reading = {
          timestamp: timestamp * 1000,
          voltage: Number(raw.voltage),
          current: Number(raw.current),
          temperature: Number(raw.temperature),
          health,
          prediction,
          forecasts: raw.forecasts || null,
          datasetModels: raw.dataset_models || {},
          canMessages: Array.isArray(raw.can_messages)
            ? raw.can_messages
            : [],

          // Preserve frontend scenario IDs for the dashboard history.
          scenario: requestedScenario,
          scenarios: requestedFaults,

          seeded: false,
          source: raw.source || 'SIMULATED_CAN',
          diagnostics: deriveDiagnostics(raw)
        };

        if (
          !Number.isFinite(timestamp) ||
          !Number.isFinite(reading.voltage) ||
          !Number.isFinite(reading.current) ||
          !Number.isFinite(reading.temperature) ||
          (
            prediction.status === 'ready' &&
            probability === null
          ) ||
          (
            probability !== null &&
            (probability < 0 || probability > 1)
          )
        ) {
          throw new Error('API returned invalid readings');
        }

        this.current = reading;
        this.readings.push(reading);

        if (this.readings.length > 300) {
          this.readings.shift();
        }

        // Record changes to the active fault combination.
        const previousFaultKey = this.lastFaultKey;
        const faultKey = apiFaults
          .map(f => f.code)
          .sort()
          .join(',');

        let event = null;
        if (faultKey && faultKey !== previousFaultKey) {
          event = {
            timestamp: reading.timestamp,
            type: 'fault',
            title: apiFaults.map(f => f.label).join(', '),
            scenario: requestedScenario,
            severity,
            message: description
          };
        } else if (!faultKey && previousFaultKey) {
          event = {
            timestamp: reading.timestamp,
            type: 'recovery',
            title: 'Returned to normal operation',
            scenario: requestedScenario,
            severity: 'normal',
            message: 'Active simulated faults have cleared.'
          };
        }

        if (event) {
          this.events.unshift(event);
          if (this.events.length > 100) {
            this.events.pop();
          }
        }

        this.lastFaultKey = faultKey;

        const state = {
          current: reading,
          readings: [...this.readings],
          canMessages: reading.canMessages,
          events: [...this.events],
          running: this.running
        };

        this.listeners.forEach(callback => callback(
          state,
          event ? { type: event.type, event } : {}
        ));

      } catch (error) {
        console.error('EV API error:', error);
        const state = {
          current: this.current,
          readings: [...this.readings],
          events: [...this.events],
          running: this.running
        };

        this.listeners.forEach(callback => callback(state, {
          type: 'error',
          error
        }));

      } finally {
        this.busy = false;

        if (this.resetting) {
          this.performReset();
          return;
        }

        // If the scenario changed during a request, fetch it now.
        if (this.pendingTick && (this.running || this.pendingForce)) {
          const force = this.pendingForce;
          this.pendingTick = false;
          this.pendingForce = false;
          this.tick(force);
        }
      }
    }

    start() {
      if (this.running) return;

      if (this.resetting) {
        this.resumeAfterReset = true;
        return;
      }

      this.running = true;
      this.tick();

      this.timer = setInterval(() => {
        this.tick();
      }, 2000);
    }

    pause() {
      this.running = false;
      if (this.resetting) {
        this.resumeAfterReset = false;
      }
      if (!this.pendingForce) {
        this.pendingTick = false;
      }

      if (this.timer !== null) {
        clearInterval(this.timer);
      }

      this.timer = null;
    }

    reset() {
      this.pause();

      this.readings = [];
      this.events = [];
      this.current = null;
      this.scenario = 'normal';
      this.scenarios = [];
      this.legacyScenario = null;
      this.lastFaultKey = '';

      this.resetting = true;
      this.resumeAfterReset = true;
      if (!this.busy) {
        this.performReset();
      }
    }

    async performReset() {
      if (!this.resetting || this.busy) return;

      try {
        await resetEpisode();
      } catch (error) {
        this.resetting = false;
        this.resumeAfterReset = false;
        console.error('EV API reset error:', error);
        this.listeners.forEach(callback => callback({
          current: this.current,
          readings: [...this.readings],
          events: [...this.events],
          running: this.running
        }, { type: 'error', error }));
        return;
      }

      this.readings = [];
      this.events = [];
      this.current = null;
      this.lastFaultKey = '';
      this.resetting = false;
      if (this.resumeAfterReset) {
        this.resumeAfterReset = false;
        this.start();
      } else if (this.pendingForce) {
        this.pendingForce = false;
        this.pendingTick = false;
        this.tick(true);
      }
    }

    setScenario(scenario) {
      if (!scenario) return;

      const apiScenario = mapScenario(scenario);

      if (apiScenario === 'multiple_faults') {
        this.scenarios = [];
        this.scenario = scenario;
        this.legacyScenario = apiScenario;
        this.tick(true);
        return;
      }

      if ([
        'gradual_degradation',
        'severe_degradation'
      ].includes(apiScenario)) {
        this.scenarios = [];
        this.scenario = scenario;
        this.legacyScenario = apiScenario;
        this.tick(true);
        return;
      }

      this.setScenarios(apiScenario === 'normal' ? [] : [scenario]);
    }

    setScenarios(scenarios) {
      if (!Array.isArray(scenarios)) {
        throw new TypeError('Scenarios must be provided as an array');
      }

      const normalized = [];
      scenarios.forEach(scenario => {
        const apiScenario = mapScenario(scenario);
        if (apiScenario === 'normal') return;

        const frontendScenario = {
          low_voltage: 'under-voltage',
          over_voltage: 'over-voltage',
          over_current: 'over-current',
          over_temperature: 'over-temperature'
        }[apiScenario];

        if (!frontendScenario) {
          throw new RangeError('Unsupported fault scenario: ' + scenario);
        }

        if (!normalized.includes(frontendScenario)) {
          normalized.push(frontendScenario);
        }
      });

      this.scenarios = normalized;
      this.scenario = normalized.length ? normalized.join(',') : 'normal';
      this.legacyScenario = null;
      this.tick(true);
    }

    report() {
      return {
        source: 'Python FastAPI — simulated CAN',
        predictionModel: this.current?.prediction?.model || null,
        readings: [...this.readings],
        events: [...this.events]
      };
    }

    destroy() {
      this.pause();
      this.listeners.clear();
    }
  }

  EV.getApiReadings = getReadings;
  EV.clearCanMessages = clearCanMessages;
  EV.ApiSource = ApiSource;

})(window);