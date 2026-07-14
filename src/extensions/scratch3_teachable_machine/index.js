const ArgumentType = require('../../extension-support/argument-type');
const BlockType = require('../../extension-support/block-type');
const Cast = require('../../util/cast');
const formatMessage = require('format-message');
const Video = require('../../io/video');
const {loadCostumeFromAsset} = require('../../import/load-costume');

/* NOTE: these SVGs MUST carry explicit width/height (not just viewBox). A data-URI SVG with
   only a viewBox has NO intrinsic size in Chromium, so the block-icon <image> decodes to width 0,
   reserves no space, and the block text renders ON TOP of the icon (the "compressed" ML blocks).
   Explicit width/height gives a definite intrinsic size, fixing it deterministically. */
const menuIconSVG = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><circle cx="4" cy="7" r="2.5" fill="#FF8C1A"/><circle cx="4" cy="13" r="2.5" fill="#FF8C1A"/><circle cx="10" cy="4" r="2.5" fill="#FF8C1A"/><circle cx="10" cy="10" r="2.5" fill="#FF8C1A"/><circle cx="10" cy="16" r="2.5" fill="#FF8C1A"/><circle cx="16" cy="10" r="2.5" fill="#FF8C1A"/><line x1="6.5" y1="7" x2="7.5" y2="4" stroke="#FF8C1A" stroke-width="1"/><line x1="6.5" y1="7" x2="7.5" y2="10" stroke="#FF8C1A" stroke-width="1"/><line x1="6.5" y1="13" x2="7.5" y2="10" stroke="#FF8C1A" stroke-width="1"/><line x1="6.5" y1="13" x2="7.5" y2="16" stroke="#FF8C1A" stroke-width="1"/><line x1="12.5" y1="4" x2="13.5" y2="10" stroke="#FF8C1A" stroke-width="1"/><line x1="12.5" y1="10" x2="13.5" y2="10" stroke="#FF8C1A" stroke-width="1"/><line x1="12.5" y1="16" x2="13.5" y2="10" stroke="#FF8C1A" stroke-width="1"/></svg>';
const blockIconSVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><circle cx="8" cy="14" r="5" fill="#FF8C1A"/><circle cx="8" cy="26" r="5" fill="#FF8C1A"/><circle cx="20" cy="8" r="5" fill="#FF8C1A"/><circle cx="20" cy="20" r="5" fill="#FF8C1A"/><circle cx="20" cy="32" r="5" fill="#FF8C1A"/><circle cx="32" cy="20" r="5" fill="#FF8C1A"/><line x1="13" y1="14" x2="15" y2="8" stroke="#FF8C1A" stroke-width="2"/><line x1="13" y1="14" x2="15" y2="20" stroke="#FF8C1A" stroke-width="2"/><line x1="13" y1="26" x2="15" y2="20" stroke="#FF8C1A" stroke-width="2"/><line x1="13" y1="26" x2="15" y2="32" stroke="#FF8C1A" stroke-width="2"/><line x1="25" y1="8" x2="27" y2="20" stroke="#FF8C1A" stroke-width="2"/><line x1="25" y1="20" x2="27" y2="20" stroke="#FF8C1A" stroke-width="2"/><line x1="25" y1="32" x2="27" y2="20" stroke="#FF8C1A" stroke-width="2"/></svg>';

const menuIconURI  = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(menuIconSVG)}`;
const blockIconURI = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(blockIconSVG)}`;


const CLASSIFY_INTERVAL = 200;
const DIMENSIONS        = [480, 360];

/* Minimum top confidence (%) for a one-shot "recognise sound (label)" to assert a class.
   Below this the audio was ambiguous/ambient, so the block reports 'unknown' instead of
   forcing an argmax. The "(confidence)" block is NOT gated — it always reports the real %,
   so a project can build its own threshold logic. Tune here if too strict/lenient. */
const ONESHOT_MIN_CONFIDENCE = 50;

/* Display safety net: collapse a label that is a unit repeated ≥3 times (e.g. a corrupted
   "PositivePositivePositive…") back to the unit, so the palette never shows a mangled name.
   ≥3 repetitions of a multi-char unit is virtually never a real class name. */
const collapseRepeats = s => {
    if (typeof s !== 'string' || s.length < 3) return s;
    for (let p = 1; p <= Math.floor(s.length / 3); p++) {
        if (s.length % p !== 0) continue;
        const unit  = s.slice(0, p);
        const times = s.length / p;
        if (times >= 3 && unit.repeat(times) === s) return unit;
    }
    return s;
};

class Scratch3TeachableMachineBlocks {
    constructor (runtime) {
        this.runtime = runtime;
        this._isRunning    = false;
        this._predictions  = [];
        this._topClass     = '';
        this._prevTopClass = '';

        /* CONTINUOUS listener state — owned exclusively by `start listening`. Only the live
           listen() callback writes these; `identified sound` / `when I hear` read them. */
        this._audioListening   = false;
        this._audioTopClass    = '';
        this._audioPrevTop     = '';
        this._audioPredictions = [];

        /* ONE-SHOT state — owned exclusively by `recognise sound (label)/(confidence)`.
           Kept SEPARATE from the continuous state above: sharing them made a one-shot leak
           into `identified sound`, and made the label monitor freeze on a stale class while
           the confidence monitor kept updating. */
        this._oneShotTopClass    = '';
        this._oneShotPredictions = [];

        this._textTopClass    = '';
        this._textPredictions = [];

        this._lastModelType    = undefined; // undefined = never checked yet
        this._lastModelKey     = undefined; // projectId:type composite key
        this._toolboxRefreshTimer = null;  // debounce handle

        if (this.runtime.ioDevices) {
            this.runtime.on('PROJECT_RUN_STOP', () => this._stopAll());
            // The red Stop button emits PROJECT_STOP_ALL — bind it too so the mic/camera are
            // released the instant the user stops, not only when the last thread drains.
            this.runtime.on('PROJECT_STOP_ALL', () => this._stopAll());
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

    /* ── Infer the project's ML type from the placed blocks (SAFE) ──
       Used when NO model is loaded (deleted, or a .rc with no model reference) so the palette
       shows the project's OWN type instead of defaulting to the image-led union.
       SAFETY: only returns a type when the project is UNAMBIGUOUSLY one type (distinctive
       opcodes of exactly one kind present). For mixed/none it returns null → getInfo registers
       the FULL union, so no saved block can ever be dropped during deserialization. */
    _inferModelTypeFromWorkspace () {
        try {
            const targets = this.runtime && this.runtime.targets;
            if (!targets || !targets.length) return null;
            const TEXT = new Set([
                'recogniseText', 'recogniseTextConfidence', 'classifyText',
                'classifyTextConfidence', 'addTrainingText'
            ]);
            const SOUND = new Set([
                'startListening', 'stopListening', 'whenSoundIs',
                'identifiedSound', 'soundConfidence'
            ]);
            const IMAGE = new Set([
                'recogniseLabel', 'recogniseConfidence', 'openRecognitionWindow',
                'stopRecognition', 'toggleVideo', 'identifiedClass', 'getConfidenceOfClass',
                'isIdentifiedClass', 'whenClassIs', 'addTrainingImage', 'getCostumeImage',
                'getBackdropImage', 'getWebcamImage', 'saveScreenshotToCostume'
            ]);
            let text = 0, sound = 0, image = 0;
            for (const t of targets) {
                const blocks = t.blocks && t.blocks._blocks;
                if (!blocks) continue;
                for (const id in blocks) {
                    const op = (blocks[id] && blocks[id].opcode) || '';
                    // Stored opcodes are prefixed (e.g. 'teachableMachine_startListening',
                    // 'mlImages_getCostumeImage') — compare the bare opcode after the prefix.
                    const bare = op.indexOf('_') >= 0 ? op.slice(op.indexOf('_') + 1) : op;
                    if (TEXT.has(bare)) text++;
                    else if (SOUND.has(bare)) sound++;
                    else if (IMAGE.has(bare)) image++;
                }
            }
            const kinds = (text > 0 ? 1 : 0) + (sound > 0 ? 1 : 0) + (image > 0 ? 1 : 0);
            if (kinds !== 1) return null; // none or mixed → union (safe, nothing dropped)
            if (text)  return 'text';
            if (sound) return 'sounds';
            return 'images';
        } catch (_) { return null; }
    }

    /* ── Dynamic label menu (reads live from loaded model) ──
       MUST return [humanReadable, languageNeutral] PAIRS, not {text,value} objects.
       scratch-blocks' FieldDropdown reads options[i][0]/[1] directly for a dynamic
       menuGenerator (the function result is used raw — it does NOT pass through the VM's
       _convertMenuItems, which only converts STATIC arrays). Returning objects made
       options[i][1] undefined, so value-matching always failed and the field fell back to
       displaying its raw stored value — which then corrupted (e.g. "Positive" repeated). */
    getClassLabels () {
        // MUST return plain STRINGS (or {text,value} objects) — NOT [text,value] array pairs.
        // This is a dynamic menu, so the VM's _getExtensionMenuItems wraps each returned item
        // into a [display,value] pair itself: a string → [s,s], an object → [text,value]. If we
        // return an ARRAY it's typeof 'object', so it reads item.text/item.value (both undefined)
        // → every menu entry renders BLANK. Return strings and let the VM pair them.
        const local = this._getLocalModel();
        if (local && local.labels && local.labels.length > 0) {
            // '_background_noise_' is an INTERNAL sound-training class — never user-selectable.
            const usable = local.labels.filter(l => l !== '_background_noise_');
            if (usable.length > 0) {
                return usable.map(l => collapseRepeats(l));
            }
        }
        return ['Class 1', 'Class 2'];
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
        this._audioListening     = false;
        this._audioTopClass      = '';
        this._audioPredictions   = [];
        this._oneShotTopClass    = '';
        this._oneShotPredictions = [];
        // Force the mic off on Stop for ANY sound model — this covers a one-shot capture that
        // is mid-flight (not tracked by _audioListening), so the mic never lingers after Stop.
        const audioLocal = this._getLocalModel();
        if (audioLocal && audioLocal.type === 'sounds' && audioLocal.stopListening) {
            audioLocal.stopListening().catch(() => {});
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
        const local = this._getLocalModel();
        // Type from the loaded model; else infer (SAFELY) from the placed blocks so a model-less
        // project shows its OWN type instead of the image-led union. Inference returns null for
        // mixed/empty projects → union is registered (no blocks dropped).
        const modelType    = (local ? (local.type || 'images') : null) || this._inferModelTypeFromWorkspace();
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

        /* Per-label reporter blocks — shared between image, text and sound models.
           Run labels through collapseRepeats so a corrupted "XXXX…" name never appears.
           '_background_noise_' is an INTERNAL sound-training class — filter it out so it never
           appears as a user-facing class reporter block (matches getClassLabels). */
        const usableLabels = (local && local.labels && local.labels.length > 0)
            ? local.labels.filter(l => l !== '_background_noise_') : [];
        const allLabels = usableLabels.length > 0
            ? usableLabels.map(collapseRepeats) : ['Class 1', 'Class 2'];
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
            // These image-source utility blocks (costume / backdrop / webcam image, save
            // screenshot) are ALWAYS available — for image, sound AND text projects. They are
            // general-purpose image helpers, not tied to the model type, so they must stay
            // visible regardless. (Always registering them also guarantees an image project's
            // "recognise image [costume image]" nested block reconstructs during deserialize.)
            blocks: [
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
            ],
            menus: {}
        };

        /* Audio-model blocks */
        const audioBlocks = [
            {
                opcode:    'recogniseSound',
                blockType: BlockType.REPORTER,
                text:      formatMessage({id: 'teachableMachine.recogniseSound', default: 'recognise sound (label)'})
            },
            {
                opcode:    'recogniseSoundConfidence',
                blockType: BlockType.REPORTER,
                text:      formatMessage({id: 'teachableMachine.recogniseSoundConfidence', default: 'recognise sound (confidence)'})
            },
            '---',
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
            },
            '---',
            /* Per-class reporter blocks (e.g. Happy / Sad) — same as the text project.
               Handlers (returnLabel_N) are always assigned above regardless of model type. */
            ...labelReturnBlocks
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

        let typeBlocks;
        if (modelType) {
            // Type known (from the loaded model OR safely inferred from the placed blocks) —
            // show only that type's blocks, matching the project's actual model type.
            typeBlocks = modelType === 'sounds' ? audioBlocks
                : modelType === 'text' ? textBlocks
                : isImageModel ? imageBlocks
                : [];
        } else {
            // Type unknown — no model AND the placed ML blocks are mixed/none. Register the
            // UNION of every type's blocks (deduped by opcode) so any saved ML block always has
            // a definition and is NOT dropped during deserialization. Once a model loads or the
            // project resolves to a single type, getInfo re-runs and narrows the palette.
            const seen = new Set();
            typeBlocks = [...imageBlocks, ...audioBlocks, ...textBlocks].filter(b => {
                if (!b || b === '---' || !b.opcode) return false;
                if (seen.has(b.opcode)) return false;
                seen.add(b.opcode);
                return true;
            });
        }

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

        /* Both categories are always present. The Images helper category's blocks (costume/
           backdrop/webcam image, save screenshot) are general-purpose and shown for image,
           sound AND text projects alike. */
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

    /* One-shot: record ~1s from the mic and classify it, returning the top label.
       "Support both" behaviour: if a continuous `start listening` loop is already running,
       the mic is busy — reuse its latest live result instead of opening a conflicting
       capture. Otherwise do a fresh one-shot recognition via the ML Studio engine. */
    async recogniseSound (args, util) {
        const local = this._getLocalModel();
        if (!local || local.type !== 'sounds') return 'unknown';
        // A checked reporter is re-evaluated by the VM every frame, forever, regardless of the
        // green flag / Stop button. NEVER open the mic for a monitor poll — that would keep the
        // microphone on in the background after the program is stopped. Show the last value.
        if (util && util.thread && util.thread.updateMonitor) return this._oneShotTopClass || 'unknown';
        // A continuous listener owns the mic — read its live snapshot instead of competing.
        if (this._audioListening) return this._audioTopClass || 'unknown';
        if (!local.recogniseSoundOnce) return 'unknown';
        try {
            const matches = await local.recogniseSoundOnce();
            if (!matches || matches.length === 0) {
                this._oneShotTopClass    = '';
                this._oneShotPredictions = [];
                return 'unknown';
            }
            this._oneShotPredictions = matches;
            // Don't assert a class we're not confident about (ambient/ambiguous audio). Clear
            // the remembered class too, so the monitor can't keep showing a stale old label.
            if ((matches[0].prob || 0) < ONESHOT_MIN_CONFIDENCE) {
                this._oneShotTopClass = '';
                return 'unknown';
            }
            this._oneShotTopClass = matches[0].label || '';
            return this._oneShotTopClass;
        } catch (err) {
            console.error('[ML] recogniseSound:', err);
            return 'unknown';
        }
    }

    /* One-shot confidence of the top class (0-100), mirroring recogniseTextConfidence. */
    async recogniseSoundConfidence (args, util) {
        const local = this._getLocalModel();
        if (!local || local.type !== 'sounds') return 0;
        // Never open the mic for a monitor poll (see recogniseSound) — report the last value.
        if (util && util.thread && util.thread.updateMonitor) {
            const t = this._oneShotPredictions[0];
            return t ? Math.round(t.prob || 0) : 0;
        }
        // A continuous listener owns the mic — read its live snapshot instead of competing.
        if (this._audioListening) {
            const top = this._audioPredictions[0];
            return top ? Math.round(top.prob || 0) : 0;
        }
        if (!local.recogniseSoundOnce) return 0;
        try {
            const matches = await local.recogniseSoundOnce();
            if (!matches || matches.length === 0) {
                this._oneShotPredictions = [];
                return 0;
            }
            this._oneShotPredictions = matches;
            return Math.round(matches[0].prob || 0);
        } catch (err) {
            console.error('[ML] recogniseSoundConfidence:', err);
            return 0;
        }
    }

    /* Most recent scores from EITHER path — the live listener when it's running, otherwise the
       last one-shot. Lets "confidence of sound [LABEL]" work in both workflows. */
    _currentPredictions () {
        if (this._audioListening && this._audioPredictions.length) return this._audioPredictions;
        if (this._oneShotPredictions.length) return this._oneShotPredictions;
        return this._audioPredictions;
    }

    soundConfidence (args) {
        const label = Cast.toString(args.LABEL).toLowerCase();
        const match = this._currentPredictions().find(p => (p.label || '').toLowerCase() === label);
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
