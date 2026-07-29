use crate::models::{WeatherAir, WeatherCurrent, WeatherDaily, WeatherSnapshot};
use serde_json::Value;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const LATITUDE: &str = "51.4408";
const LONGITUDE: &str = "19.2658";

pub async fn fetch_weather() -> Result<WeatherSnapshot, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("KeeMASH/0.1")
        .build()
        .map_err(|error| format!("Unable to initialize weather client: {error}"))?;
    let forecast = fetch_json(&client, "https://api.open-meteo.com/v1/forecast", &[
        ("latitude", LATITUDE),
        ("longitude", LONGITUDE),
        ("timezone", "auto"),
        ("current", "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,precipitation_probability,rain,snowfall,weather_code,is_day,cloud_cover,wind_speed_10m"),
        ("daily", "sunrise,sunset,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,snowfall_sum,weather_code,precipitation_hours,shortwave_radiation_sum"),
        ("forecast_days", "1"),
    ]).await?;
    let air_quality = fetch_json(
        &client,
        "https://air-quality-api.open-meteo.com/v1/air-quality",
        &[
            ("latitude", LATITUDE),
            ("longitude", LONGITUDE),
            ("timezone", "auto"),
            (
                "current",
                "pm2_5,pm10,carbon_dioxide,aerosol_optical_depth,dust,ozone",
            ),
        ],
    )
    .await?;

    Ok(snapshot_from_values(&forecast, &air_quality))
}

async fn fetch_json(
    client: &reqwest::Client,
    url: &str,
    query: &[(&str, &str)],
) -> Result<Value, String> {
    let response = client
        .get(url)
        .query(query)
        .send()
        .await
        .map_err(|error| format!("Weather request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Weather service returned HTTP {status}"));
    }
    response
        .json::<Value>()
        .await
        .map_err(|error| format!("Invalid weather response: {error}"))
}

fn snapshot_from_values(forecast: &Value, air_quality: &Value) -> WeatherSnapshot {
    WeatherSnapshot {
        updated_at: now_millis(),
        current: WeatherCurrent {
            temperature_c: number(forecast, "/current/temperature_2m"),
            apparent_c: number(forecast, "/current/apparent_temperature"),
            humidity_percent: number(forecast, "/current/relative_humidity_2m"),
            wind_kmh: number(forecast, "/current/wind_speed_10m"),
            precipitation_mm: number(forecast, "/current/precipitation"),
            precipitation_probability_percent: number(
                forecast,
                "/current/precipitation_probability",
            ),
            rain_mm: number(forecast, "/current/rain"),
            snowfall_cm: number(forecast, "/current/snowfall"),
            weather_code: integer(forecast, "/current/weather_code"),
            is_day: boolean_number(forecast, "/current/is_day"),
            cloud_percent: number(forecast, "/current/cloud_cover"),
        },
        air: WeatherAir {
            pm25: number(air_quality, "/current/pm2_5"),
            pm10: number(air_quality, "/current/pm10"),
            carbon_dioxide: number(air_quality, "/current/carbon_dioxide"),
            ozone: number(air_quality, "/current/ozone"),
            dust: number(air_quality, "/current/dust"),
            aerosol_optical_depth: number(air_quality, "/current/aerosol_optical_depth"),
        },
        daily: WeatherDaily {
            sunrise: first_string(forecast, "/daily/sunrise"),
            sunset: first_string(forecast, "/daily/sunset"),
            temperature_max_c: first_number(forecast, "/daily/temperature_2m_max"),
            temperature_min_c: first_number(forecast, "/daily/temperature_2m_min"),
            precipitation_sum_mm: first_number(forecast, "/daily/precipitation_sum"),
            precipitation_probability_max_percent: first_number(
                forecast,
                "/daily/precipitation_probability_max",
            ),
            snowfall_sum_cm: first_number(forecast, "/daily/snowfall_sum"),
            weather_code: first_integer(forecast, "/daily/weather_code"),
            precipitation_hours: first_number(forecast, "/daily/precipitation_hours"),
            shortwave_radiation_sum: first_number(forecast, "/daily/shortwave_radiation_sum"),
        },
    }
}

fn number(value: &Value, pointer: &str) -> Option<f64> {
    value
        .pointer(pointer)?
        .as_f64()
        .filter(|number| number.is_finite())
}

fn integer(value: &Value, pointer: &str) -> Option<i64> {
    value.pointer(pointer)?.as_i64()
}

fn boolean_number(value: &Value, pointer: &str) -> Option<bool> {
    integer(value, pointer).and_then(|value| match value {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    })
}

fn first_number(value: &Value, pointer: &str) -> Option<f64> {
    value
        .pointer(pointer)?
        .as_array()?
        .first()?
        .as_f64()
        .filter(|number| number.is_finite())
}

fn first_integer(value: &Value, pointer: &str) -> Option<i64> {
    value.pointer(pointer)?.as_array()?.first()?.as_i64()
}

fn first_string(value: &Value, pointer: &str) -> Option<String> {
    value
        .pointer(pointer)?
        .as_array()?
        .first()?
        .as_str()
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_weather_payload() {
        let forecast = serde_json::json!({
            "current": {
                "temperature_2m": 21.5,
                "relative_humidity_2m": 55,
                "precipitation_probability": 35,
                "weather_code": 61,
                "is_day": 1
            },
            "daily": {
                "sunrise": ["2026-07-16T04:42"],
                "temperature_2m_max": [25.0],
                "precipitation_probability_max": [72],
                "snowfall_sum": [0.4],
                "weather_code": [71]
            }
        });
        let air = serde_json::json!({ "current": { "pm2_5": 7.5 } });
        let snapshot = snapshot_from_values(&forecast, &air);
        assert_eq!(snapshot.current.temperature_c, Some(21.5));
        assert_eq!(snapshot.air.pm25, Some(7.5));
        assert_eq!(snapshot.daily.temperature_max_c, Some(25.0));
        assert_eq!(
            snapshot.current.precipitation_probability_percent,
            Some(35.0)
        );
        assert_eq!(snapshot.current.weather_code, Some(61));
        assert_eq!(snapshot.current.is_day, Some(true));
        assert_eq!(
            snapshot.daily.precipitation_probability_max_percent,
            Some(72.0)
        );
        assert_eq!(snapshot.daily.weather_code, Some(71));
    }
}
