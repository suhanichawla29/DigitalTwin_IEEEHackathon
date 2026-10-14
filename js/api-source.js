
(function (root) {
  'use strict';

  const EV = root.EV = root.EV || {};
  const API_URL = 'http://127.0.0.1:8000/api/readings';

async function getReadings(scenario = 'normal') {
  const url = new URL(API_URL);
  url.searchParams.set('scenario', scenario);

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error('Failed to fetch EV readings');
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
          diagnostics: {
            code: 'normal',
            label: 'Normal operation',
            severity: 'normal',
            description: 'Readings received from the Python API.',
            risk: 8,
            health: 92,
            systems: {
              battery: 'normal',
              motor: 'normal',
              thermal: 'normal',
              communication: 'normal'
            }
          }
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
