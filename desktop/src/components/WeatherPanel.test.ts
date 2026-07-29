import { describe, expect, it } from "vitest";
import type { WeatherSnapshot } from "../types";
import { precipitationKind, weatherCondition } from "./WeatherPanel";

function snapshot(currentCode: number, dailyCode = currentCode): WeatherSnapshot {
  return {
    updatedAt: 1,
    current: {
      temperatureC: 1,
      apparentC: 0,
      humidityPercent: 80,
      windKmh: 5,
      precipitationMm: 0,
      precipitationProbabilityPercent: 40,
      rainMm: 0,
      snowfallCm: 0,
      weatherCode: currentCode,
      isDay: true,
      cloudPercent: 20,
    },
    air: { pm25: null, pm10: null, carbonDioxide: null, ozone: null, dust: null, aerosolOpticalDepth: null },
    daily: {
      sunrise: null,
      sunset: null,
      temperatureMaxC: null,
      temperatureMinC: null,
      precipitationSumMm: null,
      precipitationProbabilityMaxPercent: 70,
      snowfallSumCm: 0,
      weatherCode: dailyCode,
      precipitationHours: null,
      shortwaveRadiationSum: null,
    },
  };
}

describe("weather condition", () => {
  it("selects snow and rain icons from WMO codes", () => {
    expect(weatherCondition(snapshot(71))).toBe("snow");
    expect(weatherCondition(snapshot(61))).toBe("rain");
  });

  it("keeps current conditions separate from today's precipitation type", () => {
    const weather = snapshot(0);
    weather.daily.snowfallSumCm = 1.2;
    expect(weatherCondition(weather)).toBe("clear");
    expect(precipitationKind(weather)).toBe("snow");
  });
});
