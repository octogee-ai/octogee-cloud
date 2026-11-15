(function (root) {
  'use strict';

  function clockText(date, timeZone) {
    var options = { hour: 'numeric', minute: '2-digit' };
    if (timeZone) {
      try {
        return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: timeZone });
      } catch (_error) {
        if (root.console && typeof root.console.warn === 'function') {
          root.console.warn('desk: unknown time zone ' + timeZone + '; showing the browser zone');
        }
      }
    }
    return date.toLocaleTimeString([], options);
  }

  root.octoDeskClock = { clockText: clockText };
})(typeof window !== 'undefined' ? window : globalThis);
