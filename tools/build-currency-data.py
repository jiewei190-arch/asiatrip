#!/usr/bin/env python3
"""Regenerates currency-data.js from the ISO country-codes dataset.

The app used to carry a hand-written map of 58 countries and 31 currencies, which quietly fell
back to USD for everywhere else — so a trip to Vietnam or Morocco showed dollars. This pulls the
official ISO 3166-1 -> ISO 4217 mapping, including each currency's minor unit, so the catalogue
is complete rather than "the countries someone thought of".

The result is BUNDLED. Exchange *rates* are fetched live (they change); the catalogue of which
country uses which currency does not, so shipping it means the app knows the right currency for
a destination even before the network answers.

    python3 tools/build-currency-data.py
"""
import csv
import io
import json
import os
import urllib.request

SOURCE = "https://cdn.jsdelivr.net/gh/datasets/country-codes@main/data/country-codes.csv"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "currency-data.js")


def main():
    with urllib.request.urlopen(SOURCE, timeout=90) as fh:
        text = fh.read().decode("utf-8")
    rows = list(csv.DictReader(io.StringIO(text)))

    country_currency = {}
    country_names = {}
    minor_units = {}

    for r in rows:
        a2 = (r.get("ISO3166-1-Alpha-2") or "").strip()
        code = (r.get("ISO4217-currency_alphabetic_code") or "").strip().split(",")[0].strip()
        name = (r.get("CLDR display name") or r.get("official_name_en") or "").strip()
        if not a2 or len(code) != 3:
            continue
        country_currency[a2] = code
        if name:
            country_names[a2] = name
        unit = (r.get("ISO4217-currency_minor_unit") or "").strip().split(",")[0].strip()
        if unit.isdigit():
            # Zero-decimal currencies (JPY, KRW, VND, CLP...) must never show "¥1,200.00".
            minor_units[code] = int(unit)

    # A currency is used by more than one country; the selector lets people search by country,
    # so keep the reverse index rather than making the UI scan the whole map on every keystroke.
    used_by = {}
    for a2, code in sorted(country_currency.items()):
        used_by.setdefault(code, []).append(country_names.get(a2, a2))

    banner = (
        "/* GENERATED FILE — do not edit by hand.\n"
        " * Rebuild with: python3 tools/build-currency-data.py\n"
        " *\n"
        " * ISO 3166-1 alpha-2 -> ISO 4217, with each currency's official minor unit.\n"
        " * Source: %s\n"
        " * %d countries, %d distinct currencies.\n"
        " */\n\n" % (SOURCE, len(country_currency), len(set(country_currency.values())))
    )

    body = (
        "const COUNTRY_CURRENCY = %s;\n\n"
        "const COUNTRY_NAMES = %s;\n\n"
        "/* Decimal places defined by ISO 4217. 0 for JPY/KRW/VND, 3 for BHD/KWD/OMR/TND. */\n"
        "const CURRENCY_MINOR_UNITS = %s;\n\n"
        "/* Which countries use each currency — powers searching the selector by country name. */\n"
        "const CURRENCY_COUNTRIES = %s;\n"
        % (
            json.dumps(country_currency, ensure_ascii=False, sort_keys=True, indent=0).replace("\n", ""),
            json.dumps(country_names, ensure_ascii=False, sort_keys=True, indent=0).replace("\n", ""),
            json.dumps(minor_units, ensure_ascii=False, sort_keys=True, indent=0).replace("\n", ""),
            json.dumps(used_by, ensure_ascii=False, sort_keys=True, indent=0).replace("\n", ""),
        )
    )

    footer = (
        "\nif(typeof module !== 'undefined' && module.exports){\n"
        "  module.exports = { COUNTRY_CURRENCY, COUNTRY_NAMES, CURRENCY_MINOR_UNITS, CURRENCY_COUNTRIES };\n"
        "}\n"
    )

    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(banner + body + footer)

    zero = sorted(c for c, u in minor_units.items() if u == 0)
    print("wrote %s" % OUT)
    print("  countries: %d" % len(country_currency))
    print("  currencies: %d" % len(set(country_currency.values())))
    print("  zero-decimal: %s" % ", ".join(zero))


if __name__ == "__main__":
    main()
