// Inhalt: Strava-Datentypen (reine Typen, kein Laufzeitcode).
// Zweck: gemeinsame Shapes aller strava/*-Module und der Konsumenten.
// Einstieg: StravaActivity (API-Rohform), RunSummary/ActivitySummary (geparst),
//   StravaTokens (OAuth), ActivityStreams (Zeitreihen).
// Regeln: importiert nichts; oeffentlich nur ueber den Index src/lib/strava.ts (T-275).

export interface StravaTokens {
  access_token:  string
  refresh_token: string
  expires_at:    number
  athlete?: { firstname: string; lastname: string; id: number }
}
export interface StravaActivity {
  id:                number
  name:              string
  type:              string
  sport_type:        string
  start_date:        string
  start_date_local:  string
  distance:          number
  moving_time:       number
  total_elevation_gain: number
  average_heartrate?: number
  max_heartrate?:    number
  average_speed:     number
  suffer_score?:     number
  workout_type?:     number
  average_temp?:     number   // °C, only present if device recorded temperature
  // Power fields (T-125) — present on Rides with a power meter
  weighted_average_watts?: number   // Normalized Power (NP) from Strava
  average_watts?:          number   // Average Power (fallback when NP not available)
  device_watts?:           boolean  // true = power from hardware meter, not estimated
}

export interface RunSummary {
  id:          number
  name:        string
  date:        Date
  distanceKm:  number
  durationSec: number
  paceSec:     number
  paceFmt:     string
  avgHr?:      number
  maxHr?:      number
  elevationM:  number
  tempC?:      number
}

export interface ActivitySummary extends RunSummary {
  actType:      'run' | 'ride' | 'hike'
  isTrail:      boolean
  workoutType?: number
  speedKmh?:    number
}

export interface ActivityStreams {
  time:             number[]   // elapsed seconds
  velocity_smooth:  number[]   // m/s
  heartrate?:       number[]   // bpm
  altitude?:        number[]   // meters
  distance?:        number[]   // cumulative meters
}
