/*
 * Original SVG vehicle illustration.
 * Dragging tilts the illustration; it is not true 3D rotation.
 */

(function (root) {
  'use strict';

  const EV = root.EV = root.EV || {};

  const COLORS = {
    battery: '#17dfba',
    motor: '#00d9ff',
    thermal: '#a278ff',
    bms: '#ffc866',
    vcu: '#53acff'
  };

  const DETAILS = {
    battery:
      'Battery Pack · illustrative high-voltage traction battery',
    motor:
      'Motor Controller · illustrative traction inverter',
    thermal:
      'Thermal System · illustrative coolant circuit',
    bms:
      'BMS · illustrative battery management controller',
    vcu:
      'VCU · illustrative vehicle control unit'
  };

  const COMPONENT_NAMES = {
    battery: 'Battery Pack',
    motor: 'Motor Controller',
    thermal: 'Thermal System',
    bms: 'Battery Management System',
    vcu: 'Vehicle Control Unit'
  };

  const COMPONENT_SIGNALS = {
    battery: ['Voltage'],
    motor: ['Current'],
    thermal: ['Temperature'],
    bms: ['Voltage', 'Current', 'Temperature'],
    vcu: []
  };

  const FAULT_COMPONENTS = {
    'under-voltage': ['battery', 'bms'],
    'low-voltage': ['battery', 'bms'],
    'over-voltage': ['battery', 'bms'],
    'over-current': ['motor', 'vcu'],
    'over-temperature': ['thermal', 'bms']
  };

  const SIGNAL_READINGS = {
    Voltage: ['voltage', 'V'],
    Current: ['current', 'A'],
    Temperature: ['temperature', '°C']
  };

  const escapeHtml = value => String(value).replace(
    /[&<>"']/g,
    char => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[char]
  );

  function wheel(x, y, rx, ry) {
    const spokes = Array.from({ length: 12 }, (_, i) => {
      const a = i * Math.PI / 6;
      const b = a + .09;

      return `
        <path
          d="
            M${Math.cos(a) * 8},${Math.sin(a) * 11}
            L${Math.cos(b) * rx * .78},${Math.sin(b) * ry * .78}
            M${Math.cos(a) * 8},${Math.sin(a) * 11}
            L${Math.cos(a - .055) * rx * .75},${Math.sin(a - .055) * ry * .75}
          "
          class="wheel-spoke"
        />
      `;
    }).join('');

    const treads = Array.from({ length: 18 }, (_, i) => {
      const a = i * Math.PI / 9;

      return `
        <path
          d="
            M${Math.cos(a) * rx * .93},${Math.sin(a) * ry * .94}
            L${Math.cos(a) * rx * 1.035},${Math.sin(a) * ry * 1.015}
          "
          class="vehicle-wire"
        />
      `;
    }).join('');

    return `
      <g transform="translate(${x} ${y}) rotate(14)">
        <ellipse
          cx="0"
          cy="0"
          rx="${rx}"
          ry="${ry}"
          class="wheel-tire"
        />

        <ellipse
          cx="0"
          cy="0"
          rx="${rx * .8}"
          ry="${ry * .84}"
          class="wheel-inner"
        />

        <ellipse
          cx="0"
          cy="0"
          rx="${rx * .69}"
          ry="${ry * .74}"
          fill="none"
          stroke="#267bbd"
          stroke-width=".8"
        />

        ${spokes}
        ${treads}

        <ellipse
          rx="8"
          ry="11"
          fill="#0a2e51"
          stroke="#6cd9ff"
          stroke-width="1"
        />

        <ellipse
          rx="3"
          ry="4"
          fill="#8decff"
        />
      </g>
    `;
  }

  function marker(
    id,
    x,
    y,
    width,
    label,
    path,
    dotX,
    dotY
  ) {
    return `
      <g
        class="component-marker"
        data-component="${id}"
        tabindex="0"
        role="button"
        aria-label="Inspect ${label}"
        aria-pressed="false"
        style="--component-color:${COLORS[id]}"
      >
        <path
          class="connector"
          d="${path}"
          pathLength="100"
        />

        <circle
          class="marker-dot"
          cx="${dotX}"
          cy="${dotY}"
          r="2.9"
        />

        <circle
          class="component-node"
          cx="${dotX}"
          cy="${dotY}"
          r="6"
          opacity=".2"
        />

        <rect
          x="${x}"
          y="${y}"
          width="${width}"
          height="25"
          rx="12.5"
        />

        <text
          x="${x + width / 2}"
          y="${y + 16}"
          text-anchor="middle"
        >${label}</text>
      </g>
    `;
  }

  function illustration() {
    const batteryCells = Array.from({ length: 11 }, (_, i) => {
      const x = 381 + i * 17;
      const y = 273 - i * 6;

      return `
        <path
          d="M${x} ${y}l47 23v27l-47-23z"
          stroke="#2affda"
          stroke-width=".8"
          fill="#05f8ad"
          fill-opacity=".045"
        />
      `;
    }).join('');

    const hoodWires = Array.from({ length: 8 }, (_, i) => {
      const a = i / 7;

      return `
        <path
          d="
            M${189 + a * 154},${280 + a * 15}
            Q${227 + a * 151},${236 + a * 12}
            ${327 + a * 111},${212 + a * 15}
          "
        />
      `;
    }).join('');

    const roofWires = Array.from({ length: 7 }, (_, i) => `
      <path
        d="
          M${398 + i * 28},${141 - i * 5}
          Q${461 + i * 26},${112 - i * 4}
          ${529 + i * 27},${115 + i * 3}
        "
      />
    `).join('');

    const particles = [
      [116, 205],
      [200, 383],
      [793, 250],
      [613, 400],
      [756, 111],
      [308, 99],
      [121, 328],
      [668, 72]
    ].map(([x, y]) => `
      <circle
        class="particle"
        cx="${x}"
        cy="${y}"
        r="1.6"
      />
    `).join('');

    return `
      <svg
        viewBox="80 55 760 390"
        xmlns="http://www.w3.org/2000/svg"
        aria-labelledby="vehicle-svg-title vehicle-svg-description"
      >
        <title id="vehicle-svg-title">
          EV–01 transparent electric crossover illustration
        </title>

        <desc id="vehicle-svg-description">
          Original three-quarter wireframe-style vehicle with battery
          pack, motor controller, thermal circuit, BMS, and VCU markers.
          Dragging tilts the two-dimensional illustration; this is not
          a mechanical simulation.
        </desc>

        <defs>
          <linearGradient
            id="body-gradient"
            x1=".1"
            y1="1"
            x2=".8"
            y2="0"
          >
            <stop
              stop-color="#0566e3"
              stop-opacity=".05"
            />
            <stop
              offset=".5"
              stop-color="#0d70f3"
              stop-opacity=".14"
            />
            <stop
              offset="1"
              stop-color="#107cff"
              stop-opacity=".23"
            />
          </linearGradient>

          <linearGradient
            id="glass-gradient"
            x1="0"
            y1="1"
            x2="1"
            y2="0"
          >
            <stop
              stop-color="#082d66"
              stop-opacity=".6"
            />
            <stop
              offset="1"
              stop-color="#087fea"
              stop-opacity=".08"
            />
          </linearGradient>

          <linearGradient id="scan-gradient">
            <stop
              stop-color="#00ddff"
              stop-opacity="0"
            />
            <stop
              offset=".55"
              stop-color="#00ddff"
              stop-opacity=".02"
            />
            <stop
              offset=".94"
              stop-color="#00ddff"
              stop-opacity=".2"
            />
            <stop
              offset="1"
              stop-color="#87f7ff"
              stop-opacity=".75"
            />
          </linearGradient>

          <radialGradient id="ground-gradient">
            <stop
              stop-color="#008cff"
              stop-opacity=".11"
            />
            <stop
              offset="1"
              stop-color="#008cff"
              stop-opacity="0"
            />
          </radialGradient>

          <filter
            id="vehicle-glow"
            x="-30%"
            y="-30%"
            width="160%"
            height="160%"
          >
            <feGaussianBlur
              stdDeviation="2"
              result="blur"
            />
            <feMerge>
              <feMergeNode in="blur"/>
              <feMergeNode in="SourceGraphic"/>
            </feMerge>
          </filter>

          <clipPath id="car-clip">
            <path
              d="M166 295Q168 272 196 255L327 204Q363 151 415 124Q465 97 549 99L654 117Q707 125 738 153L764 176L771 228Q766 256 736 270L397 367L258 379L180 345Z"
            />
          </clipPath>
        </defs>

        <!-- Ground projection -->
        <ellipse
          cx="471"
          cy="332"
          rx="353"
          ry="104"
          fill="url(#ground-gradient)"
        />

        <g
          fill="none"
          stroke="#168aee"
          stroke-width=".65"
          opacity=".35"
        >
          <ellipse
            cx="473"
            cy="320"
            rx="341"
            ry="111"
            transform="rotate(-8 473 320)"
          />

          <ellipse
            cx="473"
            cy="320"
            rx="310"
            ry="99"
            transform="rotate(-8 473 320)"
          />

          <ellipse
            cx="473"
            cy="320"
            rx="275"
            ry="85"
            transform="rotate(-8 473 320)"
          />

          <path
            d="M149 375Q119 347 132 321M516 426Q716 401 793 332M152 287Q194 251 266 240"
            stroke="#1cd4ff"
            stroke-width="1.3"
            opacity=".9"
          />
        </g>

        <g class="vehicle-art">
          <!-- Far wheels -->
          <g opacity=".4">
            ${wheel(252, 292, 30, 46)}
            ${wheel(604, 194, 25, 39)}
          </g>

          <!-- Underbody -->
          <path
            d="M206 307L620 167L750 223L393 362L255 374Z"
            fill="#03182d"
            fill-opacity=".45"
            stroke="#1261b0"
          />

          <!-- Exterior body -->
          <path
            class="vehicle-body"
            d="M166 295Q168 272 196 255L327 204Q363 151 415 124Q465 97 549 99L654 117Q707 125 738 153L764 176L771 228Q766 256 736 270L726 249Q718 204 690 210Q654 217 646 274L403 350Q404 298 374 286Q334 274 320 339L309 368L258 379L180 345Z"
          />

          <path
            class="vehicle-body"
            d="M196 255L327 204L444 224L347 298L275 321L166 295Q168 272 196 255Z"
          />

          <!-- Windshield and side glazing -->
          <path
            d="M332 203Q373 150 418 131Q447 119 487 120L541 129Q481 150 444 219Z"
            fill="url(#glass-gradient)"
            stroke="#289cec"
            stroke-width="1.2"
          />

          <path
            d="M455 220Q489 165 550 137L619 141L616 189Z"
            fill="url(#glass-gradient)"
            stroke="#2697f9"
            stroke-width="1.3"
          />

          <path
            d="M628 140L675 147Q701 153 726 174L637 200L628 197Z"
            fill="url(#glass-gradient)"
            stroke="#2697f9"
            stroke-width="1.3"
          />

          <!-- Roof contour -->
          <path
            class="vehicle-edge"
            d="M328 204Q366 151 419 126Q476 99 544 107L653 124Q704 131 737 159"
          />

          <!-- Door and panel seams -->
          <path
            class="vehicle-seam"
            d="M336 206Q375 156 423 135M443 224Q488 150 545 130L657 142M540 129L549 137M620 139L628 198M628 198L638 295M448 225L456 329M458 230L611 185M462 237L455 280L459 318L612 274L614 202M635 208L654 262M622 195L620 274M727 176L746 197L739 212"
          />

          <path
            class="vehicle-seam"
            d="M414 335L639 272M415 343L638 280M402 352L644 284M196 270Q264 291 349 285M179 289L276 311L340 294M179 318L257 347L311 333M191 345L258 367L310 353M211 350L254 358"
          />

          <!-- Technical wireframe lines -->
          <g
            class="vehicle-wire"
            clip-path="url(#car-clip)"
          >
            ${hoodWires}
            ${roofWires}

            <path
              d="M193 265Q284 292 360 275M211 253Q290 279 378 263M234 243Q310 267 397 251M262 231Q328 254 417 237M392 144Q448 137 495 151M379 157Q430 155 482 169M365 171Q419 175 470 186M350 187Q402 192 457 204M458 247L753 155M455 264L765 178M453 284L770 199M446 306L766 224M525 150L520 307M564 137L563 295M593 142L594 286M662 146L670 220M692 155L701 212"
            />
          </g>

          <!-- Front lighting -->
          <path
            d="M169 294L180 300L184 324L178 321Z"
            fill="#0471c9"
            stroke="#00d9ff"
          />

          <path
            d="M183 281Q214 286 250 300L269 311L236 309L188 293Z"
            fill="#24caff"
            fill-opacity=".25"
            stroke="#63e7ff"
            stroke-width="1.5"
            filter="url(#vehicle-glow)"
          />

          <path
            d="M282 306L326 290L341 284L333 299L286 318Z"
            fill="#24caff"
            fill-opacity=".3"
            stroke="#63e7ff"
            stroke-width="1.5"
            filter="url(#vehicle-glow)"
          />

          <!-- Front grille -->
          <path
            d="M191 312L248 328L270 325L299 315L303 338L264 353L203 333Z"
            fill="#020f24"
            fill-opacity=".7"
            stroke="#1a74c5"
          />

          <g class="vehicle-wire">
            <path
              d="M198 318L259 336L296 322M201 324L262 342L297 328M209 311L218 337M226 318L234 342M246 325L252 347M274 325L276 346M287 320L288 341"
            />
          </g>

          <path
            d="M197 344L256 364L305 345L300 356L256 371L189 347Z"
            fill="#07427d"
            fill-opacity=".35"
            stroke="#238ddb"
          />

          <!-- Wheel arches and sill -->
          <path
            class="vehicle-seam"
            d="M308 360Q313 295 346 282Q379 267 397 302M644 270Q651 215 680 204Q715 190 731 235"
          />

          <path
            class="vehicle-edge"
            d="M166 295L171 330L181 345L256 376L309 366M402 350L644 277M736 267Q766 253 770 230"
          />

          <!-- Rear lamp -->
          <path
            d="M735 164L760 177L765 190L743 181Z"
            fill="#aa37ff"
            fill-opacity=".4"
            stroke="#a66cff"
          />

          <!-- Mirror -->
          <path
            d="M443 218L423 206L404 213L406 225L430 231Z"
            fill="#066abd"
            fill-opacity=".5"
            stroke="#37caff"
          />

          <!-- Door handles -->
          <path
            class="vehicle-seam"
            d="M431 222L445 230M562 214L584 207Q589 208 586 211L564 218ZM669 186L686 181L689 184L672 190Z"
          />

          <path
            class="vehicle-seam"
            d="M599 111L676 123L705 136L687 138L646 129"
          />

          <!-- Battery pack -->
          <g
            class="twin-component"
            data-component="battery"
            style="--component-color:${COLORS.battery}"
          >
            <path d="M369 276L548 214L607 240L426 306Z"/>
            <path d="M426 306L607 240L607 268L426 334Z"/>
            <path d="M369 276L426 306L426 334L369 304Z"/>

            ${batteryCells}

            <path
              d="M382 272L438 302M402 265L458 295M424 258L480 287M445 251L501 280M466 243L522 273M487 236L543 265M508 229L564 258M529 222L585 251"
            />
          </g>

          <!-- Motor controller -->
          <g
            class="twin-component"
            data-component="motor"
            style="--component-color:${COLORS.motor}"
          >
            <path d="M286 268L336 250L371 267L321 287Z"/>
            <path d="M286 268L321 287L321 313L286 295Z"/>
            <path d="M321 287L371 267L371 293L321 313Z"/>

            <path
              d="M296 268L330 286M307 262L341 281M320 258L354 276M330 286V308M343 281V303M356 276V299"
            />
          </g>

          <!-- Thermal circuit -->
          <g
            class="twin-component"
            data-component="thermal"
            style="--component-color:${COLORS.thermal}"
            fill-opacity=".05"
          >
            <path
              d="M353 292L363 274L544 209L628 235L628 272L421 347L367 322L354 295"
              fill="none"
              stroke-width="3"
            />

            <path
              d="M563 223L580 212L610 226L609 243L591 251L564 239Z"
            />

            <path
              d="M571 222L599 234M576 216L605 229"
            />
          </g>

          <!-- Battery management system -->
          <g
            class="twin-component"
            data-component="bms"
            style="--component-color:${COLORS.bms}"
          >
            <path d="M505 243L532 233L552 243L525 253Z"/>

            <path
              d="M505 243L525 253L525 264L505 254ZM525 253L552 243V254L525 264Z"
            />

            <path
              d="M512 243L530 249L544 244M532 254V260M539 251V257"
            />
          </g>

          <!-- Vehicle control unit -->
          <g
            class="twin-component"
            data-component="vcu"
            style="--component-color:${COLORS.vcu}"
          >
            <path d="M444 217L474 207L493 218L463 230Z"/>

            <path
              d="M444 217L463 230V244L444 232ZM463 230L493 218V232L463 244Z"
            />

            <path d="M451 218L464 226L482 219"/>
          </g>

          <!-- Near wheels -->
          ${wheel(355, 333, 39, 55)}
          ${wheel(691, 254, 32, 47)}

          <path
            class="vehicle-edge"
            d="M308 329Q314 292 341 280Q376 265 396 300M645 250Q654 214 682 205Q711 198 728 231"
            opacity=".7"
          />

          <!-- Animated scanning overlay -->
          <g clip-path="url(#car-clip)">
            <rect
              class="scanner"
              x="105"
              y="93"
              width="105"
              height="300"
            />
          </g>

          <!-- Selectable component markers -->
          ${marker(
            'motor',
            214,
            113,
            116,
            'Motor Controller',
            'M307 138L314 165L322 268',
            322,
            268
          )}

          ${marker(
            'battery',
            385,
            399,
            96,
            'Battery Pack',
            'M433 399L452 374L472 304',
            472,
            304
          )}

          ${marker(
            'thermal',
            651,
            345,
            107,
            'Thermal System',
            'M675 345L644 321L604 257',
            604,
            257
          )}

          ${marker(
            'bms',
            607,
            69,
            61,
            'BMS',
            'M637 94L621 119L531 240',
            531,
            240
          )}

          ${marker(
            'vcu',
            406,
            65,
            61,
            'VCU',
            'M437 90L448 123L467 214',
            467,
            214
          )}
        </g>

        ${particles}
      </svg>
    `;
  }

  class DigitalTwin {
    constructor(stage, onSelect, motionAllowed) {
      this.stage = stage;
      this.onSelect = onSelect;
      this.motionAllowed = motionAllowed;

      this.selected = null;
      this.state = null;

      this.angle = 0;
      this.shift = 0;
      this.drag = null;
      this.suppressClick = false;

      this.controller = new AbortController();

      stage.innerHTML = illustration();
      this.art = stage.querySelector('.vehicle-art');
      stage.querySelectorAll('.twin-component').forEach(element => {
        const id = element.dataset.component;
        element.setAttribute('tabindex', '0');
        element.setAttribute('role', 'button');
        element.setAttribute(
          'aria-label',
          'Inspect ' + COMPONENT_NAMES[id]
        );
        element.setAttribute('aria-pressed', 'false');
      });

      const options = {
        signal: this.controller.signal
      };

      // Select a component by clicking its geometry or marker.
      stage.addEventListener('click', event => {
        if (this.suppressClick) {
          this.suppressClick = false;
          return;
        }

        const target = event.target.closest('[data-component]');

        if (target) {
          this.select(target.dataset.component);
        }
      }, options);

      // Dragging adjusts only the 2D illustration's tilt and offset.
      stage.addEventListener('pointerdown', event => {
        if (
          event.button !== 0 ||
          event.target.closest('[data-component]')
        ) {
          return;
        }

        this.drag = {
          x: event.clientX,
          y: event.clientY,
          angle: this.angle,
          shift: this.shift,
          id: event.pointerId
        };

        this.stage.setPointerCapture(event.pointerId);
        this.stage.classList.add('dragging');

        this.suppressClick = false;
      }, options);

      stage.addEventListener('pointermove', event => {
        if (
          !this.drag ||
          event.pointerId !== this.drag.id
        ) {
          return;
        }

        const dx = event.clientX - this.drag.x;
        const dy = event.clientY - this.drag.y;

        if (Math.abs(dx) + Math.abs(dy) > 5) {
          this.suppressClick = true;
        }

        this.angle = Math.max(
          -6,
          Math.min(6, this.drag.angle + dx * .035)
        );

        this.shift = Math.max(
          -12,
          Math.min(12, this.drag.shift + dy * .08)
        );

        this.applyTilt(false);
      }, options);

      const end = () => {
        this.drag = null;
        this.stage.classList.remove('dragging');
      };

      stage.addEventListener('pointerup', end, options);
      stage.addEventListener('pointercancel', end, options);
      stage.addEventListener('lostpointercapture', end, options);

      // Keyboard access.
      stage.addEventListener('keydown', event => {
        const componentElement = event.target.closest(
          '[data-component]'
        );

        if (
          componentElement &&
          (
            event.key === 'Enter' ||
            event.key === ' '
          )
        ) {
          event.preventDefault();
          this.select(componentElement.dataset.component);
          return;
        }

        if (event.key === 'Home') {
          event.preventDefault();
          this.reset();
        }

        if (
          [
            'ArrowLeft',
            'ArrowRight',
            'ArrowUp',
            'ArrowDown'
          ].includes(event.key)
        ) {
          event.preventDefault();

          if (event.key === 'ArrowLeft') {
            this.angle = Math.max(-6, this.angle - 1);
          }

          if (event.key === 'ArrowRight') {
            this.angle = Math.min(6, this.angle + 1);
          }

          if (event.key === 'ArrowUp') {
            this.shift = Math.max(-12, this.shift - 2);
          }

          if (event.key === 'ArrowDown') {
            this.shift = Math.min(12, this.shift + 2);
          }

          this.applyTilt();
        }
      }, options);
    }

    applyTilt(animate = true) {
      if (this.tiltTween) {
        this.tiltTween.kill();
      }

      if (
        root.gsap &&
        animate &&
        this.motionAllowed()
      ) {
        this.tiltTween = root.gsap.to(this.art, {
          rotation: this.angle,
          y: this.shift,
          duration: .35,
          ease: 'power2.out',
          svgOrigin: '460 280',
          overwrite: true
        });
      } else if (root.gsap) {
        root.gsap.set(this.art, {
          rotation: this.angle,
          y: this.shift,
          svgOrigin: '460 280'
        });
      } else {
        this.art.setAttribute(
          'transform',
          `translate(0 ${this.shift}) rotate(${this.angle} 460 280)`
        );
      }
    }

    reset() {
      this.angle = 0;
      this.shift = 0;

      this.applyTilt();
    }

    select(id) {
      if (!DETAILS[id]) return;

      this.selected = id;

      this.stage.querySelectorAll(
        '[data-component]'
      ).forEach(element => {
        const selected = element.dataset.component === id;

        element.classList.toggle('selected', selected);
        element.setAttribute('aria-pressed', String(selected));
      });

      this.describe();

      if (this.onSelect) {
        this.onSelect(id);
      }
    }

    describe() {
      const panel = document.getElementById('component-detail');
      if (!panel) return;

      if (!this.selected) {
        panel.innerHTML = '<p>Select a vehicle component to inspect its live details.</p>';
        return;
      }

      const id = this.selected;
      const name = COMPONENT_NAMES[id];
      const current = this.state && this.state.current;
      const diagnostics = current && current.diagnostics;
      const status = diagnostics?.systems?.[id] || 'unknown';
      const faultList = (diagnostics?.faults || []).filter(fault =>
        !FAULT_COMPONENTS[fault.code] ||
        FAULT_COMPONENTS[fault.code].includes(id)
      );
      const signals = COMPONENT_SIGNALS[id];
      const canMessages = this.state?.canMessages || [];
      const associatedMessages = signals.length
        ? canMessages.filter(message =>
            (message.decoded_signals || []).some(signal =>
              signals.includes(signal.name)
            )
          ).slice(-3).reverse()
        : [];
      const sender = associatedMessages.find(message => message.source_ecu)
        ?.source_ecu;
      const signalRows = Object.entries(SIGNAL_READINGS).map(
        ([signalName, [readingKey, unit]]) => {
          const value = current && Number(current[readingKey]);
          return `
            <div class="component-telemetry-item">
              <dt>${signalName}</dt>
              <dd>${Number.isFinite(value)
                ? escapeHtml(value.toFixed(1)) + ' ' + unit
                : 'Unavailable'}</dd>
            </div>
          `;
        }
      ).join('');
      const alerts = faultList.length
        ? `<ul class="component-alert-list">${faultList.map(fault => `
            <li class="${escapeHtml(fault.severity || 'warning')}">
              <strong>${escapeHtml(fault.label || fault.code)}</strong>
              <span>${escapeHtml(fault.description || '')}</span>
            </li>
          `).join('')}</ul>`
        : '<p class="component-empty">No active diagnostic alerts.</p>';
      const messages = associatedMessages.length
        ? `<ul class="component-can-list">${associatedMessages.map(message => `
            <li>
              <code>${escapeHtml(message.can_id || 'Unknown ID')}</code>
              <span>${escapeHtml(message.message_name || 'Unnamed DBC message')}</span>
              <time>${escapeHtml(new Date(
                Number(message.timestamp) * 1000
              ).toLocaleTimeString())}</time>
            </li>
          `).join('')}</ul>`
        : `<p class="component-empty">${
            signals.length
              ? 'No recent CAN message contains the inferred signal mapping.'
              : 'The DBC defines no VCU-specific telemetry signal or message.'
          }</p>`;

      panel.innerHTML = `
        <div class="component-detail-heading">
          <div>
            <span class="eyebrow">COMPONENT / ECU INSPECTOR</span>
            <h3>${escapeHtml(name)}</h3>
          </div>
          <span class="pill ${escapeHtml(status)}">${escapeHtml(status)}</span>
        </div>
        <p class="component-description">${escapeHtml(DETAILS[id])}</p>
        <p class="component-source">
          DBC sender: <strong>${sender
            ? escapeHtml(sender)
            : 'not component-specific'}</strong>
          · signal association is inferred from signal names.
        </p>
        <div class="component-detail-grid">
          <section>
            <h4>Latest vehicle telemetry</h4>
            <p class="component-source">Vehicle-wide values; the DBC does not define per-component measurements.</p>
            <dl class="component-telemetry">${signalRows}</dl>
          </section>
          <section>
            <h4>Active diagnostic alerts</h4>
            ${alerts}
          </section>
          <section class="component-can-section">
            <h4>Recent associated CAN messages</h4>
            ${messages}
          </section>
        </div>
        <p class="component-updated">Last updated: ${
          current
            ? escapeHtml(new Date(current.timestamp).toLocaleString())
            : 'Awaiting telemetry'
        }</p>
      `;
    }

    update(state) {
      this.state = state;

      this.stage.querySelectorAll(
        '[data-component]'
      ).forEach(element => {
        const id = element.dataset.component;
        const status = state.current.diagnostics.systems[id];

        const color = status === 'critical'
          ? '#ff6e83'
          : status === 'warning'
            ? '#ffbd5b'
            : COLORS[id];

        element.style.setProperty(
          '--component-color',
          color
        );
      });

      this.describe();
    }

    destroy() {
      this.controller.abort();

      if (this.tiltTween) {
        this.tiltTween.kill();
      }
    }
  }

  EV.DigitalTwin = DigitalTwin;
})(window);
