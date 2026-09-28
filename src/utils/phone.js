'use strict';

const countries = require('../../shared/countries.json');

const BY_ISO = new Map(countries.map((c) => [c.iso, c]));
const BY_DIAL = new Map();

for (const country of countries) {
  if (!BY_DIAL.has(country.dial)) BY_DIAL.set(country.dial, []);
  BY_DIAL.get(country.dial).push(country);
}

// Dial codes sorted longest-first so "+1..." never shadows "+1 690 ..." style overlaps.
const DIAL_CODES_BY_LENGTH = [...BY_DIAL.keys()].sort((a, b) => b.length - a.length);

// A few calling codes are shared by several territories. When the user just
// types "+47…" we have to guess, so pin the main country for each of them.
const PRIMARY_BY_DIAL = {
  '1': 'US',
  '7': 'RU',
  '44': 'GB',
  '47': 'NO',
  '64': 'NZ',
  '212': 'MA',
  '262': 'RE',
  '500': 'FK',
  '590': 'GP',
};

// North American Numbering Plan: every NANP country shares +1, so the area code
// is the only thing that identifies it. Anything unknown falls back to the US.
const NANP_BY_AREA = {
  // Canada
  '204': 'CA', '226': 'CA', '236': 'CA', '249': 'CA', '250': 'CA', '263': 'CA',
  '289': 'CA', '306': 'CA', '343': 'CA', '354': 'CA', '365': 'CA', '367': 'CA',
  '368': 'CA', '382': 'CA', '387': 'CA', '403': 'CA', '416': 'CA', '418': 'CA',
  '428': 'CA', '431': 'CA', '437': 'CA', '438': 'CA', '450': 'CA', '468': 'CA',
  '474': 'CA', '506': 'CA', '514': 'CA', '519': 'CA', '548': 'CA', '579': 'CA',
  '581': 'CA', '584': 'CA', '587': 'CA', '604': 'CA', '613': 'CA', '639': 'CA',
  '647': 'CA', '683': 'CA', '705': 'CA', '709': 'CA', '742': 'CA', '753': 'CA',
  '778': 'CA', '780': 'CA', '782': 'CA', '807': 'CA', '819': 'CA', '825': 'CA',
  '867': 'CA', '873': 'CA', '879': 'CA', '902': 'CA', '905': 'CA',
  // Caribbean + US territories
  '242': 'BS', '246': 'BB', '264': 'AI', '268': 'AG', '284': 'VG', '340': 'VI',
  '345': 'KY', '441': 'BM', '473': 'GD', '649': 'TC', '658': 'JM', '664': 'MS',
  '670': 'MP', '671': 'GU', '684': 'AS', '721': 'SX', '758': 'LC', '767': 'DM',
  '784': 'VC', '787': 'PR', '809': 'DO', '829': 'DO', '849': 'DO', '868': 'TT',
  '869': 'KN', '876': 'JM', '939': 'PR',
};

class PhoneError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PhoneError';
    this.code = code;
  }
}

function listCountries() {
  return countries;
}

function getCountryByIso(iso) {
  return BY_ISO.get(String(iso || '').toUpperCase()) || null;
}

const ALLOWED_INPUT = /^[\d\s+()\-.]*$/;

function toRawDigits(value) {
  const raw = String(value ?? '');
  if (!ALLOWED_INPUT.test(raw)) {
    throw new PhoneError('phone_invalid', 'Phone number may only contain digits, spaces and the symbols + - ( ) .');
  }

  let cleaned = raw.replace(/\s+/g, '');
  if (!cleaned) return { hasPlus: false, digits: '' };

  let hasPlus = false;
  if (cleaned.startsWith('00')) {
    hasPlus = true;
    cleaned = cleaned.slice(2);
  } else if (cleaned.startsWith('+')) {
    hasPlus = true;
    cleaned = cleaned.slice(1);
  }

  // Drop the remaining separators: ( ) - . are only formatting.
  return { hasPlus, digits: cleaned.replace(/\D/g, '') };
}

/** Longest dial code that the given digits start with, or null. */
function matchDialCode(digits) {
  for (const dial of DIAL_CODES_BY_LENGTH) {
    if (digits.startsWith(dial)) return dial;
  }
  return null;
}

function resolveNanpCountry(nsn) {
  return BY_ISO.get(NANP_BY_AREA[nsn.slice(0, 3)] || 'US') || null;
}

function defaultCountryForDial(dial) {
  const primary = PRIMARY_BY_DIAL[dial];
  if (primary && BY_ISO.has(primary)) return BY_ISO.get(primary);
  return (BY_DIAL.get(dial) || [])[0] || null;
}

function isValidNsn(country, nsn) {
  if (!country || !/^\d+$/.test(nsn)) return false;
  if (nsn.startsWith('0')) return false; // E.164 national numbers never start with 0
  const [min, max] = country.nslen;
  return nsn.length >= min && nsn.length <= max;
}

/** Candidate national numbers, ordered from most to least likely. */
function nsnCandidates(nsn, country) {
  const candidates = [nsn];
  const trunk = country.trunk || '';

  if (trunk && nsn.startsWith(trunk)) {
    candidates.push(nsn.slice(trunk.length));
  }
  // Some countries accept the bare leading zero as a trunk prefix.
  if (nsn.startsWith('0')) {
    candidates.push(nsn.replace(/^0+/, ''));
  }
  return [...new Set(candidates)];
}

function buildResult(country, nsn) {
  return {
    iso: country.iso,
    name: country.name,
    dialCode: country.dial,
    e164: `+${country.dial}${nsn}`,
    digits: `${country.dial}${nsn}`,
    national: nsn,
  };
}

/**
 * Turn whatever the user typed into a strict E.164 number.
 * Accepts "+8801712…", "00880…", "8801712…", or a bare national number when
 * `iso` (from the country <select>) is supplied.
 */
function normalizePhone(input, { iso } = {}) {
  const { hasPlus, digits } = toRawDigits(input);

  if (!digits) {
    throw new PhoneError('phone_empty', 'Please enter your phone number.');
  }

  const explicitCountry = iso ? getCountryByIso(iso) : null;
  if (iso && !explicitCountry) {
    throw new PhoneError('country_unknown', 'Please pick a country from the list.');
  }

  const matchFor = (country, rest) => {
    if (!country) return null;
    for (const candidate of nsnCandidates(rest, country)) {
      if (isValidNsn(country, candidate)) return buildResult(country, candidate);
    }
    return null;
  };

  // 1. The user wrote a full international number ("+880…", "00880…").
  if (hasPlus) {
    const dial = matchDialCode(digits);
    if (!dial) {
      throw new PhoneError('dial_unknown', 'That country calling code is not supported yet.');
    }
    const rest = digits.slice(dial.length);

    const candidates = [];
    if (dial === '1') candidates.push(resolveNanpCountry(rest));
    if (explicitCountry && explicitCountry.dial === dial) candidates.push(explicitCountry);
    candidates.push(defaultCountryForDial(dial));

    for (const country of candidates) {
      const matched = matchFor(country, rest);
      if (matched) return matched;
    }
    throw new PhoneError(
      'nsn_invalid',
      `That does not look like a valid ${candidates[0]?.name || 'phone'} number.`,
    );
  }

  // 2. No "+", but a country is selected and the digits already start with its
  //    calling code ("8801712…" while Bangladesh is selected).
  if (explicitCountry && digits.startsWith(explicitCountry.dial)) {
    const rest = digits.slice(explicitCountry.dial.length);
    const matched = matchFor(explicitCountry, rest);
    if (matched) return matched;
  }

  // 3. A country is selected: the digits are a national number.
  if (explicitCountry) {
    const matched = matchFor(explicitCountry, digits);
    if (matched) return matched;
    throw new PhoneError(
      'nsn_invalid',
      `That does not look like a valid ${explicitCountry.name} number (expected ${
        explicitCountry.nslen[0]
      }–${explicitCountry.nslen[1]} digits).`,
    );
  }

  // 4. Bare digits with no country hint at all: only accept an unambiguous match.
  const dial = matchDialCode(digits);
  if (dial) {
    const rest = digits.slice(dial.length);
    const matches = (BY_DIAL.get(dial) || []).filter((c) => matchFor(c, rest) !== null);
    if (matches.length === 1) return matchFor(matches[0], rest);
  }

  throw new PhoneError('country_required', 'Please include your country code (for example +880) or pick a country.');
}

/** The country a "+…" string most likely belongs to, used for live UI hints. */
function detectCountry(input) {
  let parsed;
  try {
    parsed = toRawDigits(input);
  } catch {
    return null;
  }
  if (!parsed.hasPlus || parsed.digits.length < 2) return null;
  const dial = matchDialCode(parsed.digits);
  if (!dial) return null;
  const rest = parsed.digits.slice(dial.length);
  return dial === '1' ? resolveNanpCountry(rest) : defaultCountryForDial(dial);
}

function flagFromIso(iso) {
  if (!/^[A-Za-z]{2}$/.test(iso || '')) return '';
  return String.fromCodePoint(...[...iso.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)));
}

module.exports = {
  PhoneError,
  listCountries,
  getCountryByIso,
  normalizePhone,
  detectCountry,
  isValidNsn,
  flagFromIso,
};
