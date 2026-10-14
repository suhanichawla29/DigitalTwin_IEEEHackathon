
(function (root) {
  'use strict';

  const EV = root.EV = root.EV || {};
  const API_URL = 'http://127.0.0.1:8000/api/readings';

  async function getReadings() {
    const response = await fetch(API_URL);

    if (!response.ok) {
      throw new Error('Failed to fetch EV readings');
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

  // Illustrative demo scores; the backend reports faults, not a health model.
  const SCORE_BY_SEVERITY = {
    normal: { risk: 8, health: 92 },
    warning: { risk: 64, health: 68 },
    critical: { risk: 86, health: 48 }
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
    const scores = SCORE_BY_SEVERITY[severity];

    return {
      code: primary ? primary.code : 'normal',
      label: primary ? primary.label : 'Normal operation',
      severity,
      description: primary
        ? faults
            .map(fault => fault.description || fault.label)
            .join(' ')
        : 'No demo fault rules were triggered by the Python API.',
      risk: scores.risk,
      health: scores.health,
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
      this.busy = false;
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
        const raw = await getReadings();

        const reading = {
          timestamp: Date.now(),
          voltage: Number(raw.voltage),
          current: Number(raw.current),
          temperature: Number(raw.temperature),
          health: 92,
          scenario: this.scenario,
          seeded: false,
          source: raw.source || 'SIMULATED_CAN',
          diagnostics: deriveDiagnostics(raw)
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
      this.timer = setInterval(() => this.tick(), 2000);
    }

    pause() {
      this.running = false;
      clearInterval(this.timer);
      this.timer = null;
    }

    reset() {
      this.pause();
      this.readings = [];
      this.events = [];
      this.current = null;
      this.scenario = 'normal';
      this.start();
    }

    setScenario(scenario) {
      this.scenario = scenario;
      console.warn(
        'Scenario changes are not yet implemented in the Python API.'
      );
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
