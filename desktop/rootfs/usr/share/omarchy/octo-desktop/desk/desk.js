(function () {
  'use strict';

  var STATE_URL = '/desk/state';
  var POLL_MS = 4000;
  var BLINK_GAP_MS = { min: 4000, spread: 5000 };
  var BLINK_MS = 240;
  var MINUTE_MS = 60000;
  var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var els = {
    greeting: document.getElementById('greeting'),
    clock: document.getElementById('clock'),
    agent: document.getElementById('agent'),
    character: document.getElementById('character'),
    note: document.getElementById('note'),
    agentName: document.getElementById('agent-name'),
    apps: document.getElementById('apps'),
    status: document.getElementById('status'),
  };

  var shown = { svg: null, note: null, builderName: null, agentName: null, color: null, apps: '', clock: null, status: '' };
  var timeZone = null;

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  function firstName(name) {
    return (name || '').trim().split(/\s+/)[0] || '';
  }

  function renderClock() {
    var now = new Date();
    var text = window.octoDeskClock.clockText(now, timeZone);
    if (text === shown.clock) return;
    shown.clock = text;
    els.clock.textContent = text;
    els.clock.setAttribute('datetime', now.toISOString());
  }

  function scheduleClock() {
    renderClock();
    var now = Date.now();
    setTimeout(function () {
      renderClock();
      setInterval(renderClock, MINUTE_MS);
    }, MINUTE_MS - (now % MINUTE_MS) + 50);
  }

  function setStatus(text, isError) {
    var className = 'desk__status' + (isError ? ' desk__status--error' : '');
    setText(els.status, text || '');
    if (els.status.className !== className) els.status.className = className;
  }

  function renderApps(apps) {
    var key = JSON.stringify(apps);
    if (key === shown.apps) return;
    shown.apps = key;
    els.apps.textContent = '';
    apps.forEach(function (app) {
      var item = document.createElement('li');
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'app';
      button.title = app.comment || app.name;
      var icon = document.createElement('span');
      icon.className = 'app__icon';
      if (app.icon) {
        var img = document.createElement('img');
        img.src = app.icon;
        img.alt = '';
        img.addEventListener('error', function () { icon.textContent = ''; icon.appendChild(initial(app.name)); });
        icon.appendChild(img);
      } else {
        icon.appendChild(initial(app.name));
      }
      var name = document.createElement('span');
      name.className = 'app__name';
      name.textContent = app.name;
      button.appendChild(icon);
      button.appendChild(name);
      button.addEventListener('click', function () { launch(app, button); });
      item.appendChild(button);
      els.apps.appendChild(item);
    });
  }

  function initial(name) {
    var span = document.createElement('span');
    span.className = 'app__initial';
    span.textContent = (name || '?').charAt(0).toUpperCase();
    return span;
  }

  function launch(app, button) {
    button.disabled = true;
    setStatus('Opening ' + app.name + '…');
    fetch('/launch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: app.id }) })
      .then(function (response) {
        if (!response.ok) return response.json().then(function (body) { throw new Error(body.error || ('HTTP ' + response.status)); });
        setStatus('');
      })
      .catch(function (error) { setStatus(app.name + ' did not open: ' + error.message, true); })
      .then(function () { button.disabled = false; });
  }

  function render(state) {
    var zone = state.timeZone || null;
    if (zone !== timeZone) {
      timeZone = zone;
      renderClock();
    }
    var name = firstName(state.builderName);
    if (name !== shown.builderName) {
      shown.builderName = name;
      els.greeting.textContent = name ? 'Welcome back, ' + name : 'Welcome back';
    }
    if (state.note !== shown.note) {
      shown.note = state.note;
      els.note.textContent = state.note;
    }
    if (state.agentName !== shown.agentName) {
      shown.agentName = state.agentName;
      els.agentName.textContent = state.agentName ? '— ' + state.agentName : '';
    }
    var color = state.look && state.look.color;
    if (color !== shown.color) {
      shown.color = color;
      document.documentElement.style.setProperty('--look-color', color || '#e74e3c');
    }
    if (state.characterSvg !== shown.svg) {
      shown.svg = state.characterSvg;
      els.character.innerHTML = state.characterSvg;
    }
    renderApps(state.apps || []);
  }

  function poll() {
    fetch(STATE_URL, { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (state) { render(state); if (els.status.classList.contains('desk__status--error') && /refreshed/.test(els.status.textContent)) setStatus(''); })
      .catch(function (error) { setStatus('The desk could not be refreshed: ' + error.message, true); })
      .then(function () { setTimeout(poll, POLL_MS); });
  }

  function nextBlinkDelay() {
    return BLINK_GAP_MS.min + (Date.now() % BLINK_GAP_MS.spread);
  }

  function blink() {
    els.agent.classList.add('is-blinking');
    setTimeout(function () {
      els.agent.classList.remove('is-blinking');
      setTimeout(blink, nextBlinkDelay());
    }, BLINK_MS);
  }

  scheduleClock();
  poll();
  if (!reducedMotion) setTimeout(blink, nextBlinkDelay());
})();
