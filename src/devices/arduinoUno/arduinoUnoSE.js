/**
 * Arduino Uno SE
 *
 * @overview Compared to the Arduino Uno, this control board does not contain
 * any basic hardware blocks. This is used as a mothor board for those custom
 * control boards that do not use standard interfaces.
 */
const OpenBlockArduinoUnoDevice = require('./arduinoUno');

/**
 * OpenBlock blocks to interact with a Arduino Uno SE peripheral.
 */
class OpenBlockArduinoUnoSEDevice extends OpenBlockArduinoUnoDevice{

    /**
     * @return {string} - the ID of this extension.
     */
    get DEVICE_ID () {
        return 'arduinoUnoSE';
    }

    /**
     * @returns {Array.<object>} metadata for this extension and its blocks.
     */
    getInfo () {
        return [];
    }
}

module.exports = OpenBlockArduinoUnoSEDevice;
