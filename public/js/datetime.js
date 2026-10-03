/**
 * Display times in the timezone chosen in Settings.
 * Naive timestamps (SQLite CURRENT_TIMESTAMP, "YYYY-MM-DD HH:MM:SS") are UTC.
 */
(function (root) {
  'use strict';

  function browserOffsetMinutes() {
    return -new Date().getTimezoneOffset();
  }

  function readTimezoneSetting() {
    try {
      if (root.settings && typeof root.settings.get === 'function') {
        const value = root.settings.get('timezoneOffset');
        if (value !== undefined && value !== null && value !== '') return value;
      }
    } catch (e) {
      /* settings not ready */
    }
    return 'auto';
  }

  function formatGmtLabel(totalMinutes) {
    const n = Math.round(Number(totalMinutes));
    if (!Number.isFinite(n)) return 'GMT+0';
    const sign = n < 0 ? '-' : '+';
    const abs = Math.abs(n);
    const hours = Math.floor(abs / 60);
    const mins = abs % 60;
    if (mins === 0) return `GMT${sign}${hours}`;
    return `GMT${sign}${hours}:${String(mins).padStart(2, '0')}`;
  }

  function getAppTimezoneOffsetMinutes() {
    const raw = readTimezoneSetting();
    if (raw === 'auto') return browserOffsetMinutes();
    const hours = Number(raw);
    if (!Number.isFinite(hours)) return browserOffsetMinutes();
    const clamped = Math.min(14, Math.max(-12, hours));
    return Math.round(clamped * 60);
  }

  function appTimezoneLabel() {
    return formatGmtLabel(getAppTimezoneOffsetMinutes());
  }

  /**
   * @param {string|number|Date|null|undefined} value
   * @returns {Date|null}
   */
  function parseAppDate(value) {
    if (value == null || value === '') return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === 'number') {
      const fromNumber = new Date(value);
      return Number.isNaN(fromNumber.getTime()) ? null : fromNumber;
    }

    const text = String(value).trim();
    if (!text) return null;

    if (/[zZ]$|[+-]\d{2}:\d{2}$|[+-]\d{4}$/.test(text)) {
      const zoned = new Date(text);
      return Number.isNaN(zoned.getTime()) ? null : zoned;
    }

    const naive = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/);
    if (naive) {
      const utc = new Date(`${naive[1]}T${naive[2]}Z`);
      return Number.isNaN(utc.getTime()) ? null : utc;
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      const day = new Date(`${text}T00:00:00Z`);
      return Number.isNaN(day.getTime()) ? null : day;
    }

    const fallback = new Date(text);
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }

  function zonedDate(value) {
    const date = parseAppDate(value);
    if (!date) return null;
    return new Date(date.getTime() + getAppTimezoneOffsetMinutes() * 60000);
  }

  function formatInOffset(value, method, options) {
    const shifted = zonedDate(value);
    if (!shifted) return '';
    return shifted[method](undefined, { timeZone: 'UTC', ...(options || {}) });
  }

  function formatAppTime(value, options) {
    return formatInOffset(value, 'toLocaleTimeString', options || {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function formatAppDateTime(value, options) {
    return formatInOffset(value, 'toLocaleString', options);
  }

  function formatAppDateOnly(value, options) {
    return formatInOffset(value, 'toLocaleDateString', options);
  }

  function appZonedParts(value) {
    const shifted = zonedDate(value);
    if (!shifted) return null;
    return {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
      second: shifted.getUTCSeconds(),
    };
  }

  function refreshDisplayedTimes() {
    try {
      if (root.chatInterface?.currentSession && root.chatInterface.messages?.length) {
        root.chatInterface.renderMessages(false);
      }
    } catch (e) { /* view not ready */ }

    try {
      if (root.sessionManager?.sessions?.length && root.document?.getElementById('sessions-list')) {
        root.sessionManager.renderSessionsList();
      }
    } catch (e) { /* view not ready */ }

    try {
      if (root.taskManager?.tasks?.length && root.document?.getElementById('tasks-list')) {
        root.taskManager.renderTasksList();
        if (root.taskManager.selectedTask) root.taskManager.showTaskDetails();
      }
    } catch (e) { /* view not ready */ }

    try {
      if (root.documentManager?.selectedDocument && root.document?.getElementById('document-details')) {
        root.documentManager.showDocumentDetails();
      }
    } catch (e) { /* view not ready */ }

    try {
      if (root.sessionConfig?.telegramStatus?.configured && root.document?.getElementById('telegram-content')) {
        root.sessionConfig.renderTelegramPanel();
      }
    } catch (e) { /* view not ready */ }

    try {
      if (root.sessionConfig && typeof root.sessionConfig.loadScheduledJobs === 'function') {
        ['scheduled-jobs-content', 'scheduled-jobs-main-content'].forEach((id) => {
          const el = root.document?.getElementById(id);
          if (el && el.querySelector('table')) {
            const sessionId = id === 'scheduled-jobs-content'
              ? (root.sessionConfig.currentSession?.id ?? null)
              : null;
            root.sessionConfig.loadScheduledJobs(sessionId, id);
          }
        });
      }
    } catch (e) { /* view not ready */ }
  }

  root.parseAppDate = parseAppDate;
  root.formatGmtLabel = formatGmtLabel;
  root.getAppTimezoneOffsetMinutes = getAppTimezoneOffsetMinutes;
  root.appTimezoneLabel = appTimezoneLabel;
  root.formatAppTime = formatAppTime;
  root.formatAppDateTime = formatAppDateTime;
  root.formatAppDateOnly = formatAppDateOnly;
  root.appZonedParts = appZonedParts;
  root.refreshDisplayedTimes = refreshDisplayedTimes;
})(typeof window !== 'undefined' ? window : globalThis);
