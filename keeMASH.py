from PyQt5 import QtCore, QtGui, QtWidgets, uic
from PyQt5.QtNetwork import QNetworkAccessManager
from PyQt5.QtCore import QTime, QIODevice, QTimer
from PyQt5.QtSerialPort import QSerialPort, QSerialPortInfo
from PyQt5.QtWidgets import QMessageBox

from weather_ext import weather_tick, air_tick

auto_timer = QTimer()

heatBox_timer = QTimer()
heatBox_timer.setSingleShot(True)  # Таймер спрацьовує один раз

app = QtWidgets.QApplication([])
ui = uic.loadUi("keeMASH.ui")
ui.setWindowTitle("keeMASH")


CURRENT_THEME = "dark"

BUTTON_COLORS = {
    "dark": {
        "grey": ("#777d86", "#a5acb6", "#3f444c", "#252932", "#ffffff"),
        "green": ("#22a447", "#35cf61", "#0e642b", "#073816", "#ffffff"),
        "black": ("#24272d", "#454b55", "#07080a", "#020203", "#ffffff"),
        "yellow": ("#f1c232", "#ffe27a", "#a47510", "#6c4a05", "#111111"),
    },
    "light": {
        "grey": ("#d9e0ea", "#ffffff", "#8b96a7", "#9da8b8", "#17202b"),
        "green": ("#21a957", "#6ee892", "#11813c", "#0d6d32", "#ffffff"),
        "black": ("#4a5260", "#6c7585", "#252c36", "#1a2029", "#ffffff"),
        "yellow": ("#ffd45a", "#fff1a5", "#c58b16", "#a06f0d", "#1d1605"),
    },
}

CONTROL_COLORS = {
    "dark": {
        "grey": ("#303744", "#9da8b8", "#1a1f28", "#5f6978"),
        "green": ("#103a22", "#9dffc2", "#082012", "#1bb34d"),
        "black": ("#11151c", "#e7edf6", "#05070a", "#323a48"),
    },
    "light": {
        "grey": ("#edf1f6", "#202936", "#ffffff", "#aab4c2"),
        "green": ("#dff8e7", "#0b5025", "#f5fff8", "#45b86a"),
        "black": ("#d9dee7", "#18202c", "#f5f7fa", "#8f9aaa"),
    },
}

APP_COLORS = {
    "dark": {
        "window": "#11151c",
        "text": "#dbe4ef",
        "label": "#c6d0df",
        "check_border": "#5f6978",
        "check_bg": "#1a1f28",
        "dropdown": "#242b36",
        "popup": "#161b24",
        "selection": "#22a447",
        "lcd_gradient": "stop:0 #101820, stop:0.48 #06100b, stop:1 #020604",
        "lcd_text": "#7dff9f",
        "lcd_hover": "#b8ffca",
        "lcd_border": "#1f6f42",
        "lcd_top": "#5ee78e",
        "lcd_left": "#326d49",
        "lcd_right": "#052411",
        "lcd_bottom": "#031408",
        "disabled_bg": "#666b73",
        "disabled_text": "#cfd5de",
        "focus": "#35cf61",
        "hover_border": "#7f8da3",
        "panel_bg": "#171d27",
        "panel_border": "#344052",
    },
    "light": {
        "window": "#f4f7fb",
        "text": "#182231",
        "label": "#303b4d",
        "check_border": "#9aa7b8",
        "check_bg": "#ffffff",
        "dropdown": "#dde4ee",
        "popup": "#ffffff",
        "selection": "#21a957",
        "lcd_gradient": "stop:0 #f7fff9, stop:0.48 #e7f6ec, stop:1 #d5eadc",
        "lcd_text": "#155c2c",
        "lcd_hover": "#0f7d37",
        "lcd_border": "#8ccfa1",
        "lcd_top": "#ffffff",
        "lcd_left": "#bde9cb",
        "lcd_right": "#6daf82",
        "lcd_bottom": "#4d8f63",
        "disabled_bg": "#c7cfda",
        "disabled_text": "#6c7480",
        "focus": "#21a957",
        "hover_border": "#778499",
        "panel_bg": "#f8fafc",
        "panel_border": "#c7d1df",
    },
}


def _theme_colors():
    return APP_COLORS[CURRENT_THEME]


def button_style(color="grey", text_color=None):
    palette = BUTTON_COLORS[CURRENT_THEME]
    base, light, dark, outline, default_text = palette.get(color, palette["grey"])
    text = text_color or default_text
    c = _theme_colors()
    return f"""
    QPushButton {{
        background-color: {base};
        color: {text};
        border: 1px solid {outline};
        border-top-color: {light};
        border-left-color: {light};
        border-right-color: {dark};
        border-bottom-color: {dark};
        border-radius: 6px;
        padding: 4px 7px 6px 7px;
        font-size: 8pt;
        font-weight: 600;
    }}
    QPushButton:hover {{
        background-color: {light};
    }}
    QPushButton:pressed {{
        padding-top: 6px;
        padding-bottom: 4px;
        border-top-color: {dark};
        border-left-color: {dark};
        border-right-color: {light};
        border-bottom-color: {light};
    }}
    QPushButton:disabled {{
        background-color: {c["disabled_bg"]};
        color: {c["disabled_text"]};
    }}
    """


def set_button_state(button, color, text_color=None):
    button.setProperty("km_button_color", color)
    button.setProperty("km_button_text_color", text_color or "")
    button.setStyleSheet(button_style(color, text_color))


def control_style(color="grey", text_color=None):
    palette = CONTROL_COLORS[CURRENT_THEME]
    base, text, focus_bg, border = palette.get(color, palette["grey"])
    c = _theme_colors()
    return f"""
    QComboBox, QSpinBox, QDoubleSpinBox, QLineEdit {{
        background-color: {base};
        color: {text_color or text};
        border: 1px solid {border};
        border-radius: 5px;
        padding: 3px 5px;
        selection-background-color: {c["selection"]};
        selection-color: #ffffff;
    }}
    QComboBox:hover, QSpinBox:hover, QDoubleSpinBox:hover, QLineEdit:hover {{
        border-color: {c["hover_border"]};
    }}
    QComboBox:focus, QSpinBox:focus, QDoubleSpinBox:focus, QLineEdit:focus {{
        border-color: {c["focus"]};
        background-color: {focus_bg};
    }}
    QComboBox::drop-down {{
        width: 22px;
        border-left: 1px solid {border};
        background-color: {c["dropdown"]};
    }}
    QComboBox QAbstractItemView {{
        background-color: {c["popup"]};
        color: {c["text"]};
        border: 1px solid {border};
        selection-background-color: {c["selection"]};
    }}
    """


def set_control_state(control, color, text_color=None):
    control.setProperty("km_control_color", color)
    control.setProperty("km_control_text_color", text_color or "")
    control.setStyleSheet(control_style(color, text_color))


def app_style():
    c = _theme_colors()
    return f"""
    QMainWindow, QWidget {{
        background-color: {c["window"]};
        color: {c["text"]};
        font-family: Segoe UI, Arial, sans-serif;
        font-size: 9pt;
    }}
    QLabel {{
        color: {c["label"]};
        background-color: transparent;
    }}
    QFrame#weatherPanel, QFrame#dailyWeatherPanel {{
        background-color: {c["panel_bg"]};
        border: 1px solid {c["panel_border"]};
        border-radius: 7px;
    }}
    QFrame#weatherPanel QLabel, QFrame#dailyWeatherPanel QLabel {{
        background-color: transparent;
        border: none;
        color: {c["label"]};
        font-size: 8pt;
    }}
    QCheckBox {{
        color: {c["text"]};
        spacing: 7px;
        background-color: transparent;
    }}
    QCheckBox::indicator {{
        width: 15px;
        height: 15px;
        border-radius: 4px;
        border: 1px solid {c["check_border"]};
        background-color: {c["check_bg"]};
    }}
    QCheckBox::indicator:checked {{
        background-color: {c["selection"]};
        border-color: {c["focus"]};
    }}
    QLCDNumber {{
        background-color: qlineargradient(x1:0, y1:0, x2:0, y2:1,
            {c["lcd_gradient"]});
        color: {c["lcd_text"]};
        border: 1px solid {c["lcd_border"]};
        border-top-color: {c["lcd_top"]};
        border-left-color: {c["lcd_left"]};
        border-right-color: {c["lcd_right"]};
        border-bottom-color: {c["lcd_bottom"]};
        border-radius: 8px;
        padding: 5px;
    }}
    QLCDNumber:hover {{
        border-color: {c["lcd_hover"]};
        color: {c["lcd_hover"]};
    }}
    {control_style("grey")}
    {button_style("grey")}
    """


def setup_lcd_blocks():
    for lcd in ui.findChildren(QtWidgets.QLCDNumber):
        lcd.setSegmentStyle(QtWidgets.QLCDNumber.Flat)
        lcd.setFrameShape(QtWidgets.QFrame.NoFrame)


def refresh_dynamic_styles():
    for button in ui.findChildren(QtWidgets.QPushButton):
        color = button.property("km_button_color")
        if color:
            text_color = button.property("km_button_text_color") or None
            button.setStyleSheet(button_style(color, text_color))

    control_types = (
        QtWidgets.QComboBox,
        QtWidgets.QSpinBox,
        QtWidgets.QDoubleSpinBox,
        QtWidgets.QLineEdit,
    )
    for control_type in control_types:
        for control in ui.findChildren(control_type):
            color = control.property("km_control_color")
            if color:
                text_color = control.property("km_control_text_color") or None
                control.setStyleSheet(control_style(color, text_color))


def apply_theme(theme):
    global CURRENT_THEME
    CURRENT_THEME = theme
    app.setStyleSheet(app_style())
    setup_lcd_blocks()
    refresh_dynamic_styles()


class ThemeSwitch(QtWidgets.QAbstractButton):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setCheckable(True)
        self.setCursor(QtCore.Qt.PointingHandCursor)
        self.setFixedSize(92, 32)
        self.setToolTip("Theme: dark / light")
        self._offset = 0.0
        self._animation = QtCore.QPropertyAnimation(self, b"offset", self)
        self._animation.setDuration(220)
        self._animation.setEasingCurve(QtCore.QEasingCurve.OutCubic)
        self.toggled.connect(self._animate)

    def sizeHint(self):
        return QtCore.QSize(92, 32)

    def _animate(self, checked):
        self._animation.stop()
        self._animation.setStartValue(self._offset)
        self._animation.setEndValue(1.0 if checked else 0.0)
        self._animation.start()

    def get_offset(self):
        return self._offset

    def set_offset(self, value):
        self._offset = value
        self.update()

    offset = QtCore.pyqtProperty(float, fget=get_offset, fset=set_offset)

    def paintEvent(self, event):
        p = QtGui.QPainter(self)
        p.setRenderHint(QtGui.QPainter.Antialiasing)

        t = self._offset
        rect = QtCore.QRectF(1, 1, self.width() - 2, self.height() - 2)
        dark = QtGui.QColor("#1d2430")
        light = QtGui.QColor("#e9eef6")
        bg = QtGui.QColor(
            int(dark.red() + (light.red() - dark.red()) * t),
            int(dark.green() + (light.green() - dark.green()) * t),
            int(dark.blue() + (light.blue() - dark.blue()) * t),
        )

        p.setPen(QtGui.QPen(QtGui.QColor("#596477" if t < 0.5 else "#aab4c2"), 1))
        p.setBrush(bg)
        p.drawRoundedRect(rect, 16, 16)

        p.setPen(QtGui.QColor("#dbe4ef" if t < 0.5 else "#182231"))
        p.drawText(QtCore.QRectF(10, 0, 30, self.height()), QtCore.Qt.AlignCenter, "D")
        p.drawText(QtCore.QRectF(self.width() - 40, 0, 30, self.height()), QtCore.Qt.AlignCenter, "L")

        knob_w = 42
        knob_x = 3 + (self.width() - knob_w - 6) * t
        knob = QtCore.QRectF(knob_x, 3, knob_w, self.height() - 6)
        knob_top = QtGui.QColor("#3a4352" if t < 0.5 else "#ffffff")
        knob_bottom = QtGui.QColor("#151a22" if t < 0.5 else "#cbd5e1")
        grad = QtGui.QLinearGradient(knob.topLeft(), knob.bottomLeft())
        grad.setColorAt(0, knob_top)
        grad.setColorAt(1, knob_bottom)
        p.setPen(QtGui.QPen(QtGui.QColor("#0b0f15" if t < 0.5 else "#94a3b8"), 1))
        p.setBrush(grad)
        p.drawRoundedRect(knob, 13, 13)

        p.setPen(QtGui.QColor("#ffffff" if t < 0.5 else "#182231"))
        label = "DARK" if t < 0.5 else "LIGHT"
        p.drawText(knob, QtCore.Qt.AlignCenter, label)


def _prepare_weather_label(label):
    if label.text() == "TextLabel":
        label.setText("--")
    label.setWordWrap(False)
    label.setAlignment(QtCore.Qt.AlignLeft | QtCore.Qt.AlignVCenter)
    label.setSizePolicy(QtWidgets.QSizePolicy.Expanding, QtWidgets.QSizePolicy.Fixed)
    label.setMinimumHeight(18)
    return label


def _add_weather_label(layout, name, row, column, row_span=1, column_span=1):
    label = _prepare_weather_label(getattr(ui, name))
    label.setParent(layout.parentWidget())
    layout.addWidget(label, row, column, row_span, column_span)


def setup_weather_panels():
    for line_name in ("line_2", "line_3", "line_4", "line_5"):
        if hasattr(ui, line_name):
            getattr(ui, line_name).hide()

    daily_panel = QtWidgets.QFrame(ui.centralwidget)
    daily_panel.setObjectName("dailyWeatherPanel")
    daily_panel.setGeometry(8, 326, 430, 78)
    daily_layout = QtWidgets.QGridLayout(daily_panel)
    daily_layout.setContentsMargins(10, 8, 10, 8)
    daily_layout.setHorizontalSpacing(10)
    daily_layout.setVerticalSpacing(4)

    _add_weather_label(daily_layout, "sunL", 0, 0)
    _add_weather_label(daily_layout, "tmaxL", 0, 1)
    _add_weather_label(daily_layout, "rainHoursL", 0, 2)
    _add_weather_label(daily_layout, "dayL", 1, 0)
    _add_weather_label(daily_layout, "tminL", 1, 1)
    _add_weather_label(daily_layout, "rainSumL", 1, 2)
    _add_weather_label(daily_layout, "swrSumL", 2, 0, 1, 3)
    for column in range(3):
        daily_layout.setColumnStretch(column, 1)

    weather_panel = QtWidgets.QFrame(ui.centralwidget)
    weather_panel.setObjectName("weatherPanel")
    weather_panel.setGeometry(455, 405, 380, 180)
    weather_layout = QtWidgets.QGridLayout(weather_panel)
    weather_layout.setContentsMargins(12, 10, 12, 10)
    weather_layout.setHorizontalSpacing(10)
    weather_layout.setVerticalSpacing(5)

    _add_weather_label(weather_layout, "outsideTempL", 0, 0)
    _add_weather_label(weather_layout, "outHumL", 0, 1)
    _add_weather_label(weather_layout, "apparentTempL", 0, 2)
    _add_weather_label(weather_layout, "dewL", 0, 3)
    _add_weather_label(weather_layout, "precipProbL", 1, 0)
    _add_weather_label(weather_layout, "cloudCoverL", 1, 1)
    _add_weather_label(weather_layout, "uvL", 1, 2)
    _add_weather_label(weather_layout, "swrL", 1, 3)
    _add_weather_label(weather_layout, "windL", 2, 0, 1, 2)
    _add_weather_label(weather_layout, "snowL", 2, 2, 1, 2)
    _add_weather_label(weather_layout, "ozoneL", 3, 0)
    _add_weather_label(weather_layout, "dustL", 3, 1)
    _add_weather_label(weather_layout, "aodL", 3, 2)
    _add_weather_label(weather_layout, "outCO2L", 3, 3)
    _add_weather_label(weather_layout, "outPm10L", 4, 0, 1, 2)
    _add_weather_label(weather_layout, "outPm25L", 4, 2, 1, 2)
    for column in range(4):
        weather_layout.setColumnStretch(column, 1)

    ui.dailyWeatherPanel = daily_panel
    ui.weatherPanel = weather_panel


def remove_event_timer_controls():
    timer_container = ui.checkEvent_1.parentWidget()
    if timer_container:
        timer_container.hide()


setup_weather_panels()
remove_event_timer_controls()

theme_switch = ThemeSwitch(ui.centralwidget)
theme_switch.move(733, 154)
theme_switch.toggled.connect(lambda checked: apply_theme("light" if checked else "dark"))
ui.themeSwitch = theme_switch
apply_theme(CURRENT_THEME)

ky_timer = QTimer()
ky_timer.setInterval(300000)


weather_timer = QTimer()
weather_timer.setInterval(10 * 60 * 1000)  # раз на 10 хв

net = QNetworkAccessManager()

LAT = 51.4408
LON = 19.2658

################################ блок який відповідає за вспливаючі вікна
msg = QMessageBox()
msg.setIcon(QMessageBox.Information)
msg.setText("яїчка готові")
msg.setWindowTitle("яйовар")
msg.setStandardButtons(QMessageBox.Ok)
################################
rx_buf = bytearray()

serial = QSerialPort()
serial.setBaudRate (115200)
portList = []
ports = QSerialPortInfo().availablePorts()

for port in ports:
    portList.append(port.portName())
ui.comboBox.addItems(portList)

if "COM9" in portList:
    ui.comboBox.setCurrentText("COM9")

def ky_halo():
    sendi("kyy")
    set_button_state(ui.openB, "grey")
ky_timer.timeout.connect(ky_halo)
def onOpen():
    if serial.isOpen():
        serial.close()
    serial.setPortName(ui.comboBox.currentText())
    serial.setBaudRate(115200)
    serial.open(QIODevice.ReadWrite)

def send_heatBox_value():  # відправляеця сообщеніє на Kheat шоб установити підтримуваний рівень температури
    value = round(ui.heatBox.value(), 2)
    sendi(f'W5{value}')
    set_control_state(ui.heatBox, "grey")
    #print(f"Відправка: R5: {value}")
def on_heatBox_value_changed(): # Перезапускаємо таймер на 3 секунди при кожній зміні
    heatBox_timer.start(3000)
def feedback():
    commands = [("garland_echo", 1200), ("red_led_echo", 1200), ("sens_echo", 1200), ("choinka", 1200), ("bedside_echo", 1200),
                ("echo_turb", 1200), ("lamech", 1200), ("pm1", 1200), ("jajoeh", 1200), ("heho", 1200), ("pwech", 1200)]
    for i, (command, delay) in enumerate(commands):
        QTimer.singleShot(sum(item[1] for item in commands[:i+1]), lambda cmd=command: sendi(cmd))
    print("feeeeeeeeeeee")

def onClose(): # закриваеця ком порт
    serial.close()
def sendi(datic):
    msg = (datic or "").strip()
    if not msg or not serial.isOpen():
        return
    serial.write(msg.encode("utf-8") + b"\n")
    serial.flush()  # корисно для BT-SPP
def set_col_ind (x, u, y):
    getattr(ui, x).setCurrentIndex(u)
    set_control_state(getattr(ui, x), y)
def turboBox_change(index):
    sendi(f'14{index}')
def modBoxR_change(index):
    sendi(f'01_mode_{index}')
def colorBox_change(index):
    sendi(f'18{index}')
def watLBox_change(index):
    if index <= 9:
        sendi(f'19{index}')
    else: sendi(f'19M')
def briBoxR_change(index):
    if index <= 9:
        sendi(f'02_bri_{index}')
    else: sendi(f'02_bri_M')
def mod_change_fid(x):
    if x[:2] == '01':
        set_col_ind("modBoxR", int(x[-1]), "grey")
def mod_colorBox_fid(x):
    if x[:2] == '21':
        set_col_ind("colorBox", int(x[-1]), "grey")
def bri_change_fid(x):
    match x:
        case "020": set_col_ind("briBoxR", 0, "grey")
        case "0226": set_col_ind("briBoxR", 1, "grey")
        case "0251": set_col_ind("briBoxR", 2, "grey")
        case "0277": set_col_ind("briBoxR", 3, "grey")
        case "02102": set_col_ind("briBoxR", 4, "grey")
        case "02128": set_col_ind("briBoxR", 5, "grey")
        case "02153": set_col_ind("briBoxR", 6, "grey")
        case "02179": set_col_ind ("briBoxR", 7, "grey")
        case "02204": set_col_ind ("briBoxR", 8, "grey")
        case "02230": set_col_ind ("briBoxR", 9, "grey")
        case "02255": set_col_ind ("briBoxR", 10, "grey")
def watLBox_change_fid(x):
    match x:
        case "200": set_col_ind("watLBox", 0, "grey")
        case "2026": set_col_ind("watLBox", 1, "grey")
        case "2051": set_col_ind("watLBox", 2, "grey")
        case "2077": set_col_ind("watLBox", 3, "grey")
        case "20102": set_col_ind("watLBox", 4, "grey")
        case "20128": set_col_ind("watLBox", 5, "grey")
        case "20153": set_col_ind("watLBox", 6, "grey")
        case "20179": set_col_ind ("watLBox", 7, "grey")
        case "20204": set_col_ind ("watLBox", 8, "grey")
        case "20230": set_col_ind ("watLBox", 9, "grey")
        case "20255": set_col_ind ("watLBox", 10, "grey")
def reti():                                # тут можуть бути баги
    txt = "05" + ui.spedE.text()
    ui.spedE.clear()
    sendi(txt)
def send2mash():                                # тут можуть бути баги
    sendi(ui.sendL.text())
    ui.sendL.clear()
def onRead():
    # 1) забираємо все, що надійшло зараз
    rx_buf.extend(serial.readAll())

    # 2) обробляємо ВСІ повні рядки (до \n), нічого не чекаємо
    while True:
        nl = rx_buf.find(b'\n')
        if nl == -1:
            break  # немає повної лінії -> вийдемо, дочекаємось наступного readyRead

        raw = rx_buf[:nl]          # байти до \n (без \n)
        del rx_buf[:nl + 1]        # з'їдаємо з буфера й саму \n

        # 3) нормалізуємо рядок
        s = raw.rstrip(b'\r').decode('utf-8', 'ignore').strip()
        if not s:
            continue

        # (опц.) лог без квадратних дужок
        # print(s)

        # 4) токенізуємо як і раніше: перший елемент у data[0]
        data = [t for t in (tok.strip() for tok in s.split(',')) if t]
        if not data:
            continue
        x0 = data[0]
        print(x0)

        # =======  ЛОГІКА =======

        if x0 == 'hello':
            set_button_state(ui.openB, "green")
            feedback()
            ky_timer.start()

        if x0 == 'kyy':
            set_button_state(ui.openB, "green")

        if x0 == 'jajo_on':
            msg.exec_()

        if x0 == 'pimpa':
            set_button_state(ui.pumpB, "green")

        if x0 == 'jaeh':
            set_button_state(ui.jajoB, "yellow", "black")

        if x0 == 'garland_on':
            set_button_state(ui.pushB, "green")
        if x0 == 'garland_off':
            set_button_state(ui.pushB, "black")

        if x0 == 'redled_on':
            set_button_state(ui.redB, "green")
        if x0 == 'redled_off':
            set_button_state(ui.redB, "black")

        if x0 == 'bdsdl1':
            set_button_state(ui.bedLB, "green")
        if x0 == 'bdsdl0':
            set_button_state(ui.bedLB, "black")

        if x0 == 'feedpowled1':
            set_button_state(ui.pledB, "green")
        if x0 == 'feedpowled0':
            set_button_state(ui.pledB, "black")

        if len(x0) >= 2:
            head2 = x0[:2]

            if head2 == '03':
                ui.lcdSp.display(x0[2:])

            elif head2 == '04':
                ui.lcdPpm.display(x0[2:])
                set_button_state(ui.ppmB, "green")

            elif head2 == '05':
                ui.lcdTemp.display(x0[2:])
                set_button_state(ui.tempB, "green")

            elif head2 == '06':
                ui.lcdHumi.display(x0[2:])
                set_button_state(ui.humiB, "green")

            elif head2 == '07':
                ui.lcdLux.setDigitCount(7)
                ui.lcdLux.display(x0[2:])
                set_button_state(ui.luxB, "green")

            elif head2 == '08':
                ui.lcdAtm.setDigitCount(6)
                ui.lcdAtm.display(x0[2:])
                set_button_state(ui.atmB, "green")

            elif head2 == '09':
                set_button_state(ui.khrBut, "green" if x0[2:] == '1' else "black")

            elif head2 == '10':
                ui.lcdpm1.display(x0[2:])
                set_button_state(ui.pm1B, "green")

            elif head2 == '11':
                ui.lcdpm2.display(x0[2:])
                set_button_state(ui.pm2B, "green")

            elif head2 == '12':
                ui.lcdpm10.display(x0[2:])
                set_button_state(ui.pm10B, "green")

            elif head2 == '13':
                set_button_state(ui.pumpB, "green" if x0[2:] == '1' else "black")

            elif head2 == '14':
                set_control_state(ui.turboBox, "black" if x0[2:] == '0' else "grey")

            elif head2 == '16':
                set_button_state(ui.flowB, "green" if x0[2:] == '1' else "black")

            elif head2 == '17':
                set_button_state(ui.ionB, "green" if x0[2:] == '1' else "black")

            elif head2 == '25':
                d = x0[2:3]
                if d == '0':
                    ui.khBox.setCurrentIndex(1)
                    set_control_state(ui.khBox, "grey")
                elif d == '1':
                    ui.khBox.setCurrentIndex(2)
                    set_control_state(ui.khBox, "grey")
                elif d == '2':
                    ui.khBox.setCurrentIndex(3)
                    set_control_state(ui.khBox, "grey")
                elif d == '3':
                    ui.khBox.setCurrentIndex(4)
                    set_control_state(ui.khBox, "grey")
                elif d == '4':
                    ui.khBox.setCurrentIndex(0)
                    set_control_state(ui.khBox, "black")

            elif head2 == '15':
                set_button_state(ui.huB, "green")
                d3 = x0[2:3]
                if d3 == '0':
                    ui.turboBox.setCurrentIndex(0)
                    set_control_state(ui.turboBox, "black")
                elif d3 == '1':
                    ui.turboBox.setCurrentIndex(1)
                    set_control_state(ui.turboBox, "grey")
                elif d3 == '2':
                    ui.turboBox.setCurrentIndex(2)
                    set_control_state(ui.turboBox, "grey")
                else:
                    ui.turboBox.setCurrentIndex(3)
                    set_control_state(ui.turboBox, "grey")

                set_button_state(ui.pumpB, "green" if x0[3:4]=='0' else "black")
                set_button_state(ui.flowB, "green" if x0[4:5]=='0' else "black")
                set_button_state(ui.ionB, "green" if x0[5:6]=='0' else "black")

            elif head2 == 'La':
                set_button_state(ui.lamB, "green" if x0[2:] == '1' else "black")

            elif head2 == 'R5':
                try:
                    y = float(x0[2:])
                    ui.heatBox.setValue(y)
                    set_control_state(ui.heatBox, "green")
                    set_button_state(ui.khB, "green")
                except ValueError:
                    pass

            elif head2 == 'A5':
                ui.khBox.setCurrentIndex(5)
                set_control_state(ui.khBox, "green")
                set_button_state(ui.khB, "green")

        # виклики, що залежать лише від рядка цілком:
        watLBox_change_fid(x0)
        mod_colorBox_fid(x0)
        mod_change_fid(x0)
        bri_change_fid(x0)

#///////////////////////////////////////////////
def saveT1():
    saved_text = ui.lineEvent_1.text()
    sendi( saved_text)
def saveT2():
    saved_text = ui.lineEvent_2.text()
    sendi( saved_text)
def updox_change(s):
    if s == QtCore.Qt.Checked:
        print("Чекбокс 'updox' встановлено")
        set_control_state(ui.autoCBox, "green")
        x = ui.autoCBox.currentIndex()
        match x:
            case 0:
                print(f"Вибраний індекс60: {x}")
                interval = 60 * 60 * 1000  # 60 хвилин у мілісекундах
            case 1:
                print(f"Вибраний індекс45: {x}")
                interval = 45 * 60 * 1000  # 45 хвилин у мілісекундах
            case 2:
                print(f"Вибраний індекс30: {x}")
                interval = 30 * 60 * 1000  # 30 хвилин у мілісекундах
            case 3:
                print(f"Вибраний індекс15: {x}")
                interval = 15 * 60 * 1000  # 15 хвилин у мілісекундах

        auto_timer.timeout.connect(feedback)
        auto_timer.setInterval(interval)
        auto_timer.setSingleShot(False)  # Таймер повторюється
        auto_timer.start()  # Запускаємо таймер

    else:
        print("Чекбокс 'updox' скасовано")
        set_control_state(ui.autoCBox, "grey")
        auto_timer.stop()  # Зупиняємо таймер, якщо чекбокс скасований

def dbgBox_change(s):
    if s == QtCore.Qt.Checked:
        sendi("dbg1")
    else:
        sendi("dbg0")
#/////////////////////////////////////////////////////
class TimerWidget(QtWidgets.QWidget):
    timer1_timeout = QtCore.pyqtSignal()
    timer2_timeout = QtCore.pyqtSignal()

    def __init__(self):

        super().__init__()

        self.timer1 = QtCore.QTimer(self)
        self.timer1.timeout.connect(self.timer1_timeout.emit)

        self.timer2 = QtCore.QTimer(self)
        self.timer2.timeout.connect(self.timer2_timeout.emit)

        ui.timeEvent_1.timeChanged.connect(self.set_timer1)
        ui.timeEvent_2.timeChanged.connect(self.set_timer2)

        self.timer1_timeout.connect(saveT1)
        self.timer2_timeout.connect(saveT2)

        ui.checkEvent_1.stateChanged.connect(self.toggle_timer1)
        ui.checkEvent_2.stateChanged.connect(self.toggle_timer2)

    def set_timer1(self):
        if ui.checkEvent_1.isChecked():
            time = ui.timeEvent_1.time()
            self.timer1.setSingleShot(True)
            self.timer1.setInterval(QTime.currentTime().msecsTo(time))
            self.timer1.start()

    def set_timer2(self):
        if ui.checkEvent_2.isChecked():
            time = ui.timeEvent_2.time()
            self.timer2.setSingleShot(True)
            self.timer2.setInterval(QTime.currentTime().msecsTo(time))
            self.timer2.start()

    def toggle_timer1(self, state):
        if state == QtCore.Qt.Checked:
            self.set_timer1()
        else:
            self.timer1.stop()

    def toggle_timer2(self, state):
        if state == QtCore.Qt.Checked:
            self.set_timer2()
        else:
            self.timer2.stop()

timer_widget = None
################################################################
heatBox_timer.timeout.connect(send_heatBox_value)
ui.heatBox.valueChanged.connect(on_heatBox_value_changed)

ui.colorBox.activated.connect(colorBox_change)
ui.watLBox.activated.connect(watLBox_change)

ui.modBoxR.activated.connect(modBoxR_change)
ui.briBoxR.activated.connect(briBoxR_change)

ui.turboBox.activated.connect(turboBox_change)

serial.readyRead.connect(onRead)

ui.upB.clicked.connect(feedback)

ui.openB.clicked.connect(onOpen)
ui.closeB.clicked.connect(onClose)

ui.updox.stateChanged.connect(updox_change)

ui.dbgBox.stateChanged.connect(dbgBox_change)

ui.khrBut.clicked.connect(lambda: sendi("hero"))

ui.bedLB.clicked.connect(lambda: sendi("bedside"))
ui.pushB.clicked.connect(lambda: sendi("garland"))
ui.redB.clicked.connect(lambda: sendi("power"))
ui.lamB.clicked.connect(lambda: sendi("lam"))
ui.pledB.clicked.connect(lambda: sendi("powled"))

ui.ppmB.clicked.connect(lambda: sendi("ppm_echo"))
ui.tempB.clicked.connect(lambda: sendi("temp_echo"))
ui.humiB.clicked.connect(lambda: sendi("humi_echo"))
ui.luxB.clicked.connect(lambda: sendi("lux_echo"))
ui.atmB.clicked.connect(lambda: sendi("atm_echo"))

ui.pumpB.clicked.connect(lambda: sendi("pomp"))
ui.flowB.clicked.connect(lambda: sendi("flow"))
ui.ionB.clicked.connect(lambda: sendi("ion"))
ui.huB.clicked.connect(lambda: sendi("huOn"))

ui.jajoB.clicked.connect(lambda: sendi("jajo"))

ui.speedBU.clicked.connect(lambda: sendi("redl_sp+"))
ui.speedBD.clicked.connect(lambda: sendi("redl_sp-"))

ui.spedE.returnPressed.connect(reti)
ui.sendL.returnPressed.connect(send2mash)

def outside_tick():
    weather_tick(net, LAT, LON, ui)
    air_tick(net, LAT, LON, ui)


outside_tick()  # один раз одразу
weather_timer.timeout.connect(outside_tick)
weather_timer.start()

ui.show()
app.exec()
