from PyQt5 import QtCore, QtWidgets, uic
from PyQt5.QtCore import QTime, pyqtSignal, QIODevice, QTimer, Qt
from PyQt5.QtSerialPort import QSerialPort, QSerialPortInfo
from PyQt5.QtWidgets import QApplication, QMessageBox
#import sqlite3


auto_timer = QTimer()

heatBox_timer = QTimer()
heatBox_timer.setSingleShot(True)  # Таймер спрацьовує один раз

app = QtWidgets.QApplication([])
ui = uic.loadUi("keeMASH.ui")
ui.setWindowTitle("keeMASH")

ky_timer = QTimer()
ky_timer.setInterval(300000)

################################ блок який відповідає за вспливаючі вікна
msg = QMessageBox()
msg.setIcon(QMessageBox.Information)
msg.setText("яїчка готові")
msg.setWindowTitle("яйовар")
msg.setStandardButtons(QMessageBox.Ok)
################################

serial = QSerialPort()
serial.setBaudRate (115200)
portList = []
ports = QSerialPortInfo().availablePorts()

for port in ports:
    portList.append(port.portName())
ui.comboBox.addItems(portList)

if "COM4" in portList:
    ui.comboBox.setCurrentText("COM4")
def ky_halo():
    sendi("kyy")
    ui.openB.setStyleSheet("background-color: grey; color: white;")
ky_timer.timeout.connect(ky_halo)
def onOpen():   # очевідно шо тут відкриваеця сом порт для связі
    serial.setPortName(ui.comboBox.currentText())
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
                ("echo_turb", 1200), ("lamech", 1200), ("pm1", 1200), ("jajoeh", 1200), ("heho", 1200)]
    for i, (command, delay) in enumerate(commands):
        QTimer.singleShot(sum(item[1] for item in commands[:i+1]), lambda cmd=command: sendi(cmd))
    print("feeeeeeeeeeee")

def onClose(): # закриваеця ком порт
    serial.close()
def sendi (datic): # удобна функція відправки сообщенія в МЕШ
    serial.writeData(datic.encode('utf-8'))
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
    rx = serial.readLine()
    rxs = str (rx, "utf-8").strip()
    data = rxs.split(",")
    print(data)

    if data[0] == 'hello':
        ui.openB.setStyleSheet("background-color: green; color: white;")
        feedback()
        ky_timer.start()

    if data[0] == 'ky':
        ui.openB.setStyleSheet("background-color: green; color: white;")

    if data[0] == 'jajo_on':
        msg.exec_()

    if data[0] == 'pimpa':
        ui.pumpB.setStyleSheet("background-color: green; color: white;")

    if data[0] == 'jaeh':
        ui.jajoB.setStyleSheet("background-color: yellow; color: black;")

    if data[0] == 'garland_on':
        ui.pushB.setStyleSheet("background-color: green; color: white;")
    if data[0] == 'garland_off':
        ui.pushB.setStyleSheet("background-color: black; color: white;")

    if data[0] == 'redled_on':
        ui.redB.setStyleSheet("background-color: green; color: white;")
    if data[0] == 'redled_off':
        ui.redB.setStyleSheet("background-color: black; color: white;")

    if data[0] == 'bedside_on':
        ui.bedLB.setStyleSheet("background-color: green; color: white;")
    if data[0] == 'bedside_off':
        ui.bedLB.setStyleSheet("background-color: black; color: white;")

    if data[0][:2] == '03':
        spF = data[0][2:]
        ui.lcdSp.display(spF)

    if data[0][:2] == '04':
        ppm = data[0][2:]
        ui.lcdPpm.display(ppm)
        ui.ppmB.setStyleSheet("background-color: green; color: white;")

    if data[0][:2] == '05':      # це приходить значеніє з есп міксера зчитуваної температури
        temp = data[0][2:]
        ui.lcdTemp.display(temp)
        ui.tempB.setStyleSheet("background-color: green; color: white;")

    if data[0][:2] == '06':
        humi = data[0][2:]
        ui.lcdHumi.display(humi)
        ui.humiB.setStyleSheet("background-color: green; color: white;")

    if data[0][:2] == '07':
        lux = data[0][2:]
        ui.lcdLux.setDigitCount(7)
        ui.lcdLux.display(lux)
        ui.luxB.setStyleSheet("background-color: green; color: white;")

    if data[0][:2] == '08':
        atm = data[0][2:]
        ui.lcdAtm.setDigitCount(6)
        ui.lcdAtm.display(atm)
        ui.atmB.setStyleSheet("background-color: green; color: white;")

    if data[0][:2] == '09':     # параметер оборота корпуса Kheater
        x = data[0][2:]
        if x == '1':
            ui.khrBut.setStyleSheet("background-color: green; color: white;")
        else: ui.khrBut.setStyleSheet("background-color: black; color: white;")

    if data[0][:2] == '10':
        pm1 = data[0][2:]
        ui.lcdpm1.display(pm1)
        ui.pm1B.setStyleSheet("background-color: green; color: white;")

    if data[0][:2] == '11':
        pm2 = data[0][2:]
        ui.lcdpm2.display(pm2)
        ui.pm2B.setStyleSheet("background-color: green; color: white;")

    if data[0][:2] == '12':
        pm10 = data[0][2:]
        ui.lcdpm10.display(pm10)
        ui.pm10B.setStyleSheet("background-color: green; color: white;")

    if data[0][:2] == '13':
        x = data[0][2:]
        if x == '1':
            ui.pumpB.setStyleSheet("background-color: green; color: white;")
        else: ui.pumpB.setStyleSheet("background-color: black; color: white;")

    if data[0][:2] == '14':
        x = data[0][2:]
        if x == '0':
            ui.turboBox.setStyleSheet("background-color: black; color: white;")
        else: ui.turboBox.setStyleSheet("background-color: grey; color: white;")

    if data[0][:2] == '16':
        x = data[0][2:]
        if x == '1':
            ui.flowB.setStyleSheet("background-color: green; color: white;")
        else: ui.flowB.setStyleSheet("background-color: black; color: white;")

    if data[0][:2] == '17':
        x = data[0][2:]
        if x == '1':
            ui.ionB.setStyleSheet("background-color: green; color: white;")
        else: ui.ionB.setStyleSheet("background-color: black; color: white;")

    if data[0][:2] == '25':
        #ui.khrBut.setStyleSheet("background-color: green; color: white;")
        if data[0][2:3] == '0':
            ui.khBox.setStyleSheet("background-color: grey; color: white;")
            ui.khBox.setCurrentIndex(1)
        elif data[0][2:3] == '1':
            ui.khBox.setCurrentIndex(2)
            ui.khBox.setStyleSheet("background-color: grey; color: white;")
        elif data[0][2:3] == '2':
            ui.khBox.setCurrentIndex(3)
            ui.khBox.setStyleSheet("background-color: grey; color: white;")
        elif data[0][2:3] == '3':
            ui.khBox.setCurrentIndex(4)
            ui.khBox.setStyleSheet("background-color: grey; color: white;")
        elif data[0][2:3] == '4':
            ui.khBox.setCurrentIndex(0)
            ui.khBox.setStyleSheet("background-color: black; color: white;")
        #else:
            #ui.khBox.setCurrentIndex(5)
            #ui.khBox.setStyleSheet("background-color: grey; color: white;")

    if data[0][:2] == '15':
        ui.huB.setStyleSheet("background-color: green; color: white;")

        if data[0][2:3] == '0':
            ui.turboBox.setStyleSheet("background-color: black; color: white;")
            ui.turboBox.setCurrentIndex(0)
        elif data[0][2:3] == '1':
            ui.turboBox.setCurrentIndex(1)
            ui.turboBox.setStyleSheet("background-color: grey; color: white;")
        elif data[0][2:3] == '2':
            ui.turboBox.setCurrentIndex(2)
            ui.turboBox.setStyleSheet("background-color: grey; color: white;")
        else:
            ui.turboBox.setCurrentIndex(3)
            ui.turboBox.setStyleSheet("background-color: grey; color: white;")

        if data[0][3:4] == '0':
            ui.pumpB.setStyleSheet("background-color: green; color: white;")
        else: ui.pumpB.setStyleSheet("background-color: black; color: white;")

        if data[0][4:5] == '0':
            ui.flowB.setStyleSheet("background-color: green; color: white;")
        else: ui.flowB.setStyleSheet("background-color: black; color: white;")

        if data[0][5:6] == '0':
            ui.ionB.setStyleSheet("background-color: green; color: white;")
        else: ui.ionB.setStyleSheet("background-color: black; color: white;")

    if data[0][:2] == 'La':
        x = data[0][2:]
        if x == '1':
            ui.lamB.setStyleSheet("background-color: green; color: white;")
        else: ui.lamB.setStyleSheet("background-color: black; color: white;")

    if data[0][:2] == 'R5': # принімаем фітбек про удачну змінну температури
        x = data[0][2:]

        y = float(x)
        ui.heatBox.setValue(y)
        ui.heatBox.setStyleSheet("background-color: green; color: white;")
        ui.khB.setStyleSheet("background-color: green; color: white;")

    if data[0][:2] == 'A5': # принімаем фітбек про то шо установляний ауто мод в kheater
        ui.khBox.setCurrentIndex(5)
        ui.khBox.setStyleSheet("background-color: green; color: white;")
        ui.khB.setStyleSheet("background-color: green; color: white;")

    watLBox_change_fid(data[0])
    mod_colorBox_fid(data[0])

    mod_change_fid(data[0])
    bri_change_fid(data[0])
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

ui.show()
app.exec()