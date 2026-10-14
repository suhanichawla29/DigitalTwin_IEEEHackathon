(function (root) {
  'use strict';

  const EV = root.EV = root.EV || {};

  class Animations {
    constructor(enabled = true) {
      this.enabled = enabled;

      this.media = root.matchMedia(
        '(prefers-reduced-motion: reduce)'
      );

      this.controller = new AbortController();
      this.transients = new Set();
      this.numbers = new Map();

      this.ambient = null;
      this.entranceContext = null;
      this.themeTween = null;

      this.mediaChange = () => {
        this.finishTransients();
        this.refreshAmbient();
      };

      this.media.addEventListener('change', this.mediaChange);

      document.addEventListener(
        'visibilitychange',
        () => {
          if (document.hidden) {
            this.finishTransients();
          }

          this.refreshAmbient();
        },
        { signal: this.controller.signal }
      );

      this.bindInteractions();
    }

    allowed() {
      return (
        !!root.gsap &&
        this.enabled &&
        !this.media.matches &&
        !document.hidden
      );
    }

    track(tween) {
      if (tween.totalProgress() >= 1) {
        return tween;
      }

      this.transients.add(tween);

      tween.eventCallback('onComplete', () => {
        this.transients.delete(tween);
      });

      tween.eventCallback('onInterrupt', () => {
        this.transients.delete(tween);
      });

      return tween;
    }

    entrance() {
      if (!this.allowed()) return;

      if (this.entranceContext) {
        this.entranceContext.revert();
      }

      this.entranceContext = root.gsap.context(() => {
        const timeline = root.gsap.timeline({
          defaults: {
            ease: 'power3.out'
          }
        });

        if (root.innerWidth > 900) {
          timeline.from(
            '.sidebar',
            {
              x: -24,
              opacity: 0,
              duration: .7
            },
            0
          );
        }

        timeline
          .from(
            '.topbar',
            {
              y: 13,
              opacity: 0,
              duration: .65
            },
            .06
          )
          .from(
            '.demo-banner',
            {
              opacity: 0,
              duration: .5
            },
            .16
          )
          .from(
            '#view-dashboard:not([hidden]) .metric-card',
            {
              y: 15,
              opacity: 0,
              duration: .6,
              stagger: .085
            },
            .18
          )
          .from(
            '.view:not([hidden]) .twin-panel',
            {
              scale: .985,
              opacity: 0,
              duration: .8
            },
            .32
          )
          .from(
            '.view:not([hidden]) .panel:not(.twin-panel)',
            {
              y: 12,
              opacity: 0,
              duration: .65,
              stagger: .07
            },
            .37
          );
      }, document.body);
    }

    refreshAmbient() {
      if (this.ambient) {
        this.ambient.revert();
        this.ambient = null;
      }

      if (!this.allowed()) return;

      this.ambient = root.gsap.context(() => {
        root.gsap.to('.brand-mark', {
          opacity: .6,
          duration: 2.5,
          repeat: -1,
          yoyo: true,
          ease: 'sine.inOut'
        });

        root.gsap.to(
          '.view:not([hidden]) .status-dot, .connection-box .status-dot',
          {
            opacity: .42,
            duration: 2.1,
            repeat: -1,
            yoyo: true,
            ease: 'sine.inOut',
            stagger: .13
          }
        );

        const twin = document.getElementById('twin-panel');

        if (!twin.closest('[hidden]') && twin.querySelector('.scanner')) {
          root.gsap.fromTo(
            '.scanner',
            { x: 0 },
            {
              x: 675,
              duration: 5.4,
              repeat: -1,
              repeatDelay: 2.2,
              ease: 'sine.inOut'
            }
          );

          root.gsap.to('.marker-dot', {
            opacity: .4,
            duration: 1.8,
            repeat: -1,
            yoyo: true,
            ease: 'sine.inOut',
            stagger: .18
          });

          root.gsap.to('.particle', {
            y: -9,
            x: 5,
            opacity: .1,
            duration: 4.7,
            repeat: -1,
            yoyo: true,
            stagger: .36,
            ease: 'sine.inOut'
          });

          root.gsap.fromTo(
            '.connector',
            {
              strokeDasharray: '100',
              strokeDashoffset: 100
            },
            {
              strokeDashoffset: 0,
              duration: 1.6,
              stagger: .13,
              ease: 'power2.out'
            }
          );
        }

        root.gsap.to('.sidebar-wave .wave-track', {
          x: -130,
          duration: 12,
          repeat: -1,
          ease: 'none'
        });

        if (
          !document.getElementById('overview-panel').closest('[hidden]')
        ) {
          root.gsap.to('.overview-wave .wave-track', {
            x: -200,
            duration: 13,
            repeat: -1,
            ease: 'none'
          });
        }

        root.gsap.to('.app-grid', {
          x: 7,
          y: 6,
          duration: 12,
          repeat: -1,
          yoyo: true,
          ease: 'sine.inOut'
        });
      }, document.body);
    }

    setEnabled(enabled) {
      this.enabled = !!enabled;

      if (!this.allowed()) {
        this.finishTransients();
      }

      this.refreshAmbient();
    }

    number(element, value, decimals = 0, initial = false) {
      const old = this.numbers.get(element);

      if (old) {
        old.tween.kill();
        this.transients.delete(old.tween);
      }

      const current = initial
        ? 0
        : parseFloat(
            element.textContent.replace(/[^\d.-]/g, '')
          );

      const format = number => Number(
        number.toFixed(decimals)
      ).toLocaleString(undefined, {
        maximumFractionDigits: decimals
      });

      if (
        !this.allowed() ||
        Math.abs(current - value) < .01
      ) {
        element.textContent = format(value);
        this.numbers.delete(element);
        return;
      }

      const counter = {
        value: Number.isFinite(current) ? current : value
      };

      const tween = root.gsap.to(counter, {
        value,
        duration: initial ? 1.15 : .5,
        ease: 'power2.out',
        onUpdate: () => {
          element.textContent = format(counter.value);
        }
      });

      this.track(tween);

      tween.eventCallback('onComplete', () => {
        this.transients.delete(tween);
        this.numbers.delete(element);
        element.textContent = format(value);
      });

      this.numbers.set(element, {
        tween,
        counter
      });
    }

    ring(element, percentage) {
      const target = 100 - Math.max(
        0,
        Math.min(100, percentage)
      );

      if (root.gsap) {
        root.gsap.killTweensOf(element);
      }

      if (this.allowed()) {
        this.track(
          root.gsap.to(element, {
            attr: {
              'stroke-dashoffset': target
            },
            duration: .8,
            ease: 'power2.out',
            overwrite: true
          })
        );
      } else {
        element.setAttribute('stroke-dashoffset', target);
      }
    }

    alert() {
      if (!this.allowed()) return;

      this.track(
        root.gsap.fromTo(
          '#alert-box',
          {
            x: 9,
            opacity: .3
          },
          {
            x: 0,
            opacity: 1,
            duration: .4,
            overwrite: true
          }
        )
      );

      this.track(
        root.gsap.fromTo(
          '#notification-button svg',
          {
            rotation: -13
          },
          {
            rotation: 0,
            duration: .14,
            repeat: 4,
            yoyo: true,
            transformOrigin: '50% 15%',
            ease: 'sine.inOut',
            overwrite: true
          }
        )
      );
    }

    flash(ids) {
      if (!this.allowed()) return;

      const targets = ids.flatMap(id => Array.from(
        document.querySelectorAll(
          '.system-item[data-system="' + id + '"]'
        )
      ));

      if (!targets.length) return;

      this.track(
        root.gsap.fromTo(
          targets,
          {
            opacity: .3
          },
          {
            opacity: 1,
            duration: .28,
            repeat: 4,
            yoyo: true,
            ease: 'sine.inOut',
            overwrite: true
          }
        )
      );
    }

    route(view) {
      // Remove entrance transforms before shared panels change views.
      if (this.entranceContext) {
        this.entranceContext.revert();
        this.entranceContext = null;
      }

      if (this.allowed()) {
        this.track(
          root.gsap.fromTo(
            view,
            {
              opacity: .3,
              y: 8
            },
            {
              opacity: 1,
              y: 0,
              duration: .35,
              overwrite: true
            }
          )
        );

        this.track(
          root.gsap.fromTo(
            '.nav-item.active',
            {
              filter: 'brightness(1.35)'
            },
            {
              filter: 'brightness(1)',
              duration: .45,
              overwrite: true
            }
          )
        );
      }

      this.refreshAmbient();
    }

    dialog(element) {
      if (!this.allowed()) return;

      this.track(
        root.gsap.fromTo(
          element,
          {
            opacity: 0,
            y: 10,
            scale: .985
          },
          {
            opacity: 1,
            y: 0,
            scale: 1,
            duration: .25,
            ease: 'power2.out',
            overwrite: true
          }
        )
      );
    }

    cancelTheme() {
      if (this.themeTween) {
        this.themeTween.kill();
        this.themeTween = null;
      }

      if (this.themeKeys) {
        this.themeKeys.forEach(key => {
          document.documentElement.style.removeProperty(key);
        });
      }
    }

    theme(previous, next, onComplete) {
      this.themeKeys = Object.keys(previous);

      if (!this.allowed()) {
        onComplete();
        return;
      }

      this.themeKeys.forEach(key => {
        document.documentElement.style.setProperty(
          key,
          previous[key]
        );
      });

      this.themeTween = root.gsap.to(
        document.documentElement,
        {
          ...next,
          duration: .45,
          ease: 'power1.inOut',
          onComplete: () => {
            this.cancelTheme();
            onComplete();
          }
        }
      );
    }

    finishTransients() {
      if (this.entranceContext) {
        this.entranceContext.revert();
        this.entranceContext = null;
      }

      Array.from(this.transients).forEach(tween => {
        tween.totalProgress(1);
        tween.kill();
      });

      this.transients.clear();
      this.numbers.clear();

      if (this.themeTween) {
        this.themeTween.totalProgress(1);
      }
    }

    bindInteractions() {
      const options = {
        signal: this.controller.signal
      };

      const selector =
        '.metric-card, button:not(.nav-scrim), .nav-item';

      document.addEventListener('pointerover', event => {
        const element = event.target.closest(selector);

        if (
          !element ||
          element.contains(event.relatedTarget) ||
          !this.allowed() ||
          event.pointerType === 'touch' ||
          element.disabled
        ) {
          return;
        }

        if (element.matches('.metric-card')) {
          this.track(
            root.gsap.to(element, {
              y: -3,
              duration: .2,
              overwrite: true
            })
          );
        } else if (element.matches('.nav-item')) {
          this.track(
            root.gsap.to(element.querySelector('svg'), {
              x: 2,
              rotation: 5,
              duration: .2,
              overwrite: true
            })
          );
        } else {
          this.track(
            root.gsap.to(element, {
              scale: 1.015,
              filter: 'brightness(1.13)',
              duration: .18,
              overwrite: true
            })
          );
        }
      }, options);

      document.addEventListener('pointerout', event => {
        const element = event.target.closest(selector);

        if (
          !element ||
          element.contains(event.relatedTarget) ||
          !root.gsap
        ) {
          return;
        }

        const duration = this.allowed() ? .2 : 0;

        if (element.matches('.metric-card')) {
          this.track(
            root.gsap.to(element, {
              y: 0,
              duration,
              overwrite: true
            })
          );
        } else if (element.matches('.nav-item')) {
          this.track(
            root.gsap.to(element.querySelector('svg'), {
              x: 0,
              rotation: 0,
              duration,
              overwrite: true
            })
          );
        } else {
          this.track(
            root.gsap.to(element, {
              scale: 1,
              filter: 'brightness(1)',
              duration,
              overwrite: true
            })
          );
        }
      }, options);

      document.addEventListener('click', event => {
        const button = event.target.closest('button');

        if (
          !button ||
          button.disabled ||
          !this.allowed()
        ) {
          return;
        }

        this.track(
          root.gsap.fromTo(
            button,
            {
              scale: .97
            },
            {
              scale: 1,
              duration: .2,
              ease: 'power2.out',
              overwrite: true
            }
          )
        );
      }, options);
    }

    destroy() {
      this.controller.abort();

      this.media.removeEventListener(
        'change',
        this.mediaChange
      );

      this.finishTransients();
      this.cancelTheme();

      if (this.ambient) {
        this.ambient.revert();
      }
    }
  }

  EV.Animations = Animations;
})(window);

