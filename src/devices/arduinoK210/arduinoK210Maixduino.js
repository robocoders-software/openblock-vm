const OpenBlockArduinoK210Device = require('./arduinoK210');

const CommonPeripheral = require('../common/common-peripheral');

/**
 * The list of USB device filters.
 * @readonly
 */
const PNPID_LIST = [
    // FTDI
    'USB\\VID_0403&PID_6010'
];

/**
 * Configuration of serialport
 * @readonly
 */
const SERIAL_CONFIG = {
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1
};

/**
 * Configuration for arduino-cli.
 * @readonly
 */
const DIVECE_OPT = {
    type: 'arduino',
    fqbn: 'Maixduino:k210:mduino:toolsloc=default,clksrc=400,burn_baudrate=1500000,burn_tool_firmware=mduino'
};

const Pins = {
    D0: '0',
    D1: '1',
    D2: '2',
    D3: '3',
    D4: '4',
    D5: '5',
    D6: '6',
    D7: '7',
    D8: '8',
    D9: '9',
    D10: '10',
    D11: '11',
    D12: '12',
    D13: '13',
    SDA: '14',
    SCL: '15',
    BOOT: '16'
};

/**
 * Manage communication with a Arduino Maixduino peripheral over a OpenBlock Link client socket.
 */
class ArduinoK210Maixduino extends CommonPeripheral{
    /**
     * Construct a Arduino communication object.
     * @param {Runtime} runtime - the OpenBlock runtime
     * @param {string} deviceId - the id of the extension
     * @param {string} originalDeviceId - the original id of the peripheral, like xxx_arduinoUno
     */
    constructor (runtime, deviceId, originalDeviceId) {
        super(runtime, deviceId, originalDeviceId, PNPID_LIST, SERIAL_CONFIG, DIVECE_OPT);
    }
}

/**
   * OpenBlock blocks to interact with a Arduino Nano Ultra peripheral.
   */
class OpenBlockArduinoK210MaixduinoDevice extends OpenBlockArduinoK210Device{

    /**
       * @return {string} - the ID of this extension.
       */
    get DEVICE_ID () {
        return 'arduinoK210Maixduino';
    }

    get PINS_MENU () {
        return [
            {
                text: '0',
                value: Pins.D0
            },
            {
                text: '1',
                value: Pins.D1
            },
            {
                text: '2',
                value: Pins.D2
            },
            {
                text: '3',
                value: Pins.D3
            },
            {
                text: '4',
                value: Pins.D4
            },
            {
                text: '5',
                value: Pins.D5
            },
            {
                text: '6',
                value: Pins.D6
            },
            {
                text: '7',
                value: Pins.D7
            },
            {
                text: '8',
                value: Pins.D8
            },
            {
                text: '9',
                value: Pins.D9
            },
            {
                text: '10',
                value: Pins.D10
            },
            {
                text: '11',
                value: Pins.D11
            },
            {
                text: '12',
                value: Pins.D12
            },
            {
                text: '13',
                value: Pins.D13
            },
            {
                text: 'SDA',
                value: Pins.SDA
            },
            {
                text: 'SCL',
                value: Pins.SCL
            },
            {
                text: 'BOOT',
                value: Pins.BOOT
            }
        ];
    }

    get DEFAULT_PIN () {
        return Pins.D0;
    }

    get DEFAULT_SERIAL_RX_PIN () {
        return Pins.D0;
    }

    get DEFAULT_SERIAL_TX_PIN () {
        return Pins.D1;
    }

    /**
      * Construct a set of Arduino blocks.
      * @param {Runtime} runtime - the OpenBlock runtime.
      * @param {string} originalDeviceId - the original id of the peripheral, like xxx_arduinoUno
      */
    constructor (runtime, originalDeviceId) {
        super(runtime, originalDeviceId);

        // Create a new Arduino Nano peripheral instance
        this._peripheral = new ArduinoK210Maixduino(this.runtime, this.DEVICE_ID, originalDeviceId);
    }
}

module.exports = OpenBlockArduinoK210MaixduinoDevice;
