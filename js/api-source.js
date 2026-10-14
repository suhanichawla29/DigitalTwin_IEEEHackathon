```javascript
(function (root) {
  'use strict';

  const EV = root.EV = root.EV || {};
  const API_URL = 'http://127.0.0.1:8000/api/readings';

  // Map frontend scenario names to Python API scenario names.
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
      let detail = 'Failed to fetch EV readings';

      try {
        const errorData = await response.json();
        detail =
          errorData.detail?.message ||
          errorData.detail ||
          errorData.error ||
          detail;
      } catch (_) {
        // Keep the default error message.
      }

      throw new Error(
        typeof detail === 'string' ? detail : JSON.stringify(detail)
      );
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
    }

    subscribe(callback) {
      this.listeners.add(callback);
      this.start();

      return () => this.listeners.delete(callback);
    }

    async tick() {
      if (!this.running || this.busy) return;

      this.busy = true;

      try {
        // Request readings for the currently selected scenario.
        const raw = await getReadings(this.scenario);

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

        const health = hasFaults
          ? (severity === 'critical' ? 45 : 70)
          : 92;

        const risk = hasFaults
          ? (severity === 'critical' ? 85 : 55)
          : 8;

        // Convert backend diagnostic codes into frontend-compatible codes.
        const codeMap = {
          'over-temperature': 'over-temperature',
          'over-current': 'over-current',
          'under-voltage': 'under-voltage',
          'low-voltage': 'under-voltage',
          'over-voltage': 'over-voltage'
        };

        const diagnosticCode = primaryFault
          ? (
              codeMap[primaryFault.code] ||
              primaryFault.code
            )
          : 'normal';

        const diagnostics = {
          code: diagnosticCode,
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
          scenario: this.scenario,
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

        // Keep the latest 300 readings for dashboard charts.
        if (this.readings.length > 300) {
          this.readings.shift();
        }

        // Add an event when a new fault combination appears.
        const faultKey = apiFaults
          .map(f => f.code)
          .sort()
          .join(',');

        if (faultKey && faultKey !== this.lastFaultKey) {
          this.events.unshift({
            timestamp: reading.timestamp,
            type: 'fault',
            title: apiFaults.map(f => f.label).join(', '),
            scenario: this.scenario,
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

      // Fetch the new scenario immediately if the source is running.
      if (this.running && !this.busy) {
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
```
