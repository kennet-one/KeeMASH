from PyQt5 import QtCore, QtWidgets, uic
from PyQt5.QtNetwork import QNetworkAccessManager
from PyQt5.QtCore import QTime, QIODevice, QTimer
from PyQt5.QtSerialPort import QSerialPort, QSerialPortInfo
from PyQt5.QtWidgets import QMessageBox

from weather_ext import weather_tick

auto_timer = QTimer()

heatBox_timer = QTimer()
heatBox_timer.setSingleShot(True)  # Таймер спрацьовує один раз

app = QtWidgets.QApplication([])
ui = uic.loadUi("keeMASH.ui")
ui.setWindowTitle("keeMASH")

ky_timer = QTimer()
ky_timer.setInterval(300000)


weather_timer = QTimer()
weather_timer.setInterval(10 * 60 * 1000)  # раз на 10 хв

net = QNetworkAccessManager()

LAT = 51.7592
LON = 19.4550

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
    ui.openB.setStyleSheet("background-color: grey; color: white;")
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
    ui.heatBox.setStyleSheet("background-color: grey; color: white;")
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
    getattr(ui, x).setStyleSheet(f"background-color: {y}; color: white;")
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

        # =======  ЛОГІКА (адаптована під x0) =======

        if x0 == 'hello':
            ui.openB.setStyleSheet("background-color: green; color: white;")
            feedback()
            ky_timer.start()

        if x0 == 'kyy':
            ui.openB.setStyleSheet("background-color: green; color: white;")

        if x0 == 'jajo_on':
            msg.exec_()

        if x0 == 'pimpa':
            ui.pumpB.setStyleSheet("background-color: green; color: white;")

        if x0 == 'jaeh':
            ui.jajoB.setStyleSheet("background-color: yellow; color: black;")

        if x0 == 'garland_on':
            ui.pushB.setStyleSheet("background-color: green; color: white;")
        if x0 == 'garland_off':
            ui.pushB.setStyleSheet("background-color: black; color: white;")

        if x0 == 'redled_on':
            ui.redB.setStyleSheet("background-color: green; color: white;")
        if x0 == 'redled_off':
            ui.redB.setStyleSheet("background-color: black; color: white;")

        if x0 == 'bdsdl1':
            ui.bedLB.setStyleSheet("background-color: green; color: white;")
        if x0 == 'bdsdl0':
            ui.bedLB.setStyleSheet("background-color: black; color: white;")

        if x0 == 'feedpowled1':
            ui.pledB.setStyleSheet("background-color: green; color: white;")
        if x0 == 'feedpowled0':
            ui.pledB.setStyleSheet("background-color: black; color: white;")

        if len(x0) >= 2:
            head2 = x0[:2]

            if head2 == '03':
                ui.lcdSp.display(x0[2:])

            elif head2 == '04':
                ui.lcdPpm.display(x0[2:])
                ui.ppmB.setStyleSheet("background-color: green; color: white;")

            elif head2 == '05':
                ui.lcdTemp.display(x0[2:])
                ui.tempB.setStyleSheet("background-color: green; color: white;")

            elif head2 == '06':
                ui.lcdHumi.display(x0[2:])
                ui.humiB.setStyleSheet("background-color: green; color: white;")

            elif head2 == '07':
                ui.lcdLux.setDigitCount(7)
                ui.lcdLux.display(x0[2:])
                ui.luxB.setStyleSheet("background-color: green; color: white;")

            elif head2 == '08':
                ui.lcdAtm.setDigitCount(6)
                ui.lcdAtm.display(x0[2:])
                ui.atmB.setStyleSheet("background-color: green; color: white;")

            elif head2 == '09':
                ui.khrBut.setStyleSheet(
                    "background-color: green; color: white;" if x0[2:] == '1'
                    else "background-color: black; color: white;"
                )

            elif head2 == '10':
                ui.lcdpm1.display(x0[2:])
                ui.pm1B.setStyleSheet("background-color: green; color: white;")

            elif head2 == '11':
                ui.lcdpm2.display(x0[2:])
                ui.pm2B.setStyleSheet("background-color: green; color: white;")

            elif head2 == '12':
                ui.lcdpm10.display(x0[2:])
                ui.pm10B.setStyleSheet("background-color: green; color: white;")

            elif head2 == '13':
                ui.pumpB.setStyleSheet(
                    "background-color: green; color: white;" if x0[2:] == '1'
                    else "background-color: black; color: white;"
                )

            elif head2 == '14':
                ui.turboBox.setStyleSheet(
                    "background-color: black; color: white;" if x0[2:] == '0'
                    else "background-color: grey; color: white;"
                )

            elif head2 == '16':
                ui.flowB.setStyleSheet(
                    "background-color: green; color: white;" if x0[2:] == '1'
                    else "background-color: black; color: white;"
                )

            elif head2 == '17':
                ui.ionB.setStyleSheet(
                    "background-color: green; color: white;" if x0[2:] == '1'
                    else "background-color: black; color: white;"
                )

            elif head2 == '25':
                d = x0[2:3]
                if   d == '0': ui.khBox.setCurrentIndex(1); ui.khBox.setStyleSheet("background-color: grey; color: white;")
                elif d == '1': ui.khBox.setCurrentIndex(2); ui.khBox.setStyleSheet("background-color: grey; color: white;")
                elif d == '2': ui.khBox.setCurrentIndex(3); ui.khBox.setStyleSheet("background-color: grey; color: white;")
                elif d == '3': ui.khBox.setCurrentIndex(4); ui.khBox.setStyleSheet("background-color: grey; color: white;")
                elif d == '4': ui.khBox.setCurrentIndex(0); ui.khBox.setStyleSheet("background-color: black; color: white;")

            elif head2 == '15':
                ui.huB.setStyleSheet("background-color: green; color: white;")
                d3 = x0[2:3]
                if   d3 == '0': ui.turboBox.setCurrentIndex(0); ui.turboBox.setStyleSheet("background-color: black; color: white;")
                elif d3 == '1': ui.turboBox.setCurrentIndex(1); ui.turboBox.setStyleSheet("background-color: grey; color: white;")
                elif d3 == '2': ui.turboBox.setCurrentIndex(2); ui.turboBox.setStyleSheet("background-color: grey; color: white;")
                else:           ui.turboBox.setCurrentIndex(3); ui.turboBox.setStyleSheet("background-color: grey; color: white;")

                ui.pumpB.setStyleSheet("background-color: green; color: white;" if x0[3:4]=='0' else "background-color: black; color: white;")
                ui.flowB.setStyleSheet("background-color: green; color: white;" if x0[4:5]=='0' else "background-color: black; color: white;")
                ui.ionB .setStyleSheet("background-color: green; color: white;" if x0[5:6]=='0' else "background-color: black; color: white;")

            elif head2 == 'La':
                ui.lamB.setStyleSheet(
                    "background-color: green; color: white;" if x0[2:] == '1'
                    else "background-color: black; color: white;"
                )

            elif head2 == 'R5':
                try:
                    y = float(x0[2:])
                    ui.heatBox.setValue(y)
                    ui.heatBox.setStyleSheet("background-color: green; color: white;")
                    ui.khB.setStyleSheet("background-color: green; color: white;")
                except ValueError:
                    pass

            elif head2 == 'A5':
                ui.khBox.setCurrentIndex(5)
                ui.khBox.setStyleSheet("background-color: green; color: white;")
                ui.khB.setStyleSheet("background-color: green; color: white;")

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
        ui.autoCBox.setStyleSheet("background-color: green; color: white;")
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
        ui.autoCBox.setStyleSheet("background-color: grey; color: white;")
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

timer_widget = TimerWidget()
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

weather_tick(net, LAT, LON, ui)  # один раз одразу
weather_timer.timeout.connect(lambda: weather_tick(net, LAT, LON, ui))
weather_timer.start()

ui.show()
app.exec()