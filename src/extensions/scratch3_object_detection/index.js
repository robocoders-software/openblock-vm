const ArgumentType = require('../../extension-support/argument-type');
const BlockType = require('../../extension-support/block-type');
const Cast = require('../../util/cast');
const formatMessage = require('format-message');
const Video = require('../../io/video');

const menuIconSVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect x="1" y="4" width="18" height="13" rx="2" fill="#9966FF"/><circle cx="10" cy="10.5" r="4" fill="white"/><circle cx="10" cy="10.5" r="2" fill="#9966FF"/><rect x="7" y="2" width="6" height="3" rx="1" fill="#9966FF"/><rect x="2" y="5.5" width="7" height="5" fill="none" stroke="#FFAB19" stroke-width="1.5"/></svg>';
const blockIconSVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect x="3" y="10" width="34" height="24" rx="3" fill="#9966FF"/><circle cx="20" cy="22" r="7" fill="white"/><circle cx="20" cy="22" r="4" fill="#9966FF"/><rect x="14" y="5" width="12" height="5" rx="2" fill="#9966FF"/><rect x="7" y="14" width="12" height="9" fill="none" stroke="#FFAB19" stroke-width="2.5"/></svg>';

const menuIconURI = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(menuIconSVG)}`;
const blockIconURI = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(blockIconSVG)}`;

const DETECTION_INTERVAL = 500;
const DIMENSIONS = [480, 360];

const COMMON_OBJECTS = [
    'any', 'person', 'cat', 'dog', 'car', 'bicycle', 'motorcycle',
    'bus', 'truck', 'bird', 'bottle', 'cup', 'chair', 'couch',
    'laptop', 'cell phone', 'book', 'clock', 'teddy bear', 'ball'
];

class Scratch3ObjectDetectionBlocks {
    constructor (runtime) {
        this.runtime = runtime;
        this._model = null;
        this._isModelLoading = false;
        this._isRunning = false;
        this._lastDetections = [];
        this._prevDetectedClasses = new Set();

        if (this.runtime.ioDevices) {
            this.runtime.on('PROJECT_RUN_STOP', () => this._stopDetection());
        }
    }

    get EXTENSION_ID () {
        return 'objectDetection';
    }

    async _loadModel () {
        if (this._model || this._isModelLoading) return;
        this._isModelLoading = true;
        try {
            const cocoSsd = require('@tensorflow-models/coco-ssd');
            this._model = await cocoSsd.load({base: 'lite_mobilenet_v2'});
        } catch (e) {
            console.error('[ObjectDetection] Model load failed:', e);
        } finally {
            this._isModelLoading = false;
        }
    }

    _startDetection () {
        if (this._isRunning) return;
        this._isRunning = true;
        this.runtime.ioDevices.video.enableVideo();
        this.runtime.ioDevices.video.mirror = true;
        this._loadModel();
        this._loop();
    }

    _stopDetection () {
        this._isRunning = false;
        this._lastDetections = [];
        this._prevDetectedClasses = new Set();
    }

    _loop () {
        if (!this._isRunning) return;
        setTimeout(() => this._loop(), DETECTION_INTERVAL);
        if (this._model) this._runDetection();
    }

    async _runDetection () {
        const frame = this.runtime.ioDevices.video.getFrame({
            format: Video.FORMAT_IMAGE_DATA,
            dimensions: DIMENSIONS
        });
        if (!frame) return;

        try {
            const canvas = document.createElement('canvas');
            canvas.width = frame.width;
            canvas.height = frame.height;
            canvas.getContext('2d').putImageData(frame, 0, 0);

            const predictions = await this._model.detect(canvas);

            const prevClasses = this._prevDetectedClasses;
            this._prevDetectedClasses = new Set(this._lastDetections.map(d => d.class));
            this._lastDetections = predictions;

            // fire hat blocks for newly-appeared objects
            const newClasses = new Set(predictions.map(p => p.class));
            newClasses.forEach(cls => {
                if (!prevClasses.has(cls)) {
                    this.runtime.startHats('objectDetection_whenObjectDetected', {OBJECT: cls});
                }
            });
            if (predictions.length > 0 && prevClasses.size === 0) {
                this.runtime.startHats('objectDetection_whenObjectDetected', {OBJECT: 'any'});
            }
        } catch (e) {
            // ignore per-frame errors silently
        }
    }

    getInfo () {
        return [{
            id: 'objectDetection',
            name: formatMessage({
                id: 'objectDetection.categoryName',
                default: 'Object Detection',
                description: 'Extension name'
            }),
            blockIconURI: blockIconURI,
            menuIconURI: menuIconURI,
            blocks: [
                {
                    opcode: 'startDetection',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'objectDetection.startDetection',
                        default: 'start object detection'
                    })
                },
                {
                    opcode: 'stopDetection',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'objectDetection.stopDetection',
                        default: 'stop object detection'
                    })
                },
                {
                    opcode: 'whenObjectDetected',
                    blockType: BlockType.HAT,
                    text: formatMessage({
                        id: 'objectDetection.whenObjectDetected',
                        default: 'when [OBJECT] detected'
                    }),
                    arguments: {
                        OBJECT: {
                            type: ArgumentType.STRING,
                            menu: 'OBJECT_MENU',
                            defaultValue: 'person'
                        }
                    }
                },
                {
                    opcode: 'isObjectDetected',
                    blockType: BlockType.BOOLEAN,
                    text: formatMessage({
                        id: 'objectDetection.isObjectDetected',
                        default: '[OBJECT] detected?'
                    }),
                    arguments: {
                        OBJECT: {
                            type: ArgumentType.STRING,
                            menu: 'OBJECT_MENU',
                            defaultValue: 'person'
                        }
                    }
                },
                {
                    opcode: 'detectedObjects',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'objectDetection.detectedObjects',
                        default: 'detected objects'
                    })
                },
                {
                    opcode: 'countOfObject',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'objectDetection.countOfObject',
                        default: 'count of [OBJECT] detected'
                    }),
                    arguments: {
                        OBJECT: {
                            type: ArgumentType.STRING,
                            menu: 'OBJECT_MENU',
                            defaultValue: 'person'
                        }
                    }
                },
                {
                    opcode: 'confidenceOfObject',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'objectDetection.confidenceOfObject',
                        default: 'confidence of [OBJECT] %'
                    }),
                    arguments: {
                        OBJECT: {
                            type: ArgumentType.STRING,
                            menu: 'OBJECT_MENU',
                            defaultValue: 'person'
                        }
                    }
                },
                {
                    opcode: 'detectionStatus',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'objectDetection.detectionStatus',
                        default: 'detection status'
                    })
                }
            ],
            menus: {
                OBJECT_MENU: {
                    acceptReporters: true,
                    items: COMMON_OBJECTS.map(o => ({text: o, value: o}))
                }
            }
        }];
    }

    startDetection () {
        this._startDetection();
    }

    stopDetection () {
        this._stopDetection();
    }

    whenObjectDetected (args) {
        const obj = Cast.toString(args.OBJECT).toLowerCase();
        if (obj === 'any') return this._lastDetections.length > 0;
        return this._lastDetections.some(d => d.class.toLowerCase() === obj);
    }

    isObjectDetected (args) {
        const obj = Cast.toString(args.OBJECT).toLowerCase();
        if (obj === 'any') return this._lastDetections.length > 0;
        return this._lastDetections.some(d => d.class.toLowerCase() === obj);
    }

    detectedObjects () {
        if (this._lastDetections.length === 0) return '';
        return [...new Set(this._lastDetections.map(d => d.class))].join(', ');
    }

    countOfObject (args) {
        const obj = Cast.toString(args.OBJECT).toLowerCase();
        if (obj === 'any') return this._lastDetections.length;
        return this._lastDetections.filter(d => d.class.toLowerCase() === obj).length;
    }

    confidenceOfObject (args) {
        const obj = Cast.toString(args.OBJECT).toLowerCase();
        const matches = obj === 'any'
            ? this._lastDetections
            : this._lastDetections.filter(d => d.class.toLowerCase() === obj);
        if (matches.length === 0) return 0;
        return Math.round(Math.max(...matches.map(d => d.score)) * 100);
    }

    detectionStatus () {
        if (!this._isRunning) return 'off';
        if (this._isModelLoading) return 'loading';
        if (this._model) return 'ready';
        return 'loading';
    }
}

module.exports = Scratch3ObjectDetectionBlocks;
