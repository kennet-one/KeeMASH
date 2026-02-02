import json
from PyQt5.QtCore import QUrl, QUrlQuery
from PyQt5.QtNetwork import QNetworkRequest


def _safe_list_get(a, i):
	if isinstance(a, list) and 0 <= i < len(a):
		return a[i]
	return None


def weather_tick(net, lat, lon, ui, timezone="auto"):
	url = QUrl("https://api.open-meteo.com/v1/forecast")
	q = QUrlQuery()
	q.addQueryItem("latitude", str(lat))
	q.addQueryItem("longitude", str(lon))
	q.addQueryItem("timezone", timezone)

	# current_weather дає температуру/вітер/код погоди
	q.addQueryItem("current_weather", "true")

	# hourly — для ймовірності опадів і розділення rain/snowfall + пориви
	q.addQueryItem("hourly", "precipitation_probability,rain,snowfall,wind_speed_10m,wind_gusts_10m")

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

		# === тут ти виводиш у свої віджети (під свої назви) ===
		ui.outsideTempL.setText(f"{out_temp:.1f} °C" if out_temp is not None else "--")
		ui.precipProbL.setText(f"{int(pop)} %" if pop is not None else "--")

		if wind is not None and gust is not None:
			ui.windL.setText(f"{wind:.1f} m/s, gust {gust:.1f}")
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

	except Exception as e:
		print("weather parse error:", e)
	finally:
		reply.deleteLater()
