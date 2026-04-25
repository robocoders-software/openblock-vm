const OpenBlockMicrobitDevice = require('./microbit');

/**
  * OpenBlock blocks to interact with a Microbit V2 peripheral.
  */
class OpenBlockMicrobitV2Device extends OpenBlockMicrobitDevice{

    /**
      * @return {string} - the ID of this extension.
      */
    get DEVICE_ID () {
        return 'microbitV2';
    }
}

module.exports = OpenBlockMicrobitV2Device;
