/**
 * Default types of program mode supported by the VM
 * @enum {string}
 */
const ProgramModeType = {
    /**
     * Rendered target which can move, change costumes, etc.
     */
    REALTIME: 'realtime',

    /**
     * Rendered target which cannot move but can change backdrops
     */
    UPLOAD: 'upload'
};

module.exports = ProgramModeType;
