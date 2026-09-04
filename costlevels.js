/* How expensive a country is, from published World Bank data — not from a guess.
 *
 * Every destination the traveller typed used to get the same daily budget: $50 / $120 / $280,
 * whether it was Oslo or Hanoi. That is a made-up number wearing the clothes of a real one, and
 * the app is meant not to do that.
 *
 * What this is: for each country, the World Bank's PPP conversion factor for private consumption
 * (PA.NUS.PRVT.PP, local currency per international dollar) divided by its official exchange rate
 * for the same year (PA.NUS.FCRF, local currency per US dollar). The ratio is the country's
 * general price level against the United States at 1.00 — the standard way this is measured.
 * Switzerland comes out at 1.28, Japan 0.69, Brazil 0.46, Thailand 0.32, Egypt 0.16, which is
 * recognisably the world as travellers find it.
 *
 * Vintage 2021–2025, most recent non-empty value per country, fetched from
 * api.worldbank.org (keyless, CC BY 4.0). Regenerate with tools/fetch-cost-levels.js.
 *
 * 8 countries are deliberately ABSENT rather than included with a wrong number:
 * AR IR LR SS TM VE YE ZW. In each, the official exchange rate does not
 * describe what anyone actually pays — Venezuela, Zimbabwe and Argentina through redenomination
 * and parallel rates, Iran through a fixed official rate — and the ratio comes out somewhere
 * between 0.00 and 3.76. A country with no entry gets no estimate and is said to have none,
 * which is the only honest thing to do with an input this source cannot supply.
 *
 * This is still an ESTIMATE and every screen that uses it says so. It is an estimate with a
 * published, checkable basis, which is the whole difference.
 */
const COUNTRY_PRICE_LEVEL = {AD:0.72, AE:0.69, AF:0.18, AG:0.81, AL:0.51, AM:0.41, AO:0.4, AS:0.9, AT:0.85, AU:0.94, AW:0.85, AZ:0.32, BA:0.44, BB:1.32, BD:0.29, BE:0.87, BF:0.33, BG:0.24, BH:0.49, BI:0.46, BJ:0.34, BM:1.44, BN:0.4, BO:0.39, BR:0.46, BS:1.11, BT:0.24, BW:0.39, BY:0.28, BZ:0.54, CA:0.9, CD:0.34, CF:0.45, CG:0.4, CH:1.28, CI:0.39, CL:0.51, CM:0.36, CN:0.48, CO:0.41, CR:0.62, CV:0.54, CW:0.79, CY:0.67, CZ:0.67, DE:0.81, DJ:0.5, DK:1.05, DM:0.58, DO:0.38, DZ:0.32, EC:0.44, EE:0.76, EG:0.16, ER:0.34, ES:0.69, ET:0.33, FI:0.91, FJ:0.39, FM:0.93, FO:0.99, FR:0.83, GA:0.48, GB:0.92, GD:0.62, GE:0.4, GH:0.42, GL:0.83, GM:0.27, GN:0.38, GQ:0.47, GR:0.66, GT:0.45, GU:1.11, GW:0.39, GY:0.47, HK:0.74, HN:0.49, HR:0.59, HT:1.02, HU:0.58, ID:0.31, IE:1.02, IL:1.06, IN:0.23, IQ:0.42, IS:1.3, IT:0.73, JM:0.62, JO:0.45, JP:0.69, KE:0.35, KG:0.34, KH:0.37, KI:0.6, KM:0.58, KN:0.79, KR:0.62, KW:0.6, KY:1.4, KZ:0.37, LA:0.29, LB:0.65, LC:0.59, LK:0.25, LS:0.35, LT:0.62, LU:0.99, LV:0.62, LY:0.34, MA:0.42, MD:0.5, ME:0.49, MG:0.29, MH:0.95, MK:0.41, ML:0.33, MM:0.36, MN:0.33, MO:0.62, MP:0.94, MR:0.33, MT:0.69, MU:0.44, MV:0.62, MW:0.54, MX:0.59, MY:0.33, MZ:0.4, NA:0.41, NC:1.1, NE:0.34, NG:0.21, NI:0.37, NL:0.87, NO:0.96, NP:0.25, NR:0.74, NZ:0.89, OM:0.47, PA:0.5, PE:0.54, PF:0.96, PG:0.67, PH:0.36, PK:0.23, PL:0.55, PR:0.9, PT:0.65, PW:0.96, PY:0.38, QA:0.76, RO:0.49, RS:0.51, RU:0.33, RW:0.26, SA:0.5, SB:0.92, SC:0.57, SD:0.41, SE:0.91, SG:0.78, SI:0.67, SK:0.64, SL:0.33, SM:0.83, SN:0.39, SO:0.45, SR:0.42, ST:0.65, SV:0.47, SX:0.86, SY:0.2, SZ:0.35, TC:1.32, TD:0.38, TG:0.38, TH:0.32, TJ:0.32, TL:0.45, TN:0.32, TO:0.78, TR:0.45, TT:0.57, TV:0.83, TZ:0.25, UA:0.28, UG:0.37, US:1.0, UY:0.72, UZ:0.28, VC:0.62, VI:1.01, VN:0.3, VU:1.03, WS:0.67, XK:0.44, ZA:0.43, ZM:0.33};
const COUNTRY_PRICE_LEVEL_VINTAGE = '2021–2025';

/* Anchored to this app's own hand-set budgets rather than invented: dividing each of the twelve
 * curated destinations' daily figures by its country's price level gives a US-equivalent day,
 * and these are the medians of those twelve (spread 83–137, 177–305, 370–716 — the variation is
 * real city-within-country difference, Santorini against Greece, Bali against Indonesia). */
const DAILY_BUDGET_US_BASE = { budget: 99, moderate: 217, luxury: 521 };

/** The price level for a country, or null when the World Bank cannot supply a usable one. */
function countryPriceLevel(code){
  if(!code) return null;
  const v = COUNTRY_PRICE_LEVEL[String(code).trim().toUpperCase()];
  return typeof v === 'number' ? v : null;
}

/** A typical day's spend for a destination, scaled from its country's real price level.
 *  Returns null — not a number — when the country is unknown or unmeasured, so the caller can
 *  say "we do not have an estimate for this destination" instead of showing a made-up one. */
function estimatedDailyBudget(countryCode){
  const level = countryPriceLevel(countryCode);
  if(level == null) return null;
  const round5 = n => Math.max(5, Math.round(n / 5) * 5);
  return {
    budget:   round5(DAILY_BUDGET_US_BASE.budget   * level),
    moderate: round5(DAILY_BUDGET_US_BASE.moderate * level),
    luxury:   round5(DAILY_BUDGET_US_BASE.luxury   * level),
    level, estimated: true,
  };
}

if(typeof module !== 'undefined' && module.exports){
  module.exports = { COUNTRY_PRICE_LEVEL, COUNTRY_PRICE_LEVEL_VINTAGE,
                     DAILY_BUDGET_US_BASE, countryPriceLevel, estimatedDailyBudget };
}
