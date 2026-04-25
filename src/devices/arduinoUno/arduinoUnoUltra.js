/**
 * Arduino Uno Ultra
 *
 * @overview Compared with Arduino Uno, there are more A6 and A7 pin options for
 * those customized board.
 */
const OpenBlockArduinoUnoDevice = require('./arduinoUno');

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
    A0: 'A0',
    A1: 'A1',
    A2: 'A2',
    A3: 'A3',
    A4: 'A4',
    A5: 'A5',
    A6: 'A6',
    A7: 'A7'
};

/**
 * OpenBlock blocks to interact with a Arduino Uno Ultra peripheral.
 */
class OpenBlockArduinoUnoUltraDevice extends OpenBlockArduinoUnoDevice{

    /**
     * @return {string} - the ID of this extension.
     */
    get DEVICE_ID () {
        return 'arduinoUnoUltra';
    }

    get ANALOG_PINS_MENU () {
        return [
            {
                text: 'A0',
                value: Pins.A0
            },
            {
                text: 'A1',
                value: Pins.A1
            },
            {
                text: 'A2',
                value: Pins.A2
            },
            {
                text: 'A3',
                value: Pins.A3
            },
            {
                text: 'A4',
                value: Pins.A4
            },
            {
                text: 'A5',
                value: Pins.A5
            },
            {
                text: 'A6',
                value: Pins.A6
            },
            {
                text: 'A7',
                value: Pins.A7
            }
        ];
    }
}

module.exports = OpenBlockArduinoUnoUltraDevice;
