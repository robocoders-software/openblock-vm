const OpenBlockArduinoK210Device = require('./arduinoK210');

/**
  * OpenBlock blocks to interact with a Arduino Maix Dock peripheral.
  */
class OpenBlockArduinoK210MaixDockDevice extends OpenBlockArduinoK210Device{

    /**
      * @return {string} - the ID of this extension.
      */
    get DEVICE_ID () {
        return 'arduinoK210MaixDock';
    }
}

module.exports = OpenBlockArduinoK210MaixDockDevice;
