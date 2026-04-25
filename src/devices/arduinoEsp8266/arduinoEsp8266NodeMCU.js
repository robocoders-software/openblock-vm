const CommonPeripheral = require('../common/common-peripheral');

const OpenBlockArduinoEsp8266Device = require('./arduinoEsp8266');

/**
 * The list of USB device filters.
 * @readonly
 */
const PNPID_LIST = [
    // CH340
    'USB\\VID_1A86&PID_7523',
    // CP2102
    'USB\\VID_10C4&PID_EA60'

];

/**
 * Configuration of serialport
 * @readonly
 */
const SERIAL_CONFIG = {
    baudRate: 57600,
    dataBits: 8,
    stopBits: 1
};

/**
 * Configuration of build and flash. Used by arduino-cli.
 * @readonly
 */
const DIVECE_OPT = {
    type: 'arduino',
    fqbn: {
        darwin: 'esp8266:esp8266:generic:baud=460800',
        linux: 'esp8266:esp8266:generic:baud=460800',
        win32: 'esp8266:esp8266:generic:baud=921600'
    }
};


const Pins = {
    D0: '16',
    D1: '5',
    D2: '4',
    D3: '0',
    D4: '2',
    D5: '14',
    D6: '12',
    D7: '13',
    D8: '15',
    RX: '3',
    TX: '1',
    SD2: '9',
    SD3: '10',
    A0: 'A0'
};

/**
 * Manage communication with a Arduino Esp8266 peripheral over a OpenBlock Link client socket.
 */
class ArduinoEsp8266NodeMCU extends CommonPeripheral{
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
 * OpenBlock blocks to interact with a Arduino Esp8266 peripheral.
 */
class OpenBlockArduinoEsp8266NodeMCUDevice extends OpenBlockArduinoEsp8266Device{

    /**
     * @return {string} - the ID of this extension.
     */
    get DEVICE_ID () {
        return 'arduinoEsp8266NodeMCU';
    }

    get PINS_MENU () {
        return [
            {
                text: 'D0',
                value: Pins.D0
            },
            {
                text: 'D1',
                value: Pins.D1
            },
            {
                text: 'D2',
                value: Pins.D2
            },
            {
                text: 'D3',
                value: Pins.D3
            },
            {
                text: 'D4',
                value: Pins.D4
            },
            {
                text: 'D5',
                value: Pins.D5
            },
            {
                text: 'D6',
                value: Pins.D6
            },
            {
                text: 'D7',
                value: Pins.D7
            },
            {
                text: 'D8',
                value: Pins.D8
            },
            {
                text: 'RX',
                value: Pins.RX
            },
            {
                text: 'TX',
                value: Pins.TX
            },
            {
                text: 'A0',
                value: Pins.A0
            }
        ];
    }

    get DIGITAL_PINS_MENU () {
        return [
            {
                text: 'D0',
                value: Pins.D0
            },
            {
                text: 'D1',
                value: Pins.D1
            },
            {
                text: 'D2',
                value: Pins.D2
            },
            {
                text: 'D3',
                value: Pins.D3
            },
            {
                text: 'D4',
                value: Pins.D4
            },
            {
                text: 'D5',
                value: Pins.D5
            },
            {
                text: 'D6',
                value: Pins.D6
            },
            {
                text: 'D7',
                value: Pins.D7
            },
            {
                text: 'D8',
                value: Pins.D8
            },
            {
                text: 'RX',
                value: Pins.RX
            },
            {
                text: 'TX',
                value: Pins.TX
            }
        ];
    }

    get DEFAULT_DIGITAL_PIN () {
        return Pins.D0;
    }

    get ANALOG_PINS_MENU () {
        return [
            {
                text: 'A0',
                value: Pins.A0
            }
        ];
    }

    get PWM_AND_INTERRUPT_PINS_MENU () {
        return [
            {
                text: 'D1',
                value: Pins.D1
            },
            {
                text: 'D2',
                value: Pins.D2
            },
            {
                text: 'D3',
                value: Pins.D3
            },
            {
                text: 'D4',
                value: Pins.D4
            },
            {
                text: 'D5',
                value: Pins.D5
            },
            {
                text: 'D6',
                value: Pins.D6
            },
            {
                text: 'D7',
                value: Pins.D7
            },
            {
                text: 'D8',
                value: Pins.D8
            },
            {
                text: 'RX',
                value: Pins.RX
            },
            {
                text: 'TX',
                value: Pins.TX
            }
        ];
    }

    get DEFAULT_PWM_AND_INTERRUPT_PIN () {
        return Pins.D1;
    }

    /**
     * Construct a set of Arduino blocks.
     * @param {Runtime} runtime - the OpenBlock runtime.
     * @param {string} originalDeviceId - the original id of the peripheral, like xxx_arduinoUno
     */
    constructor (runtime, originalDeviceId) {
        super(runtime, originalDeviceId);

        // Create a new Arduino esp8266 NodeMCU peripheral instance
        this._peripheral = new ArduinoEsp8266NodeMCU(this.runtime, this.DEVICE_ID, originalDeviceId);
    }
}

module.exports = OpenBlockArduinoEsp8266NodeMCUDevice;
