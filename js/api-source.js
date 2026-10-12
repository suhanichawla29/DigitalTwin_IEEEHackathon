
(function (root) {
  'use strict';

  const EV = root.EV = root.EV || {};
  const API_URL = 'http://127.0.0.1:8000/api/readings';

  async function getReadings() {
    const response = await fetch(API_URL);

    if (!response.ok) {
      throw new Error('Failed to fetch EV readings');
    }

    return await response.json();
  }

  EV.getApiReadings = getReadings;
})(window);
