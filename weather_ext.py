import json
from PyQt5.QtCore import QUrl, QUrlQuery
from PyQt5.QtNetwork import QNetworkRequest


def _safe_list_get(a, i):
	if isinstance(a, list) and 0 <= i < len(a):
		return a[i]
	return None

def air_tick(net, lat, lon, ui, timezone="auto"):
	url = QUrl("https://air-quality-api.open-meteo.com/v1/air-quality")
	q = QUrlQuery()
	q.addQueryItem("latitude", str(lat))
	q.addQueryItem("longitude", str(lon))
	q.addQueryItem("timezone", timezone)

	# Беремо "поточні" значення PM
	q.addQueryItem("current", "pm2_5,pm10,carbon_dioxide,aerosol_optical_depth,dust,ozone")

	url.setQuery(q)

	reply = net.get(QNetworkRequest(url))
	reply.finished.connect(lambda r=reply: handle_air_reply(r, ui))


def handle_air_reply(reply, ui):
	try:
		if reply.error():
			print("air error:", reply.errorString())
			return

		raw = bytes(reply.readAll()).decode("utf-8", "ignore")
		data = json.loads(raw)

		cur = data.get("current", {})
		pm25 = cur.get("pm2_5")
		pm10 = cur.get("pm10")
		co2 = cur.get("carbon_dioxide")
		aod = cur.get("aerosol_optical_depth")
		dust = cur.get("dust")
		oz = cur.get("ozone")

		if hasattr(ui, "outPm25L"):
			ui.outPm25L.setText(f"PM2.5 {pm25:.0f} µg/m³" if pm25 is not None else "--")

		if hasattr(ui, "outPm10L"):
			ui.outPm10L.setText(f"PM10 {pm10:.0f} µg/m³" if pm10 is not None else "--")

		ui.outCO2L.setText(f"CO₂ {co2:.0f} ppm" if co2 is not None else "--")
		ui.aodL.setText(f"AOD {aod:.2f}" if aod is not None else "--")
		ui.dustL.setText(f"Dust {dust:.1f} µg/m³" if dust is not None else "--")
		ui.ozoneL.setText(f"O₃ {oz:.0f} µg/m³" if oz is not None else "--")

	except Exception as e:
		print("air parse error:", e)
	finally:
		reply.deleteLater()

def weather_tick(net, lat, lon, ui, timezone="auto"):
	url = QUrl("https://api.open-meteo.com/v1/forecast")
	q = QUrlQuery()
	q.addQueryItem("latitude", str(lat))
	q.addQueryItem("longitude", str(lon))
	q.addQueryItem("timezone", timezone)

	# current_weather дає температуру/вітер/код погоди
	q.addQueryItem("current_weather", "true")

	# hourly — для ймовірності опадів і розділення rain/snowfall + пориви
	q.addQueryItem("hourly", "precipitation_probability,rain,snowfall,wind_speed_10m,wind_gusts_10m,relative_humidity_2m,apparent_temperature,cloud_cover,uv_index,shortwave_radiation,dew_point_2m")

	# метри на секунду
	q.addQueryItem("wind_speed_unit", "ms")

	url.setQuery(q)

	reply = net.get(QNetworkRequest(url))
	reply.finished.connect(lambda r=reply: handle_weather_reply(r, ui))


def handle_weather_reply(reply, ui):
	try:
		if reply.error():
			print("weather error:", reply.errorString())
			return

		raw = bytes(reply.readAll()).decode("utf-8", "ignore")
		data = json.loads(raw)

		cur = data.get("current_weather", {})
		hourly = data.get("hourly", {})

		# знайдемо індекс поточної години в hourly по часу
		cur_time = cur.get("time")
		times = hourly.get("time", [])

		i = 0
		if cur_time and isinstance(times, list) and cur_time in times:
			i = times.index(cur_time)

		out_temp = cur.get("temperature")
		wind = cur.get("windspeed")

		gust = _safe_list_get(hourly.get("wind_gusts_10m", []), i)
		pop = _safe_list_get(hourly.get("precipitation_probability", []), i)
		rain = _safe_list_get(hourly.get("rain", []), i)
		snow = _safe_list_get(hourly.get("snowfall", []), i)
		hum = _safe_list_get(hourly.get("relative_humidity_2m"), i)
		app_t = _safe_list_get(hourly.get("apparent_temperature"), i)
		cloud = _safe_list_get(hourly.get("cloud_cover"), i)
		uvi = _safe_list_get(hourly.get("uv_index"), i)
		swr = _safe_list_get(hourly.get("shortwave_radiation"), i)
		dew = _safe_list_get(hourly.get("dew_point_2m"), i)

		# === тут ти виводиш у свої віджети (під свої назви) ===
		ui.outsideTempL.setText(f"{out_temp:.1f} °C" if out_temp is not None else "--")
		ui.precipProbL.setText(f"{int(pop)} %" if pop is not None else "--")

		if wind is not None and gust is not None:
			ui.windL.setText(f"wind {wind:.1f} m/s, gust {gust:.1f} m/s")
		elif wind is not None:
			ui.windL.setText(f"{wind:.1f} m/s")
		else:
			ui.windL.setText("--")

		if rain is not None or snow is not None:
			r_txt = rain if rain is not None else "--"
			s_txt = snow if snow is not None else "--"
			ui.snowL.setText(f"rain {r_txt} mm | snow {s_txt} cm")
		else:
			ui.snowL.setText("--")

		ui.outHumL.setText(f"{int(hum)} %" if hum is not None else "--")
		ui.apparentTempL.setText(f"{app_t:.1f} °C" if app_t is not None else "--")
		ui.cloudCoverL.setText(f"cloud {int(cloud)} %" if cloud is not None else "--")
		ui.uvL.setText(f"UV {uvi:.1f}" if uvi is not None else "--")
		ui.swrL.setText(f"Sun {swr:.0f} W/m²" if swr is not None else "--")
		ui.dewL.setText(f"dewP {dew:.1f} °C" if dew is not None else "--")



	except Exception as e:
		print("weather parse error:", e)
	finally:
		reply.deleteLater()
