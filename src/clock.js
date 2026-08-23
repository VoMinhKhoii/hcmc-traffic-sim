// clock.js — simulation time. Owns nothing but time; everyone asks it.

import { CONFIG, modeAt } from './config.js';

export class SimClock {
  constructor(startHour = CONFIG.startHour) {
    this.t = 0;                       // sim seconds since start
    this.startHour = startHour;
  }
  advance(dt) { this.t += dt; }
  get hour() { return (this.startHour + this.t / 3600) % 24; }
  get mode() { return modeAt(this.hour); }
  get hhmm() {
    const h = Math.floor(this.hour), m = Math.floor((this.hour - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}
