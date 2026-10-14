(function (root) {
  'use strict';

  const EV = root.EV = root.EV || {};
  const API_URL = 'http://127.0.0.1:8000/api/readings';

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
    multiple_faults: 'multiple_faults'
  };

  async function getReadings(scenario = 'normal') {
    const apiScenario = SCENARIO_MAP[scenario] || scenario;
    const url = new URL(API_URL);

    url.searchParams.set('scenario', apiScenario);

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

  class ApiSource {
    constructor() {
      this.running = false;
      this.timer = null;
      this.listeners = new Set();
      this.readings = [];
      this.events = [];
      this.current = null;
      this.scenario = 'normal';
      this.busy = false;
      this.lastFaultKey = '';
      this.pendingTick = false;
    }

    subscribe(callback) {
      this.listeners.add(callback);
      this.start();

      return () => this.listeners.delete(callback);
    }

    async tick() {
      if (!this.running) return;

      // Queue a new request if one is already running.
      if (this.busy) {
        this.pendingTick = true;
        return;
      }

      this.busy = true;
      this.pendingTick = false;

      try {
        const requestedScenario = this.scenario;
        const raw = await getReadings(requestedScenario);

        const apiDiagnostics = raw.diagnostics || {};

        const apiFaults = Array.isArray(apiDiagnostics.faults)
          ? apiDiagnostics.faults
          : [];

        const primaryFault = apiFaults[0] || null;

        const hasFaults =
          apiDiagnostics.status === 'FAULT' ||
          apiFaults.length > 0 ||
          raw.ecu_status === 'FAULT';

        const severity = primaryFault
          ? primaryFault.severity
          : 'normal';

        const label = primaryFault
          ? primaryFault.label
          : 'Normal operation';

        const description = primaryFault
          ? primaryFault.description
          : (
              apiDiagnostics.message ||
              'No diagnostic faults detected.'
            );

        // Illustrative demo scores, not real vehicle predictions.
        const health = hasFaults
          ? (severity === 'critical' ? 45 : 70)
          : 92;

        const risk = hasFaults
          ? (severity === 'critical' ? 85 : 55)
          : 8;

        const codeMap = {
          'over-temperature': 'over-temperature',
          'over-current': 'over-current',
          'under-voltage': 'under-voltage',
          'low-voltage': 'under-voltage',
          'over-voltage': 'over-voltage'
        };

        const diagnostics = {
          code: primaryFault
            ? (codeMap[primaryFault.code] || primaryFault.code)
            : 'normal',

          label,
          severity,
          description,
          risk,
          health,
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

            communication: 'normal'
          }
        };

        const reading = {
          timestamp: Date.now(),
          voltage: Number(raw.voltage),
          current: Number(raw.current),
          temperature: Number(raw.temperature),
          health,

          // Keep frontend IDs for EV.SCENARIOS lookups.
          scenario: requestedScenario,

          seeded: false,
          diagnostics
        };

        if (
          !Number.isFinite(reading.voltage) ||
          !Number.isFinite(reading.current) ||
          !Number.isFinite(reading.temperature)
        ) {
          throw new Error('API returned invalid readings');
        }

        this.current = reading;
        this.readings.push(reading);

        if (this.readings.length > 300) {
          this.readings.shift();
        }

        // Record new fault combinations in the event history.
        const faultKey = apiFaults
          .map(f => f.code)
          .sort()
          .join(',');

        if (faultKey && faultKey !== this.lastFaultKey) {
          this.events.unshift({
            timestamp: reading.timestamp,
            type: 'fault',
            title: apiFaults.map(f => f.label).join(', '),
            scenario: requestedScenario,
            severity,
            message: description
          });

          if (this.events.length > 100) {
            this.events.pop();
          }
        }

        this.lastFaultKey = faultKey;

        const state = {
          current: reading,
          readings: [...this.readings],
          events: [...this.events],
          running: this.running
        };

        this.listeners.forEach(callback => callback(state, {}));

      } catch (error) {
        console.error('EV API error:', error);

      } finally {
        this.busy = false;

        // If the scenario changed during a request, fetch it now.
        if (this.running && this.pendingTick) {
          this.pendingTick = false;
          this.tick();
        }
      }
    }

    start() {
      if (this.running) return;

      this.running = true;
      this.tick();

      this.timer = setInterval(() => {
        this.tick();
      }, 2000);
    }

    pause() {
      this.running = false;
      this.pendingTick = false;

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
      this.lastFaultKey = '';

      this.start();
    }

    setScenario(scenario) {
      if (!scenario) return;

      this.scenario = scenario;
      this.lastFaultKey = '';

      if (this.running) {
        this.tick();
      }
    }

    report() {
      return {
        source: 'Python FastAPI — simulated CAN',
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
  EV.ApiSource = ApiSource;

})(window);