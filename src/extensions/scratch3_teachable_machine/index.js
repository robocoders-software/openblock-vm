const ArgumentType = require('../../extension-support/argument-type');
const BlockType = require('../../extension-support/block-type');
const Cast = require('../../util/cast');
const formatMessage = require('format-message');
const Video = require('../../io/video');
const {loadCostumeFromAsset} = require('../../import/load-costume');

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

        this._audioListening   = false;
        this._audioTopClass    = '';
        this._audioPrevTop     = '';
        this._audioPredictions = [];

        this._textTopClass    = '';
        this._textPredictions = [];

        this._lastModelType    = undefined; // undefined = never checked yet
        this._lastModelKey     = undefined; // projectId:type composite key
        this._toolboxRefreshTimer = null;  // debounce handle

        if (this.runtime.ioDevices) {
            this.runtime.on('PROJECT_RUN_STOP', () => this._stopAll());
        }

        this._startModelWatcher();
    }

    /* ── Debounced toolbox refresh — collapses multiple rapid model changes into one emit ── */
    _scheduleToolboxRefresh () {
        if (this._toolboxRefreshTimer) return; // already pending
        this._toolboxRefreshTimer = setTimeout(() => {
            this._toolboxRefreshTimer = null;
            try { this.runtime.emit('TOOLBOX_EXTENSIONS_NEED_UPDATE'); } catch (_) {}
        }, 80);
    }

    /* ── Watch for model identity/type changes and refresh the block palette ── */
    _startModelWatcher () {
        // Capture initial model state synchronously so the 200ms poller doesn't see
        // a false "change" on its first tick and trigger a duplicate refresh.
        const local0  = this._getLocalModel();
        const type0   = local0 ? (local0.type || 'images') : null;
        const id0     = local0 ? (local0.projectId || null) : null;
        const labels0 = local0 ? (local0.labels || []).join(',') : '';
        this._lastModelKey  = type0 ? `${id0}:${type0}:${labels0}` : null;
        this._lastModelType = type0;

        // One initial refresh so the toolbox matches the model already in memory.
        // (getInfo() was called once during registration — this ensures the palette
        //  is correct for whatever model type is currently active.)
        this._scheduleToolboxRefresh();

        // Poll for model identity, type, OR label changes and refresh when anything changes.
        setInterval(() => {
            const local  = this._getLocalModel();
            const type   = local ? (local.type || 'images') : null;
            const id     = local ? (local.projectId || null) : null;
            const labels = local ? (local.labels || []).join(',') : '';
            const key    = type ? `${id}:${type}:${labels}` : null;
            if (key !== this._lastModelKey) {
                this._lastModelKey  = key;
                this._lastModelType = type;
                this._scheduleToolboxRefresh();
            }
        }, 200);
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

    _stopAll () {
        this._stopClassifying();
        this._textTopClass    = '';
        this._textPredictions = [];
        if (this._audioListening) {
            this._audioListening   = false;
            this._audioTopClass    = '';
            this._audioPredictions = [];
            const local = this._getLocalModel();
            if (local && local.stopListening) local.stopListening().catch(() => {});
        }
        // Turn off the camera when the project stops so the webcam isn't left open
        try {
            if (this.runtime.ioDevices && this.runtime.ioDevices.video) {
                this.runtime.ioDevices.video.disableVideo();
            }
        } catch (_) {}
    }

    _loop () {
        if (!this._isRunning) return;
        setTimeout(() => this._loop(), CLASSIFY_INTERVAL);
        const local = this._getLocalModel();
        if (!local || local.type === 'sounds' || local.type === 'text') return;
        if (local.classifier && local.mobileNet) {
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
    // Returns a Promise<HTMLCanvasElement|null> — always 480×360 logical stage size.
    // Uses renderer.requestSnapshot (fires inside draw() before the GL buffer is cleared)
    // which gives consistent sRGB pixel values regardless of HiDPI device-pixel-ratio.
    _getStageCanvas () {
        const renderer = this.runtime && this.runtime.renderer;
        if (!renderer) return Promise.resolve(null);

        // Primary: requestSnapshot fires within draw(), guaranteeing a valid buffer read
        if (typeof renderer.requestSnapshot === 'function') {
            return new Promise(resolve => {
                let settled = false;
                const done = canvas => { if (!settled) { settled = true; resolve(canvas); } };

                renderer.requestSnapshot(dataUrl => {
                    if (!dataUrl) { done(null); return; }
                    const img = new Image();
                    img.onload = () => {
                        try {
                            const c = document.createElement('canvas');
                            c.width  = 480;
                            c.height = 360;
                            c.getContext('2d', {willReadFrequently: true})
                                .drawImage(img, 0, 0, 480, 360);
                            done(c);
                        } catch (_) { done(null); }
                    };
                    img.onerror = () => done(null);
                    img.src = dataUrl;
                });

                // Trigger draw() now so the snapshot callback fires immediately
                try { if (typeof renderer.draw === 'function') renderer.draw(); }
                catch (_) {}

                // Fallback: if draw() never fired the callback, resolve with null
                setTimeout(() => done(null), 500);
            });
        }

        // Fallback: direct drawImage from WebGL canvas, always scaled to 480×360
        return new Promise(resolve => {
            try {
                if (!renderer.canvas) { resolve(null); return; }
                if (typeof renderer.draw === 'function') renderer.draw();
                const src = renderer.canvas;
                const dst = document.createElement('canvas');
                dst.width  = 480;
                dst.height = 360;
                dst.getContext('2d', {willReadFrequently: true})
                    .drawImage(src, 0, 0, 480, 360);
                resolve(dst);
            } catch (_) { resolve(null); }
        });
    }

    /* ── Run one classification pass; update state + fire hats ── */
    async _runClassification (localModel) {
        try {
            const canvas = this._getVideoCanvas();
            if (!canvas) return;

            const logits = localModel.mobileNet.infer(canvas, true);
            const res    = await localModel.classifier.predictClass(logits);
            logits.dispose();

            // Build predictions array for getConfidenceOfClass lookups (by label name).
            // Use local.labels for display; top class comes directly from wrapHead
            // which uses the training labels — robust to any local.labels drift.
            const labels = localModel.labels || [];
            this._predictions = labels.map((lbl, i) => ({
                className:   lbl,
                probability: res.confidences[String(i)] !== undefined
                    ? res.confidences[String(i)]
                    : (res.confidences[i] || 0)
            }));

            this._prevTopClass = this._topClass;
            this._topClass     = res.label || '';

            if (this._topClass && this._topClass !== this._prevTopClass) {
                this.runtime.startHats('teachableMachine_whenClassIs', {LABEL: this._topClass});
            }
        } catch (_) { /* non-fatal */ }
    }

    /* ── Costume canvas — reads raw asset bytes, bypasses WebGL entirely ──
       Same approach as ML for Kids: costume.asset.encodeDataURI() gives the
       exact pixels that were stored when the costume was imported, with no
       GPU color-pipeline changes. This makes the input match training images. ── */
    async _getCostumeCanvas (util) {
        try {
            const target = util && util.target;
            if (!target) return null;

            const costume = typeof target.getCurrentCostume === 'function'
                ? target.getCurrentCostume()
                : (target.sprite && target.sprite.costumes
                    ? target.sprite.costumes[target.currentCostume]
                    : null);
            if (!costume) return null;

            let dataUrl = null;
            if (costume.asset && typeof costume.asset.encodeDataURI === 'function') {
                dataUrl = costume.asset.encodeDataURI();
            } else if (costume.assetId && this.runtime.storage) {
                const stored = this.runtime.storage.builtinHelper &&
                    this.runtime.storage.builtinHelper.get(costume.assetId);
                if (stored) {
                    const bytes = new Uint8Array(stored.data);
                    const b64   = btoa(bytes.reduce((s, b) => s + String.fromCharCode(b), ''));
                    const mime  = stored.dataFormat === 'jpg' ? 'jpeg' : stored.dataFormat;
                    dataUrl = `data:image/${mime};base64,${b64}`;
                }
            }
            if (!dataUrl) return null;

            return new Promise(resolve => {
                const img = new Image();
                img.onload = () => {
                    try {
                        const c = document.createElement('canvas');
                        c.width  = img.naturalWidth  || 224;
                        c.height = img.naturalHeight || 224;
                        c.getContext('2d', {willReadFrequently: true}).drawImage(img, 0, 0);
                        resolve(c);
                    } catch (_) { resolve(null); }
                };
                img.onerror = () => resolve(null);
                img.src = dataUrl;
            });
        } catch (_) { return null; }
    }

    /* ── Backdrop canvas — reads raw asset bytes for the current stage backdrop ── */
    async _getBackdropCanvas () {
        try {
            const stage = this.runtime.getTargetForStage && this.runtime.getTargetForStage();
            if (!stage) return null;
            const costumes = stage.getCostumes ? stage.getCostumes()
                : (stage.sprite && stage.sprite.costumes);
            if (!costumes || !costumes.length) return null;
            const backdrop = costumes[
                typeof stage.currentCostume === 'number' ? stage.currentCostume : 0
            ];
            if (!backdrop) return null;
            let dataUrl = null;
            if (backdrop.asset && typeof backdrop.asset.encodeDataURI === 'function') {
                dataUrl = backdrop.asset.encodeDataURI();
            }
            if (!dataUrl) return null;
            return new Promise(resolve => {
                const img = new Image();
                img.onload = () => {
                    try {
                        const c = document.createElement('canvas');
                        c.width  = img.naturalWidth  || 480;
                        c.height = img.naturalHeight || 360;
                        c.getContext('2d', {willReadFrequently: true}).drawImage(img, 0, 0);
                        resolve(c);
                    } catch (_) { resolve(null); }
                };
                img.onerror = () => resolve(null);
                img.src = dataUrl;
            });
        } catch (_) { return null; }
    }

    /* ── Classify from a data URL string (produced by the Images category blocks) ── */
    async _classifyFromDataUrl (dataUrl) {
        const local = this._getLocalModel();
        if (!local || !local.classifier || !local.mobileNet) return null;
        if (!dataUrl || !String(dataUrl).startsWith('data:')) return null;
        return new Promise(resolve => {
            const img = new Image();
            img.onload = async () => {
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width  = img.naturalWidth  || 224;
                    canvas.height = img.naturalHeight || 224;
                    canvas.getContext('2d', {willReadFrequently: true}).drawImage(img, 0, 0);
                    const logits      = local.mobileNet.infer(canvas, true);
                    const res         = await local.classifier.predictClass(logits);
                    logits.dispose();
                    const labels      = local.labels || [];
                    const predictions = labels.map((lbl, i) => ({
                        className:   lbl,
                        probability: res.confidences[String(i)] !== undefined
                            ? res.confidences[String(i)]
                            : (res.confidences[i] || 0)
                    }));
                    resolve({res, predictions});
                } catch (_) { resolve(null); }
            };
            img.onerror = () => resolve(null);
            img.src = String(dataUrl);
        });
    }

    /* ── One-shot classification (used by recogniseLabel / recogniseConfidence) ── */
    async _classifyOnce (source, util) {
        const local = this._getLocalModel();
        if (!local || !local.classifier || !local.mobileNet) return null;

        // 'costume' reads raw asset bytes from the current sprite — most reliable for
        //  classifying a sprite whose costume IS the image to recognise.
        // 'stage'   captures the rendered WebGL stage, including any active video layer.
        //           Re-calls enableVideo() only if video is already enabled, so the
        //           video skin stays in the renderer's draw list (Scratch removes it
        //           from the draw list if enableVideo() stops being called).
        // 'web camera' enables the webcam and reads a raw frame from the physical camera.
        let canvas;
        if (source === 'costume') {
            canvas = await this._getCostumeCanvas(util);
        } else if (source === 'stage') {
            // Keep video alive on stage if it was already enabled by a previous webcam call
            try {
                const vid = this.runtime.ioDevices && this.runtime.ioDevices.video;
                if (vid && vid.enabled) vid.enableVideo();
            } catch (_) {}
            canvas = await this._getStageCanvas();
        } else {
            try {
                if (this.runtime.ioDevices && this.runtime.ioDevices.video) {
                    this.runtime.ioDevices.video.enableVideo();
                }
            } catch (_) {}
            canvas = this._getVideoCanvas();
        }
        if (!canvas) return null;

        try {
            const logits = local.mobileNet.infer(canvas, true);
            const res    = await local.classifier.predictClass(logits);
            logits.dispose();

            // res.label comes from wrapHead which uses the saved training labels — always correct.
            // Build predictions array only for confidence lookups by class name.
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

    /* ── Block definitions (type-aware: only show blocks for the loaded model type) ── */
    getInfo () {
        const local        = this._getLocalModel();
        const modelType    = local ? (local.type || 'image') : null;
        const isImageModel = (modelType === 'image' || modelType === 'images');

        /* Blocks shown for every model type */
        const commonBlocks = [
            '---',
            {
                opcode:    'checkModelStatus',
                blockType: BlockType.BOOLEAN,
                text:      formatMessage({id: 'teachableMachine.checkModelStatus', default: 'is the model [STATUS] ?'}),
                arguments: {
                    STATUS: {type: ArgumentType.STRING, menu: 'STATUS_MENU', defaultValue: 'ready'}
                }
            },
            {
                opcode:    'modelStatus',
                blockType: BlockType.REPORTER,
                text:      formatMessage({id: 'teachableMachine.modelStatus', default: 'model status'})
            }
        ];

        /* Per-label reporter blocks — shared between image and text models */
        const allLabels = (local && local.labels && local.labels.length > 0)
            ? local.labels : ['Class 1', 'Class 2'];
        allLabels.forEach((label, idx) => { this[`returnLabel_${idx}`] = () => label; });
        const labelReturnBlocks = allLabels.map((label, idx) => ({
            opcode:    `returnLabel_${idx}`,
            blockType: BlockType.REPORTER,
            text:      label
        }));

        /* Image-model blocks — classify blocks accept IMAGE data URL from Images category */
        const imageBlocks = [
            {
                opcode:    'recogniseLabel',
                blockType: BlockType.REPORTER,
                text:      formatMessage({id: 'teachableMachine.recogniseLabel', default: 'recognise image [IMAGE] (label)'}),
                arguments: {IMAGE: {type: ArgumentType.STRING, defaultValue: 'image'}}
            },
            {
                opcode:    'recogniseConfidence',
                blockType: BlockType.REPORTER,
                text:      formatMessage({id: 'teachableMachine.recogniseConfidence', default: 'recognise image [IMAGE] (confidence %)'}),
                arguments: {IMAGE: {type: ArgumentType.STRING, defaultValue: 'image'}}
            },
            '---',
            {
                opcode:    'openRecognitionWindow',
                blockType: BlockType.COMMAND,
                text:      formatMessage({id: 'teachableMachine.openRecognitionWindow', default: 'start recognition'})
            },
            {
                opcode:    'stopRecognition',
                blockType: BlockType.COMMAND,
                text:      formatMessage({id: 'teachableMachine.stopRecognition', default: 'stop recognition'})
            },
            {
                opcode:    'toggleVideo',
                blockType: BlockType.COMMAND,
                text:      formatMessage({id: 'teachableMachine.toggleVideo', default: 'turn video [ONOFF] on stage'}),
                arguments: {ONOFF: {type: ArgumentType.STRING, menu: 'ONOFF_MENU', defaultValue: 'on'}}
            },
            '---',
            {
                opcode:    'identifiedClass',
                blockType: BlockType.REPORTER,
                text:      formatMessage({id: 'teachableMachine.identifiedClass', default: 'identified class'})
            },
            {
                opcode:    'getConfidenceOfClass',
                blockType: BlockType.REPORTER,
                text:      formatMessage({id: 'teachableMachine.getConfidenceOfClass', default: 'confidence of class [LABEL] %'}),
                arguments: {LABEL: {type: ArgumentType.STRING, menu: 'CLASS_LABEL', defaultValue: 'Class 1'}}
            },
            {
                opcode:    'isIdentifiedClass',
                blockType: BlockType.BOOLEAN,
                text:      formatMessage({id: 'teachableMachine.isIdentifiedClass', default: 'is identified class [LABEL] ?'}),
                arguments: {LABEL: {type: ArgumentType.STRING, menu: 'CLASS_LABEL', defaultValue: 'Class 1'}}
            },
            {
                opcode:    'whenClassIs',
                blockType: BlockType.HAT,
                text:      formatMessage({id: 'teachableMachine.whenClassIs', default: 'when [LABEL] is predicted'}),
                arguments: {LABEL: {type: ArgumentType.STRING, menu: 'CLASS_LABEL', defaultValue: 'Class 1'}}
            },
            '---',
            ...labelReturnBlocks,
            '---',
            {
                opcode:    'addTrainingImage',
                blockType: BlockType.COMMAND,
                text:      formatMessage({id: 'teachableMachine.addTrainingImage', default: 'add training data [IMAGE] [LABEL]'}),
                arguments: {
                    IMAGE: {type: ArgumentType.STRING, defaultValue: 'image'},
                    LABEL: {type: ArgumentType.STRING, menu: 'CLASS_LABEL', defaultValue: 'Class 1'}
                }
            },
            {
                opcode:    'trainNewModel',
                blockType: BlockType.COMMAND,
                text:      formatMessage({id: 'teachableMachine.trainNewModel', default: 'train new machine learning model'})
            },
            {
                opcode:    'clearTrainingData',
                blockType: BlockType.COMMAND,
                text:      formatMessage({id: 'teachableMachine.clearTrainingData', default: 'clear all training data'})
            },
            {
                opcode:    'isTrainingStatus',
                blockType: BlockType.BOOLEAN,
                text:      formatMessage({id: 'teachableMachine.isTrainingStatus', default: 'is training [STATUS] ?'}),
                arguments: {STATUS: {type: ArgumentType.STRING, menu: 'TRAIN_STATUS_MENU', defaultValue: 'ready'}}
            }
        ];

        /* Images utility category — plain green circle in sidebar, no per-block icon */
        const imagesCategoryInfo = {
            id:     'mlImages',
            name:   formatMessage({id: 'teachableMachine.imagesCategory', default: 'Images'}),
            color1: '#0BBF8A',
            color2: '#09A87A',
            color3: '#07916A',
            blocks: modelType ? [
                {
                    opcode:    'getCostumeImage',
                    blockType: BlockType.REPORTER,
                    text:      formatMessage({id: 'teachableMachine.getCostumeImage', default: 'costume image'})
                },
                {
                    opcode:    'getBackdropImage',
                    blockType: BlockType.REPORTER,
                    text:      formatMessage({id: 'teachableMachine.getBackdropImage', default: 'backdrop image'})
                },
                {
                    opcode:    'saveScreenshotToCostume',
                    blockType: BlockType.COMMAND,
                    text:      formatMessage({id: 'teachableMachine.saveScreenshotToCostume', default: 'save screenshot to costume'})
                },
                {
                    opcode:    'getWebcamImage',
                    blockType: BlockType.REPORTER,
                    text:      formatMessage({id: 'teachableMachine.getWebcamImage', default: 'webcam image'})
                }
            ] : [],
            menus: {}
        };

        /* Audio-model blocks */
        const audioBlocks = [
            {
                opcode:    'startListening',
                blockType: BlockType.COMMAND,
                text:      formatMessage({id: 'teachableMachine.startListening', default: 'start listening'})
            },
            {
                opcode:    'stopListening',
                blockType: BlockType.COMMAND,
                text:      formatMessage({id: 'teachableMachine.stopListening', default: 'stop listening'})
            },
            {
                opcode:    'whenSoundIs',
                blockType: BlockType.HAT,
                text:      formatMessage({id: 'teachableMachine.whenSoundIs', default: 'when I hear [LABEL]'}),
                arguments: {LABEL: {type: ArgumentType.STRING, menu: 'CLASS_LABEL', defaultValue: 'Class 1'}}
            },
            {
                opcode:    'identifiedSound',
                blockType: BlockType.REPORTER,
                text:      formatMessage({id: 'teachableMachine.identifiedSound', default: 'identified sound'})
            },
            {
                opcode:    'soundConfidence',
                blockType: BlockType.REPORTER,
                text:      formatMessage({id: 'teachableMachine.soundConfidence', default: 'confidence of sound [LABEL] %'}),
                arguments: {LABEL: {type: ArgumentType.STRING, menu: 'CLASS_LABEL', defaultValue: 'Class 1'}}
            }
        ];

        /* Text-model blocks — ML for Kids style (reuses labelReturnBlocks from above) */

        const textBlocks = [
            {
                opcode:    'recogniseText',
                blockType: BlockType.REPORTER,
                text:      formatMessage({id: 'teachableMachine.recogniseText', default: 'recognise text [TEXT] (label)'}),
                arguments: {TEXT: {type: ArgumentType.STRING, defaultValue: 'text'}}
            },
            {
                opcode:    'recogniseTextConfidence',
                blockType: BlockType.REPORTER,
                text:      formatMessage({id: 'teachableMachine.recogniseTextConfidence', default: 'recognise text [TEXT] (confidence)'}),
                arguments: {TEXT: {type: ArgumentType.STRING, defaultValue: 'text'}}
            },
            '---',
            ...labelReturnBlocks,
            '---',
            {
                opcode:    'addTrainingText',
                blockType: BlockType.COMMAND,
                text:      formatMessage({id: 'teachableMachine.addTrainingData', default: 'add training data [TEXT] [LABEL]'}),
                arguments: {
                    TEXT:  {type: ArgumentType.STRING, defaultValue: 'text'},
                    LABEL: {type: ArgumentType.STRING, menu: 'CLASS_LABEL', defaultValue: allLabels[0]}
                }
            },
            {
                opcode:    'trainNewModel',
                blockType: BlockType.COMMAND,
                text:      formatMessage({id: 'teachableMachine.trainNewModel', default: 'train new machine learning model'})
            },
            {
                opcode:    'checkModelStatus',
                blockType: BlockType.BOOLEAN,
                text:      formatMessage({id: 'teachableMachine.isMLModelStatus', default: 'Is the machine learning model [STATUS] ?'}),
                arguments: {STATUS: {type: ArgumentType.STRING, menu: 'TEXT_STATUS_MENU', defaultValue: 'ready'}}
            }
        ];

        const typeBlocks = modelType === 'sounds' ? audioBlocks
            : modelType === 'text' ? textBlocks
            : isImageModel ? imageBlocks
            : [];

        const categoryName = (local && local.projectName)
            ? local.projectName
            : formatMessage({id: 'teachableMachine.categoryName', default: 'Machine Learning', description: 'Extension category name'});

        const mlCategory = {
            id: 'teachableMachine',
            name: categoryName,
            color1: '#4B4A60',
            color2: '#ffffff',
            color3: '#4c97ff',
            blockIconURI,
            blockIconSize: 20,
            menuIconURI,
            blocks: modelType === 'text' ? textBlocks : [...typeBlocks, ...commonBlocks],
            menus: {
                CLASS_LABEL: {
                    acceptReporters: false,
                    items: 'getClassLabels'
                },
                SOURCE_MENU: {
                    acceptReporters: false,
                    items: [
                        {text: 'web camera', value: 'web camera'},
                        {text: 'costume',    value: 'costume'},
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
                },
                TEXT_STATUS_MENU: {
                    acceptReporters: false,
                    items: [
                        {text: 'Ready',    value: 'ready'},
                        {text: 'Training', value: 'training'},
                        {text: 'Error',    value: 'error'}
                    ]
                }
            }
        };

        /* Always register both categories so _blockInfo stays stable;
           imagesCategoryInfo.blocks is empty for non-image models so the runtime hides it */
        return [imagesCategoryInfo, mlCategory];
    }

    /* ── Block implementations ── */

    /* One-shot: classify from IMAGE data URL produced by Images category blocks */
    async recogniseLabel (args) {
        const result = await this._classifyFromDataUrl(Cast.toString(args.IMAGE));
        if (!result) return 'unknown';
        return result.res.label || 'unknown';
    }

    async recogniseConfidence (args) {
        const result = await this._classifyFromDataUrl(Cast.toString(args.IMAGE));
        if (!result) return 0;
        const topIdx = result.res.classIndex;
        return Math.round((result.res.confidences[String(topIdx)] || 0) * 100);
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

    /* Add training image from IMAGE data URL produced by Images category blocks */
    async addTrainingImage (args) {
        const local = this._getLocalModel();
        if (!local || !local._trainingAPI) return;
        const api = local._trainingAPI.current;
        if (!api || !api.addTrainingImage) return;
        const imageData = Cast.toString(args.IMAGE);
        const label     = Cast.toString(args.LABEL);
        if (!imageData || !imageData.startsWith('data:')) return;
        await api.addTrainingImage(label, [imageData]);
    }

    /* ── Images category block implementations ── */

    async getCostumeImage (args, util) {
        const canvas = await this._getCostumeCanvas(util);
        if (!canvas) return '';
        return canvas.toDataURL('image/png');
    }

    async getBackdropImage () {
        const canvas = await this._getBackdropCanvas();
        if (!canvas) return '';
        return canvas.toDataURL('image/png');
    }

    async saveScreenshotToCostume (args, util) {
        const canvas = await this._getStageCanvas();
        if (!canvas || !util || !util.target) return;
        const storage = this.runtime.storage;
        if (!storage || !storage.createAsset) return;
        try {
            // Decode PNG data URL to raw bytes for storage asset
            const dataUrl = canvas.toDataURL('image/png');
            const base64  = dataUrl.split(',')[1];
            const binary  = atob(base64);
            const bytes   = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

            const costume = {
                name: 'screenshot',
                dataFormat: storage.DataFormat.PNG,
                bitmapResolution: 1,
                rotationCenterX: Math.round(canvas.width / 2),
                rotationCenterY: Math.round(canvas.height / 2)
            };
            costume.asset = storage.createAsset(
                storage.AssetType.ImageBitmap,
                costume.dataFormat,
                bytes,
                null,
                true  // generate md5
            );
            costume.assetId = costume.asset.assetId;
            costume.md5    = `${costume.assetId}.${costume.dataFormat}`;
            costume.md5ext = costume.md5;

            // loadCostumeFromAsset calls renderer.createBitmapSkin() and sets
            // costume.skinId + costume.size — without this the costume renders white
            await loadCostumeFromAsset(costume, this.runtime);

            util.target.addCostume(costume);
            util.target.setCostume(util.target.getCostumes().length - 1);
        } catch (e) {
            console.warn('[ML] saveScreenshotToCostume:', e.message);
        }
    }

    async getWebcamImage () {
        try {
            if (this.runtime.ioDevices && this.runtime.ioDevices.video) {
                this.runtime.ioDevices.video.enableVideo();
            }
        } catch (_) {}
        const canvas = this._getVideoCanvas();
        if (!canvas) return '';
        return canvas.toDataURL('image/png');
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
        if (!local) return status === 'not loaded';
        if (local.type === 'sounds') {
            if (status === 'ready')   return local.trainingStatus === 'ready';
            if (status === 'loading') return local.trainingStatus === 'loading';
            return false;
        }
        if (local.type === 'text') {
            if (status === 'ready')    return !!(local.classifyText && local.trainingStatus === 'ready');
            if (status === 'loading' || status === 'training')
                return local.trainingStatus === 'loading' || local.trainingStatus === 'training';
            if (status === 'error')    return local.trainingStatus === 'error';
            return false;
        }
        if (status === 'ready')   return !!(local.classifier && local.mobileNet);
        if (status === 'loading') return !!(local && !(local.classifier && local.mobileNet));
        return false;
    }

    modelStatus () {
        const local = this._getLocalModel();
        if (!local) return 'no model loaded';
        if (local.type === 'sounds') {
            return local.trainingStatus === 'ready'
                ? `ready: ${local.projectName || 'audio model'}`
                : (local.trainingStatus || 'loading');
        }
        if (local.type === 'text') {
            return (local.classifyText && local.trainingStatus === 'ready')
                ? `ready: ${local.projectName || 'text model'}`
                : (local.trainingStatus || 'loading');
        }
        if (local.classifier && local.mobileNet) return `ready: ${local.projectName || 'model'}`;
        return 'loading';
    }

    /* ── Audio blocks ── */

    async startListening () {
        const local = this._getLocalModel();
        if (!local || local.type !== 'sounds' || !local.startListening) return;
        if (this._audioListening) return;
        this._audioListening = true;
        try {
            await local.startListening(matches => {
                // Strip background noise — it is a training aid, not a user-visible class
                const filtered = (matches || []).filter(m => m.label !== '_background_noise_');
                this._audioPredictions = filtered;
                if (filtered.length === 0) return;
                const top = filtered.reduce(
                    (a, b) => ((a.prob || 0) > (b.prob || 0) ? a : b),
                    filtered[0]
                );
                this._audioPrevTop  = this._audioTopClass;
                this._audioTopClass = top.label || '';
                if (this._audioTopClass && this._audioTopClass !== this._audioPrevTop) {
                    this.runtime.startHats('teachableMachine_whenSoundIs', {LABEL: this._audioTopClass});
                }
            });
        } catch (err) {
            this._audioListening = false;
            console.error('[ML] startListening:', err);
        }
    }

    async stopListening () {
        if (!this._audioListening) return;
        this._audioListening   = false;
        this._audioTopClass    = '';
        this._audioPredictions = [];
        const local = this._getLocalModel();
        if (local && local.stopListening) {
            try { await local.stopListening(); } catch (_) {}
        }
    }

    whenSoundIs (args) {
        return this._audioTopClass.toLowerCase() === Cast.toString(args.LABEL).toLowerCase();
    }

    identifiedSound () { return this._audioTopClass; }

    soundConfidence (args) {
        const label = Cast.toString(args.LABEL).toLowerCase();
        const match = this._audioPredictions.find(p => (p.label || '').toLowerCase() === label);
        return match ? Math.round(match.prob || 0) : 0;
    }

    /* ── Text blocks ── */

    async recogniseText (args) {
        const local = this._getLocalModel();
        if (!local || local.type !== 'text' || !local.classifyText) return 'unknown';
        try {
            const res = await local.classifyText(Cast.toString(args.TEXT));
            if (!res) return 'unknown';
            this._textTopClass = res.label || '';
            const labels = local.labels || [];
            this._textPredictions = labels.map((lbl, i) => ({
                className:   lbl,
                probability: res.confidences[String(i)] || 0
            }));
            return this._textTopClass;
        } catch (_) { return 'unknown'; }
    }

    async recogniseTextConfidence (args) {
        const local = this._getLocalModel();
        if (!local || local.type !== 'text' || !local.classifyText) return 0;
        try {
            const res = await local.classifyText(Cast.toString(args.TEXT));
            if (!res) return 0;
            this._textTopClass = res.label || '';
            const labels = local.labels || [];
            this._textPredictions = labels.map((lbl, i) => ({
                className:   lbl,
                probability: res.confidences[String(i)] || 0
            }));
            const top = this._textPredictions.reduce(
                (a, b) => a.probability > b.probability ? a : b,
                this._textPredictions[0]
            );
            return top ? Math.round(top.probability * 100) : 0;
        } catch (_) { return 0; }
    }

    async classifyText (args) {
        const local = this._getLocalModel();
        if (!local || local.type !== 'text' || !local.classifyText) return 'unknown';
        try {
            const res = await local.classifyText(Cast.toString(args.TEXT));
            if (!res) return 'unknown';
            const labels = local.labels || [];
            this._textPredictions = labels.map((lbl, i) => ({
                className:   lbl,
                probability: res.confidences[String(i)] || 0
            }));
            this._textTopClass = res.label || '';
            return this._textTopClass;
        } catch (_) { return 'unknown'; }
    }

    async classifyTextConfidence (args) {
        const local = this._getLocalModel();
        if (!local || local.type !== 'text' || !local.classifyText) return 0;
        try {
            const res = await local.classifyText(Cast.toString(args.TEXT));
            if (!res) return 0;
            const labels = local.labels || [];
            this._textPredictions = labels.map((lbl, i) => ({
                className:   lbl,
                probability: res.confidences[String(i)] || 0
            }));
            this._textTopClass = res.label || '';
            const top = this._textPredictions.reduce(
                (a, b) => a.probability > b.probability ? a : b,
                this._textPredictions[0]
            );
            return top ? Math.round(top.probability * 100) : 0;
        } catch (_) { return 0; }
    }

    identifiedText ()          { return this._textTopClass; }

    isIdentifiedTextClass (args) {
        return this._textTopClass.toLowerCase() === Cast.toString(args.LABEL).toLowerCase();
    }

    getTextConfidence (args) {
        const label = Cast.toString(args.LABEL).toLowerCase();
        const match = this._textPredictions.find(p => p.className.toLowerCase() === label);
        return match ? Math.round((match.probability || 0) * 100) : 0;
    }

    whenTextIs (args) {
        return this._textTopClass.toLowerCase() === Cast.toString(args.LABEL).toLowerCase();
    }

    async addTrainingText (args) {
        const local = this._getLocalModel();
        if (!local || !local._trainingAPI) return;
        const api = local._trainingAPI.current;
        if (!api || !api.addTrainingText) return;
        await api.addTrainingText(Cast.toString(args.LABEL), Cast.toString(args.TEXT));
    }
}

module.exports = Scratch3TeachableMachineBlocks;
