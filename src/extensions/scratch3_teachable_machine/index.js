const ArgumentType = require('../../extension-support/argument-type');
const BlockType = require('../../extension-support/block-type');
const Cast = require('../../util/cast');
const formatMessage = require('format-message');
const Video = require('../../io/video');

const menuIconSVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle cx="4" cy="7" r="2.5" fill="#FF8C1A"/><circle cx="4" cy="13" r="2.5" fill="#FF8C1A"/><circle cx="10" cy="4" r="2.5" fill="#FF8C1A"/><circle cx="10" cy="10" r="2.5" fill="#FF8C1A"/><circle cx="10" cy="16" r="2.5" fill="#FF8C1A"/><circle cx="16" cy="10" r="2.5" fill="#FF8C1A"/><line x1="6.5" y1="7" x2="7.5" y2="4" stroke="#FF8C1A" stroke-width="1"/><line x1="6.5" y1="7" x2="7.5" y2="10" stroke="#FF8C1A" stroke-width="1"/><line x1="6.5" y1="13" x2="7.5" y2="10" stroke="#FF8C1A" stroke-width="1"/><line x1="6.5" y1="13" x2="7.5" y2="16" stroke="#FF8C1A" stroke-width="1"/><line x1="12.5" y1="4" x2="13.5" y2="10" stroke="#FF8C1A" stroke-width="1"/><line x1="12.5" y1="10" x2="13.5" y2="10" stroke="#FF8C1A" stroke-width="1"/><line x1="12.5" y1="16" x2="13.5" y2="10" stroke="#FF8C1A" stroke-width="1"/></svg>';
const blockIconSVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="8" cy="14" r="5" fill="#FF8C1A"/><circle cx="8" cy="26" r="5" fill="#FF8C1A"/><circle cx="20" cy="8" r="5" fill="#FF8C1A"/><circle cx="20" cy="20" r="5" fill="#FF8C1A"/><circle cx="20" cy="32" r="5" fill="#FF8C1A"/><circle cx="32" cy="20" r="5" fill="#FF8C1A"/><line x1="13" y1="14" x2="15" y2="8" stroke="#FF8C1A" stroke-width="2"/><line x1="13" y1="14" x2="15" y2="20" stroke="#FF8C1A" stroke-width="2"/><line x1="13" y1="26" x2="15" y2="20" stroke="#FF8C1A" stroke-width="2"/><line x1="13" y1="26" x2="15" y2="32" stroke="#FF8C1A" stroke-width="2"/><line x1="25" y1="8" x2="27" y2="20" stroke="#FF8C1A" stroke-width="2"/><line x1="25" y1="20" x2="27" y2="20" stroke="#FF8C1A" stroke-width="2"/><line x1="25" y1="32" x2="27" y2="20" stroke="#FF8C1A" stroke-width="2"/></svg>';

const menuIconURI  = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(menuIconSVG)}`;
const blockIconURI = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(blockIconSVG)}`;

const CLASSIFY_INTERVAL = 200;
const DIMENSIONS        = [480, 360];

class Scratch3TeachableMachineBlocks {
    constructor (runtime) {
        this.runtime = runtime;
        this._isRunning    = false;
        this._predictions  = [];
        this._topClass     = '';
        this._prevTopClass = '';

        if (this.runtime.ioDevices) {
            this.runtime.on('PROJECT_RUN_STOP', () => this._stopClassifying());
        }
    }

    get EXTENSION_ID () { return 'teachableMachine'; }

    /* ── Bridge ── */
    _getLocalModel () {
        return (typeof window !== 'undefined' && window.__openblockMLModel) || null;
    }

    /* ── Dynamic label menu (reads live from loaded model) ── */
    getClassLabels () {
        const local = this._getLocalModel();
        if (local && local.labels && local.labels.length > 0) {
            return local.labels.map(l => ({text: l, value: l}));
        }
        return [{text: 'Class 1', value: 'Class 1'}, {text: 'Class 2', value: 'Class 2'}];
    }

    /* ── Continuous recognition loop ── */
    _startClassifying () {
        if (this._isRunning) return;
        this._isRunning = true;
        try {
            if (this.runtime.ioDevices && this.runtime.ioDevices.video) {
                this.runtime.ioDevices.video.enableVideo();
                this.runtime.ioDevices.video.mirror = true;
            }
        } catch (e) {
            console.warn('[ML] Video device not available:', e.message);
        }
        this._loop();
    }

    _stopClassifying () {
        this._isRunning    = false;
        this._predictions  = [];
        this._topClass     = '';
        this._prevTopClass = '';
    }

    _loop () {
        if (!this._isRunning) return;
        setTimeout(() => this._loop(), CLASSIFY_INTERVAL);
        const local = this._getLocalModel();
        if (local && local.classifier && local.mobileNet) {
            this._runClassification(local);
        }
    }

    /* ── Video frame → canvas ── */
    _getVideoCanvas () {
        try {
            const frame = this.runtime.ioDevices &&
                this.runtime.ioDevices.video &&
                this.runtime.ioDevices.video.getFrame({
                    format:     Video.FORMAT_IMAGE_DATA,
                    dimensions: DIMENSIONS
                });
            if (!frame) return null;
            const c = document.createElement('canvas');
            c.width  = frame.width;
            c.height = frame.height;
            c.getContext('2d').putImageData(frame, 0, 0);
            return c;
        } catch (_) { return null; }
    }

    /* ── Stage canvas ── */
    _getStageCanvas () {
        try {
            const renderer = this.runtime.renderer;
            if (renderer && renderer.canvas) return renderer.canvas;
        } catch (_) {}
        return this._getVideoCanvas();
    }

    /* ── Run one classification pass; update state + fire hats ── */
    async _runClassification (localModel) {
        try {
            const canvas = this._getVideoCanvas();
            if (!canvas) return;

            const logits = localModel.mobileNet.infer(canvas, true);
            const res    = await localModel.classifier.predictClass(logits);
            logits.dispose();

            const labels = localModel.labels || [];
            this._predictions = labels.map((lbl, i) => ({
                className:   lbl,
                probability: res.confidences[String(i)] !== undefined
                    ? res.confidences[String(i)]
                    : (res.confidences[i] || 0)
            }));

            if (this._predictions.length === 0) return;
            const top = this._predictions.reduce(
                (a, b) => a.probability > b.probability ? a : b,
                this._predictions[0]
            );
            this._prevTopClass = this._topClass;
            this._topClass     = top ? top.className : '';

            if (this._topClass && this._topClass !== this._prevTopClass) {
                this.runtime.startHats('teachableMachine_whenClassIs', {LABEL: this._topClass});
            }
        } catch (_) { /* non-fatal */ }
    }

    /* ── One-shot classification (used by recogniseLabel / recogniseConfidence) ── */
    async _classifyOnce (source) {
        const local = this._getLocalModel();
        if (!local || !local.classifier || !local.mobileNet) return null;

        // Enable video silently if needed so the frame is available
        try {
            if (this.runtime.ioDevices && this.runtime.ioDevices.video) {
                this.runtime.ioDevices.video.enableVideo();
            }
        } catch (_) {}

        const canvas = (source === 'stage') ? this._getStageCanvas() : this._getVideoCanvas();
        if (!canvas) return null;

        try {
            const logits = local.mobileNet.infer(canvas, true);
            const res    = await local.classifier.predictClass(logits);
            logits.dispose();

            const labels      = local.labels || [];
            const predictions = labels.map((lbl, i) => ({
                className:   lbl,
                probability: res.confidences[String(i)] !== undefined
                    ? res.confidences[String(i)]
                    : (res.confidences[i] || 0)
            }));
            return {res, predictions};
        } catch (_) { return null; }
    }

    /* ── Block definitions ── */
    getInfo () {
        return [{
            id: 'teachableMachine',
            name: formatMessage({
                id:          'teachableMachine.categoryName',
                default:     'Machine Learning',
                description: 'Extension category name'
            }),
            blockIconURI,
            menuIconURI,
            blocks: [
                /* ── One-shot recognition (ML-for-Kids style) ── */
                {
                    opcode:    'recogniseLabel',
                    blockType: BlockType.REPORTER,
                    text:      formatMessage({
                        id:      'teachableMachine.recogniseLabel',
                        default: 'recognise image from [SOURCE] (label)'
                    }),
                    arguments: {
                        SOURCE: {
                            type:         ArgumentType.STRING,
                            menu:         'SOURCE_MENU',
                            defaultValue: 'web camera'
                        }
                    }
                },
                {
                    opcode:    'recogniseConfidence',
                    blockType: BlockType.REPORTER,
                    text:      formatMessage({
                        id:      'teachableMachine.recogniseConfidence',
                        default: 'recognise image from [SOURCE] (confidence %)'
                    }),
                    arguments: {
                        SOURCE: {
                            type:         ArgumentType.STRING,
                            menu:         'SOURCE_MENU',
                            defaultValue: 'web camera'
                        }
                    }
                },

                '---',

                /* ── Continuous recognition ── */
                {
                    opcode:    'openRecognitionWindow',
                    blockType: BlockType.COMMAND,
                    text:      formatMessage({
                        id:      'teachableMachine.openRecognitionWindow',
                        default: 'start recognition'
                    })
                },
                {
                    opcode:    'stopRecognition',
                    blockType: BlockType.COMMAND,
                    text:      formatMessage({
                        id:      'teachableMachine.stopRecognition',
                        default: 'stop recognition'
                    })
                },
                {
                    opcode:    'toggleVideo',
                    blockType: BlockType.COMMAND,
                    text:      formatMessage({
                        id:      'teachableMachine.toggleVideo',
                        default: 'turn video [ONOFF] on stage'
                    }),
                    arguments: {
                        ONOFF: {
                            type:         ArgumentType.STRING,
                            menu:         'ONOFF_MENU',
                            defaultValue: 'on'
                        }
                    }
                },

                '---',

                /* ── Live result reporters ── */
                {
                    opcode:    'identifiedClass',
                    blockType: BlockType.REPORTER,
                    text:      formatMessage({
                        id:      'teachableMachine.identifiedClass',
                        default: 'identified class'
                    })
                },
                {
                    opcode:    'getConfidenceOfClass',
                    blockType: BlockType.REPORTER,
                    text:      formatMessage({
                        id:      'teachableMachine.getConfidenceOfClass',
                        default: 'confidence of class [LABEL] %'
                    }),
                    arguments: {
                        LABEL: {
                            type:         ArgumentType.STRING,
                            menu:         'CLASS_LABEL',
                            defaultValue: 'Class 1'
                        }
                    }
                },
                {
                    opcode:    'isIdentifiedClass',
                    blockType: BlockType.BOOLEAN,
                    text:      formatMessage({
                        id:      'teachableMachine.isIdentifiedClass',
                        default: 'is identified class [LABEL] ?'
                    }),
                    arguments: {
                        LABEL: {
                            type:         ArgumentType.STRING,
                            menu:         'CLASS_LABEL',
                            defaultValue: 'Class 1'
                        }
                    }
                },
                {
                    opcode:    'whenClassIs',
                    blockType: BlockType.HAT,
                    text:      formatMessage({
                        id:      'teachableMachine.whenClassIs',
                        default: 'when [LABEL] is predicted'
                    }),
                    arguments: {
                        LABEL: {
                            type:         ArgumentType.STRING,
                            menu:         'CLASS_LABEL',
                            defaultValue: 'Class 1'
                        }
                    }
                },

                '---',

                /* ── Per-class label reporters (ML-for-Kids pattern) ── */
                {
                    opcode:    'getLabelName',
                    blockType: BlockType.REPORTER,
                    text:      formatMessage({
                        id:      'teachableMachine.getLabelName',
                        default: 'label [LABEL]'
                    }),
                    arguments: {
                        LABEL: {
                            type:         ArgumentType.STRING,
                            menu:         'CLASS_LABEL',
                            defaultValue: 'Class 1'
                        }
                    }
                },

                '---',

                /* ── In-blocks training (ML-for-Kids addTraining / trainNewModel pattern) ── */
                {
                    opcode:    'addTrainingImage',
                    blockType: BlockType.COMMAND,
                    text:      formatMessage({
                        id:      'teachableMachine.addTrainingImage',
                        default: 'add training image from [SOURCE] as [LABEL]'
                    }),
                    arguments: {
                        SOURCE: {
                            type:         ArgumentType.STRING,
                            menu:         'SOURCE_MENU',
                            defaultValue: 'web camera'
                        },
                        LABEL: {
                            type:         ArgumentType.STRING,
                            menu:         'CLASS_LABEL',
                            defaultValue: 'Class 1'
                        }
                    }
                },
                {
                    opcode:    'trainNewModel',
                    blockType: BlockType.COMMAND,
                    text:      formatMessage({
                        id:      'teachableMachine.trainNewModel',
                        default: 'train new machine learning model'
                    })
                },
                {
                    opcode:    'clearTrainingData',
                    blockType: BlockType.COMMAND,
                    text:      formatMessage({
                        id:      'teachableMachine.clearTrainingData',
                        default: 'clear all training data'
                    })
                },
                {
                    opcode:    'isTrainingStatus',
                    blockType: BlockType.BOOLEAN,
                    text:      formatMessage({
                        id:      'teachableMachine.isTrainingStatus',
                        default: 'is training [STATUS] ?'
                    }),
                    arguments: {
                        STATUS: {
                            type:         ArgumentType.STRING,
                            menu:         'TRAIN_STATUS_MENU',
                            defaultValue: 'ready'
                        }
                    }
                },

                '---',

                /* ── Model status (ML-for-Kids checkModelStatus pattern) ── */
                {
                    opcode:    'checkModelStatus',
                    blockType: BlockType.BOOLEAN,
                    text:      formatMessage({
                        id:      'teachableMachine.checkModelStatus',
                        default: 'is the model [STATUS] ?'
                    }),
                    arguments: {
                        STATUS: {
                            type:         ArgumentType.STRING,
                            menu:         'STATUS_MENU',
                            defaultValue: 'ready'
                        }
                    }
                },
                {
                    opcode:    'modelStatus',
                    blockType: BlockType.REPORTER,
                    text:      formatMessage({
                        id:      'teachableMachine.modelStatus',
                        default: 'model status'
                    })
                }
            ],
            menus: {
                CLASS_LABEL: {
                    acceptReporters: true,
                    items: 'getClassLabels'
                },
                SOURCE_MENU: {
                    acceptReporters: false,
                    items: [
                        {text: 'web camera', value: 'web camera'},
                        {text: 'stage',      value: 'stage'}
                    ]
                },
                ONOFF_MENU: {
                    acceptReporters: false,
                    items: [
                        {text: 'on',  value: 'on'},
                        {text: 'off', value: 'off'}
                    ]
                },
                STATUS_MENU: {
                    acceptReporters: false,
                    items: [
                        {text: 'ready',      value: 'ready'},
                        {text: 'loading',    value: 'loading'},
                        {text: 'not loaded', value: 'not loaded'}
                    ]
                },
                TRAIN_STATUS_MENU: {
                    acceptReporters: false,
                    items: [
                        {text: 'ready',    value: 'ready'},
                        {text: 'training', value: 'training'},
                        {text: 'idle',     value: 'idle'}
                    ]
                }
            }
        }];
    }

    /* ── Block implementations ── */

    /* One-shot: classify now, return label */
    async recogniseLabel (args) {
        const result = await this._classifyOnce(Cast.toString(args.SOURCE));
        if (!result || !result.predictions.length) return 'unknown';
        const top = result.predictions.reduce((a, b) => a.probability > b.probability ? a : b);
        return top.className;
    }

    /* One-shot: classify now, return confidence % */
    async recogniseConfidence (args) {
        const result = await this._classifyOnce(Cast.toString(args.SOURCE));
        if (!result || !result.predictions.length) return 0;
        const top = result.predictions.reduce((a, b) => a.probability > b.probability ? a : b);
        return Math.round(top.probability * 100);
    }

    /* Continuous recognition */
    openRecognitionWindow () { this._startClassifying(); }
    stopRecognition ()       { this._stopClassifying(); }

    toggleVideo (args) {
        const on = Cast.toString(args.ONOFF) === 'on';
        try {
            if (this.runtime.ioDevices && this.runtime.ioDevices.video) {
                on ? this.runtime.ioDevices.video.enableVideo()
                   : this.runtime.ioDevices.video.disableVideo();
            }
        } catch (_) {}
    }

    /* Live result reporters */
    identifiedClass ()      { return this._topClass; }

    isIdentifiedClass (args) {
        return this._topClass.toLowerCase() === Cast.toString(args.LABEL).toLowerCase();
    }

    getConfidenceOfClass (args) {
        const label = Cast.toString(args.LABEL).toLowerCase();
        const match = this._predictions.find(p => p.className.toLowerCase() === label);
        return match ? Math.round((match.probability || 0) * 100) : 0;
    }

    whenClassIs (args) {
        return this._topClass.toLowerCase() === Cast.toString(args.LABEL).toLowerCase();
    }

    /* Per-class label reporter — returns the label string itself (useful in string joins) */
    getLabelName (args) { return Cast.toString(args.LABEL); }

    /* ── In-blocks training (ML-for-Kids addTraining / trainNewModel pattern) ── */

    /* Capture one frame and add it to training data for LABEL */
    async addTrainingImage (args) {
        const local = this._getLocalModel();
        if (!local || !local._trainingAPI) return;
        const api = local._trainingAPI.current;
        if (!api || !api.addTrainingImage) return;

        try {
            if (this.runtime.ioDevices && this.runtime.ioDevices.video) {
                this.runtime.ioDevices.video.enableVideo();
            }
        } catch (_) {}

        const src    = Cast.toString(args.SOURCE);
        const label  = Cast.toString(args.LABEL);
        const canvas = (src === 'stage') ? this._getStageCanvas() : this._getVideoCanvas();
        if (!canvas) return;

        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        await api.addTrainingImage(label, [dataUrl]);
    }

    /* Trigger training — returns a Promise, block waits until training finishes */
    async trainNewModel () {
        const local = this._getLocalModel();
        if (!local || !local._trainingAPI) return;
        const api = local._trainingAPI.current;
        if (!api || !api.startTraining) return;
        await api.startTraining();
    }

    /* Clear all collected training images */
    clearTrainingData () {
        const local = this._getLocalModel();
        if (!local || !local._trainingAPI) return;
        const api = local._trainingAPI.current;
        if (api && api.clearTraining) api.clearTraining();
    }

    /* Check training status: ready / training / idle */
    isTrainingStatus (args) {
        const local  = this._getLocalModel();
        const target = Cast.toString(args.STATUS).toLowerCase();
        if (!local) return target === 'idle';
        if (local._trainingAPI) {
            const api = local._trainingAPI.current;
            const status = (api && api.getStatus) ? api.getStatus() : (local.trainingStatus || 'idle');
            return status.toLowerCase() === target;
        }
        return (local.trainingStatus || 'idle').toLowerCase() === target;
    }

    /* Model status */
    checkModelStatus (args) {
        const local  = this._getLocalModel();
        const status = Cast.toString(args.STATUS).toLowerCase();
        if (status === 'ready')      return !!(local && local.classifier && local.mobileNet);
        if (status === 'loading')    return !!(local && !(local.classifier && local.mobileNet));
        /* 'not loaded' */           return !local;
    }

    modelStatus () {
        const local = this._getLocalModel();
        if (!local)                             return 'no model loaded';
        if (local.classifier && local.mobileNet) return `ready: ${local.projectName || 'model'}`;
        return 'loading';
    }
}

module.exports = Scratch3TeachableMachineBlocks;
