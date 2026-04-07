#!/bin/bash
# Weather for control-bound blanks (uses Open-Meteo — free, no API key)
# Usage: weather-blank.sh get <keyword> [context words...]
#        weather-blank.sh set (no-op)
#
# Accepts any city, country, or place name via geocoding API.
# Time modifiers: tomorrow, weekend, weekly/7day (detected from context)
# Default location: London

COMMAND="$1"
KEYWORD="$2"
shift 2 2>/dev/null
CONTEXT_WORDS="$*"

DEFAULT_LOCATION="London"
CACHE_DIR="/tmp/opencues-weather"
CACHE_MAX_AGE=300

# Time/trigger words to skip when scanning for location
SKIP_WORDS="weather forecast temp temperature tomorrow weekend weekly 7day 7days 7 week day days next today tonight current now"

# WMO weather code → description
wmo_desc() {
  case "$1" in
    0) echo "Clear" ;; 1) echo "Mostly clear" ;; 2) echo "Partly cloudy" ;;
    3) echo "Overcast" ;; 45|48) echo "Fog" ;; 51|53) echo "Drizzle" ;;
    55) echo "Heavy drizzle" ;; 61) echo "Light rain" ;; 63) echo "Rain" ;;
    65) echo "Heavy rain" ;; 71) echo "Light snow" ;; 73) echo "Snow" ;;
    75) echo "Heavy snow" ;; 80|81) echo "Showers" ;; 82) echo "Heavy showers" ;;
    95) echo "Thunderstorm" ;; *) echo "" ;;
  esac
}

case "$COMMAND" in
  get)
    [ -z "$KEYWORD" ] && exit 0
    KW_LOWER=$(echo "$KEYWORD" | tr '[:upper:]' '[:lower:]')
    mkdir -p "$CACHE_DIR"

    # Extract location from context — scan from END (location is usually last meaningful word)
    LOCATION=""
    WORDS_REVERSED=""
    for word in $CONTEXT_WORDS; do
      WORDS_REVERSED="$word $WORDS_REVERSED"
    done
    for word in $WORDS_REVERSED; do
      w_lower=$(echo "$word" | tr '[:upper:]' '[:lower:]')
      skip=false
      for sw in $SKIP_WORDS; do
        [ "$w_lower" = "$sw" ] && skip=true && break
      done
      if ! $skip; then
        LOCATION="$word"
        break
      fi
    done
    [ -z "$LOCATION" ] && LOCATION="$DEFAULT_LOCATION"

    # Detect time modifier from keyword + context
    MODE="current"
    for word in $KW_LOWER $CONTEXT_WORDS; do
      w_lower=$(echo "$word" | tr '[:upper:]' '[:lower:]')
      case "$w_lower" in
        tomorrow) MODE="tomorrow" ;;
        weekend|saturday|sunday) [ "$MODE" != "weekly" ] && MODE="weekend" ;;
        weekly|7day|7days|week|days|day) MODE="weekly" ;;
      esac
    done

    # Cache key
    LOC_SLUG=$(echo "$LOCATION" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')
    CACHE_FILE="${CACHE_DIR}/${LOC_SLUG}_${MODE}.txt"

    if [ -f "$CACHE_FILE" ]; then
      CACHE_AGE=$(( $(date +%s) - $(stat -c %Y "$CACHE_FILE" 2>/dev/null || echo 0) ))
      if [ "$CACHE_AGE" -lt "$CACHE_MAX_AGE" ]; then
        cat "$CACHE_FILE"
        exit 0
      fi
    fi

    # Geocode location
    GEO=$(curl -s --max-time 5 "https://geocoding-api.open-meteo.com/v1/search?name=$(echo "$LOCATION" | sed 's/ /+/g')&count=1" 2>/dev/null)
    LAT=$(echo "$GEO" | python3 -c "import json,sys;print(json.load(sys.stdin)['results'][0]['latitude'])" 2>/dev/null)
    LON=$(echo "$GEO" | python3 -c "import json,sys;print(json.load(sys.stdin)['results'][0]['longitude'])" 2>/dev/null)

    if [ -z "$LAT" ] || [ -z "$LON" ]; then
      exit 0
    fi

    case "$MODE" in
      current)
        RESULT=$(curl -s --max-time 5 "https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&current_weather=true" 2>/dev/null | python3 -c "
import json,sys
w=json.load(sys.stdin)['current_weather']
WMO={0:'Clear',1:'Mostly clear',2:'Partly cloudy',3:'Overcast',45:'Fog',48:'Fog',51:'Drizzle',53:'Drizzle',55:'Drizzle',61:'Light rain',63:'Rain',65:'Heavy rain',71:'Snow',73:'Snow',75:'Heavy snow',80:'Showers',81:'Showers',82:'Heavy showers',95:'Thunderstorm'}
print(f\"{w['temperature']}°C {WMO.get(w['weathercode'],'')}\".strip())
" 2>/dev/null)
        ;;
      tomorrow)
        RESULT=$(curl -s --max-time 5 "https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&daily=temperature_2m_max,weathercode&timezone=auto&forecast_days=2" 2>/dev/null | python3 -c "
import json,sys
WMO={0:'Clear',1:'Clear',2:'Cloudy',3:'Overcast',45:'Fog',48:'Fog',51:'Drizzle',53:'Drizzle',55:'Drizzle',61:'Rain',63:'Rain',65:'Rain',71:'Snow',73:'Snow',75:'Snow',80:'Showers',81:'Showers',82:'Showers',95:'Storm'}
d=json.load(sys.stdin)['daily']
print(f\"{int(d['temperature_2m_max'][1])}°C {WMO.get(d['weathercode'][1],'')}\".strip())
" 2>/dev/null)
        ;;
      weekend)
        RESULT=$(curl -s --max-time 5 "https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&daily=temperature_2m_max,weathercode&timezone=auto&forecast_days=7" 2>/dev/null | python3 -c "
import json,sys
from datetime import datetime
WMO={0:'Clear',1:'Clear',2:'Cloudy',3:'Overcast',45:'Fog',48:'Fog',51:'Drizzle',53:'Drizzle',55:'Drizzle',61:'Rain',63:'Rain',65:'Rain',71:'Snow',73:'Snow',75:'Snow',80:'Showers',81:'Showers',82:'Showers',95:'Storm'}
d=json.load(sys.stdin)['daily']
parts=[]
for i in range(len(d['time'])):
    dt=datetime.strptime(d['time'][i],'%Y-%m-%d')
    if dt.weekday() in (5,6):
        parts.append(f\"{dt.strftime('%a')} {int(d['temperature_2m_max'][i])}°C {WMO.get(d['weathercode'][i],'')}\".strip())
print(', '.join(parts) if parts else 'No weekend data')
" 2>/dev/null)
        ;;
      weekly)
        RESULT=$(curl -s --max-time 5 "https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&daily=temperature_2m_max,weathercode&timezone=auto&forecast_days=7" 2>/dev/null | python3 -c "
import json,sys
from datetime import datetime
WMO={0:'Clear',1:'Clear',2:'Cloudy',3:'Overcast',45:'Fog',48:'Fog',51:'Drizzle',53:'Drizzle',55:'Drizzle',61:'Rain',63:'Rain',65:'Rain',71:'Snow',73:'Snow',75:'Snow',80:'Showers',81:'Showers',82:'Showers',95:'Storm'}
d=json.load(sys.stdin)['daily']
parts=[]
for i in range(len(d['time'])):
    parts.append(f\"{datetime.strptime(d['time'][i],'%Y-%m-%d').strftime('%a')} {int(d['temperature_2m_max'][i])}°C {WMO.get(d['weathercode'][i],'')}\".strip())
print(', '.join(parts))
" 2>/dev/null)
        ;;
    esac

    if [ -n "$RESULT" ]; then
      echo "$RESULT" > "$CACHE_FILE"
      echo "$RESULT"
    fi
    ;;
  set)
    exit 0
    ;;
esac
