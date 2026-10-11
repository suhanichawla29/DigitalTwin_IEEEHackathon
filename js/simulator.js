/*
 * Replaceable, browser-independent data source.
 * No DOM, network, or animation code.
 */
(function (root) {
  'use strict';

  const EV = root.EV = root.EV || {};

  const SYSTEMS = Object.freeze([
    {
      id: 'battery',
      name: 'Battery System',
      icon: 'battery-charging'
    },
    {
      id: 'motor',
      name: 'Motor Controller',
      icon: 'cog'
    },
    {
      id: 'thermal',
      name: 'Thermal System',
      icon: 'thermometer'
    },
    {
      id: 'bms',
      name: 'BMS',
      icon: 'cpu'
    },
    {
      id: 'vcu',
      name: 'VCU',
      icon: 'network'
    }
  ]);

  const SCENARIOS = Object.freeze({
    normal: {
      label: 'Normal operation',
      voltage: 348,
      current: 32,
      temperature: 36,
      health: 92,
      risk: 12,
      severity: 'normal',
      systems: [],
      description: 'All simulated systems are within demo limits.'
    },

    'over-temperature': {
      label: 'Over-temperature',
      voltage: 344,
      current: 37,
      temperature: 72,
      health: 68,
      risk: 64,
      severity: 'warning',
      systems: ['thermal', 'bms'],
      description:
        'Synthetic temperature exceeds the 60 °C demo threshold. ' +
        'Thermal system and BMS are flagged.'
    },

    'under-voltage': {
      label: 'Under-voltage',
      voltage: 276,
      current: 40,
      temperature: 38,
      health: 61,
      risk: 72,
      severity: 'warning',
      systems: ['battery', 'bms'],
      description:
        'Synthetic voltage is below the 300 V demo threshold. ' +
        'Battery system and BMS are flagged.'
    },

    'over-current': {
      label: 'Over-current',
      voltage: 338,
      current: 96,
      temperature: 44,
      health: 48,
      risk: 86,
      severity: 'critical',
      systems: ['motor', 'vcu'],
      description:
        'Synthetic current exceeds the 80 A demo threshold. ' +
        'Motor controller and VCU are flagged.'
    }
  });

  const round = n => Math.round(n * 10) / 10;

  function classifyDemo(reading) {
    /*
     * These limits demonstrate state propagation.
     * They are NOT equipment specifications or safety guidance.
     */
    const code = reading.current >= 80
      ? 'over-current'
      : reading.voltage <= 300
        ? 'under-voltage'
        : reading.temperature >= 60
          ? 'over-temperature'
          : 'normal';

    const config = SCENARIOS[code];
    const systems = {};

    SYSTEMS.forEach(system => {
      systems[system.id] = config.systems.includes(system.id)
        ? config.severity
        : 'normal';
    });

    return {
      code,
      label: config.label,
      severity: config.severity,
      description: config.description,
      risk: config.risk,
      health: config.health,
      systems,
      source: 'illustrative-demo-rules',
      isPrediction: false
    };
  }

  class DemoSource {
    constructor(options = {}) {
      this.intervalMs = 2000;
      this.maxReadings = 50000;
      this.maxEvents = 5000;

      // Injectable dependencies support deterministic browser tests.
      this.now = options.now || Date.now;
      this.random = options.random || Math.random;

      this.setTimer =
        options.setInterval || root.setInterval.bind(root);

      this.clearTimer =
        options.clearInterval || root.clearInterval.bind(root);

      this.listeners = new Set();
      this.timer = null;
      this.running = false;
      this.scenario = 'normal';
      this.sequence = 0;

      this.events = [];
      this.readings = [];

      this.sessionStartedAt = this.now();
      this.droppedReadings = 0;
      this.droppedEvents = 0;

      this.seedHistory(
        options.seedMinutes === undefined ? 30 : options.seedMinutes
      );
    }

    createReading(timestamp, scenario, exact = false, seeded = false) {
      const config = SCENARIOS[scenario];
      const phase = timestamp / 18000;

      const noise = amplitude => exact
        ? 0
        : amplitude * (
            .55 * Math.sin(phase) +
            .45 * (this.random() * 2 - 1)
          );

      const reading = {
        id: ++this.sequence,
        timestamp,
        voltage: round(config.voltage + noise(2.5)),
        current: round(config.current + noise(2.3)),
        temperature: round(config.temperature + noise(.7)),
        scenario,
        seeded,
        source: 'local-demo',
        demo: true
      };

      reading.diagnostics = classifyDemo(reading);
      reading.health = reading.diagnostics.health;

      return reading;
    }

    seedHistory(minutes) {
      const now = this.now();

      const count = Math.min(
        this.maxReadings - 1,
        Math.max(
          0,
          Math.floor(minutes * 60000 / this.intervalMs)
        )
      );

      for (let i = count; i > 0; i--) {
        this.readings.push(
          this.createReading(
            now - i * this.intervalMs,
            'normal',
            false,
            true
          )
        );
      }

      this.current = this.createReading(now, 'normal', true);
      this.readings.push(this.current);

      this.logEvent(
        'session',
        'Demo workspace initialized',
        'normal',
        'normal',
        'Initial chart history is synthetic and explicitly marked as seeded.'
      );
    }

    logEvent(
      type,
      title,
      scenario = this.scenario,
      severity = 'normal',
      message = ''
    ) {
      const event = {
        id: 'event-' + ++this.sequence,
        timestamp: this.now(),
        type,
        title,
        scenario,
        severity,
        message,
        demo: true
      };

      this.events.push(event);

      if (this.events.length > this.maxEvents) {
        this.events.shift();
        this.droppedEvents++;
      }

      return event;
    }

    snapshot() {
      return {
        current: this.current,
        running: this.running,
        scenario: this.scenario,
        intervalMs: this.intervalMs,
        readings: this.readings.slice(),
        events: this.events.slice(),
        sessionStartedAt: this.sessionStartedAt,
        droppedReadings: this.droppedReadings,
        droppedEvents: this.droppedEvents
      };
    }

    subscribe(listener) {
      this.listeners.add(listener);

      listener(this.snapshot(), {
        type: 'snapshot'
      });

      return () => {
        this.listeners.delete(listener);
      };
    }

    emit(change) {
      const state = this.snapshot();

      this.listeners.forEach(listener => {
        listener(state, change);
      });
    }

    pushReading(exact = false) {
      // Preserve ordering even for multiple scenario changes in one millisecond.
      const timestamp = Math.max(
        this.now(),
        this.current.timestamp + 1
      );

      this.current = this.createReading(
        timestamp,
        this.scenario,
        exact
      );

      this.readings.push(this.current);

      if (this.readings.length > this.maxReadings) {
        this.readings.shift();
        this.droppedReadings++;
      }
    }

    tick() {
      if (!this.running) return;

      this.pushReading();

      this.emit({
        type: 'reading'
      });
    }

    start() {
      if (this.running) return false;

      this.running = true;

      const event = this.logEvent(
        'start',
        'Simulation started'
      );

      this.pushReading();

      this.timer = this.setTimer(
        () => this.tick(),
        this.intervalMs
      );

      this.emit({
        type: 'start',
        event
      });

      return true;
    }

    pause() {
      if (!this.running) return false;

      this.clearTimer(this.timer);

      this.timer = null;
      this.running = false;

      const event = this.logEvent(
        'pause',
        'Simulation paused'
      );

      this.emit({
        type: 'pause',
        event
      });

      return true;
    }

    setScenario(scenario) {
      if (!Object.prototype.hasOwnProperty.call(SCENARIOS, scenario)) {
        throw new RangeError('Unsupported scenario: ' + scenario);
      }

      const previous = this.scenario;

      this.scenario = scenario;
      this.pushReading(true);

      const config = SCENARIOS[scenario];

      const event = this.logEvent(
        scenario === 'normal' ? 'recovery' : 'fault',
        scenario === 'normal'
          ? 'Returned to normal demo operation'
          : config.label + ' simulated',
        scenario,
        config.severity,
        config.description
      );

      this.emit({
        type: 'scenario',
        previous,
        event
      });
    }

    reset() {
      if (this.timer !== null) {
        this.clearTimer(this.timer);
      }

      this.timer = null;
      this.running = false;
      this.scenario = 'normal';

      this.pushReading(true);

      const event = this.logEvent(
        'reset',
        'Simulation reset to normal',
        'normal',
        'normal',
        'Sampling paused. Session history retained.'
      );

      this.emit({
        type: 'reset',
        event
      });
    }

    report() {
      return {
        schemaVersion: '1.0.0',

        project:
          'Digital Twin-Based Predictive Diagnostics for EV ECUs Using CAN',

        projectCode: 'SKIT006',

        exportedAt: new Date(this.now()).toISOString(),

        sessionStartedAt:
          new Date(this.sessionStartedAt).toISOString(),

        disclaimer:
          'SIMULATED PROTOTYPE. No physical ECU or CAN connection. ' +
          'Synthetic readings. Demo risk and health are illustrative ' +
          'lookup values, not AI predictions or safety assessments.',

        units: {
          timestamp: 'Unix milliseconds UTC',
          voltage: 'V',
          current: 'A',
          temperature: 'degC',
          health: 'illustrative score /100',
          risk: 'illustrative percent, not a probability'
        },

        sampling: {
          intervalMs: this.intervalMs,
          running: this.running,
          backfillWhileBackgroundThrottled: false
        },

        retention: {
          maxReadings: this.maxReadings,
          maxEvents: this.maxEvents,
          droppedReadings: this.droppedReadings,
          droppedEvents: this.droppedEvents
        },

        scenarioDefinitions: SCENARIOS,
        activeScenario: this.scenario,
        current: this.current,

        readings: this.readings.slice(),
        events: this.events.slice()
      };
    }

    destroy() {
      if (this.timer !== null) {
        this.clearTimer(this.timer);
      }

      this.timer = null;
      this.running = false;
      this.listeners.clear();
    }
  }

  EV.SYSTEMS = SYSTEMS;
  EV.SCENARIOS = SCENARIOS;
  EV.classifyDemo = classifyDemo;
  EV.DemoSource = DemoSource;
})(window);
