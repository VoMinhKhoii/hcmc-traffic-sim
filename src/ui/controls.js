// @ts-check
// ui/controls.js — the operator console: tunable sliders bound to CONFIG and
// the scenario buttons from the verification matrix.

import { CONFIG } from '../config.js';

export function buildControls(root, sim) {
  root.innerHTML = `
    <h3>Operator console</h3>
    <div class="grp"><label>Time scale <span id="v-ts">${CONFIG.timeScale}×</span></label>
      <input id="s-ts" type="range" min="1" max="120" value="${CONFIG.timeScale}"></div>
    <div class="grp"><label>Demand ×<span id="v-dm">${CONFIG.demandMultiplier.toFixed(1)}</span></label>
      <input id="s-dm" type="range" min="0" max="2" step="0.1" value="${CONFIG.demandMultiplier}"></div>
    <div class="grp"><label>Congestion threshold <span id="v-th">${CONFIG.congestionThreshold}</span> veh</label>
      <input id="s-th" type="range" min="10" max="60" value="${CONFIG.congestionThreshold}"></div>
    <div class="grp"><label>Jump clock</label>
      <button data-h="7">Peak 07:00</button><button data-h="11">Off-peak 11:00</button><button data-h="23.5">Night 23:30</button></div>
    <div class="grp"><label>Scenarios</label>
      <button id="b-ev1">EV I1→I2→I4</button>
      <button id="b-ev2">EV I3→I5→I6→I4</button>
      <button id="b-acc">Accident <select id="sel-acc">
        <option value="I6-I4:I6">I6→I4</option><option value="I2-I4:I2">I2→I4</option>
        <option value="I1-I6:I1">I1→I6</option><option value="I3-I5:I3">I3→I5</option></select></button>
      <button id="b-train1">Force train ↘</button><button id="b-train2">Force train ↖</button></div>
    <div class="grp"><label>Failures</label>
      <button id="b-kill" class="warn">Kill central</button>
      <button id="b-jamA" class="warn">Jam gate A</button>
      <button id="b-jamB" class="warn">Jam gate B</button></div>
    <div class="grp dim">Pedestrian buttons + per-light state: click an
      intersection on the map to open its local controller.</div>`;

  const $ = (id) => root.querySelector(id);
  $('#s-ts').oninput = (e) => { CONFIG.timeScale = +e.target.value; $('#v-ts').textContent = `${CONFIG.timeScale}×`; };
  $('#s-dm').oninput = (e) => { CONFIG.demandMultiplier = +e.target.value; $('#v-dm').textContent = CONFIG.demandMultiplier.toFixed(1); };
  $('#s-th').oninput = (e) => { CONFIG.congestionThreshold = +e.target.value; $('#v-th').textContent = String(CONFIG.congestionThreshold); };
  root.querySelectorAll('[data-h]').forEach((b) => { b.onclick = () => { sim.clock.startHour = +b.dataset.h - sim.clock.t / 3600; }; });
  $('#b-ev1').onclick = () => sim.dispatchEV(['I1', 'I2', 'I4']);
  $('#b-ev2').onclick = () => sim.dispatchEV(['I3', 'I5', 'I6', 'I4']);
  $('#b-acc').onclick = () => { const [l, f] = $('#sel-acc').value.split(':'); sim.dropAccident(l, f, 2); };
  $('#b-train1').onclick = () => sim.forceTrain(1);
  $('#b-train2').onclick = () => sim.forceTrain(-1);

  const kill = $('#b-kill');
  kill.onclick = () => {
    if (sim.centralAlive) { sim.killCentral(); kill.textContent = 'Restore central'; kill.classList.add('active'); }
    else { sim.restoreCentral(); kill.textContent = 'Kill central'; kill.classList.remove('active'); }
  };
  for (const name of ['A', 'B']) {
    const b = $(`#b-jam${name}`);
    b.onclick = () => {
      const c = sim.railway.crossings[name];
      if (!c.fault) { sim.jamGate(name); b.textContent = `Fix gate ${name}`; b.classList.add('active'); }
      else { sim.clearGateFault(name); b.textContent = `Jam gate ${name}`; b.classList.remove('active'); }
    };
  }
}
