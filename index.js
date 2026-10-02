// Video Frame Caption — SillyTavern extension
// When the user sends a message with a video, grab the first, middle and last
// frame, run each through the built-in image captioning (/caption) and append
// the results to the user's message so the model can "see" the video.

const MODULE = 'video_frame_caption';
const DEFAULTS = {
    enabled: true,
    // {start} {middle} {end} are replaced with the captions
    template: '\n\n[Video frames — start: {start} | middle: {middle} | end: {end}]',
    maxWidth: 1024,
};

const VIDEO_RE = /\.(mp4|webm|mov|mkv|m4v|ogv)(\?|#|$)/i;

const ctx = () => SillyTavern.getContext();

function getSettings() {
    const { extensionSettings, saveSettingsDebounced } = ctx();
    if (!extensionSettings[MODULE]) {
        extensionSettings[MODULE] = structuredClone(DEFAULTS);
    }
    for (const k of Object.keys(DEFAULTS)) {
        if (extensionSettings[MODULE][k] === undefined) extensionSettings[MODULE][k] = DEFAULTS[k];
    }
    return { s: extensionSettings[MODULE], save: saveSettingsDebounced };
}

/** Find a video URL on a message, checking the places ST may store it. */
function findVideoUrl(message) {
    const extra = message?.extra;
    if (!extra) return null;

    if (typeof extra.video === 'string') return extra.video;
    if (extra.video?.url) return extra.video.url;

    if (Array.isArray(extra.media)) {
        const m = extra.media.find(x => x?.type === 'video' || VIDEO_RE.test(x?.url || ''));
        if (m?.url) return m.url;
    }
    if (extra.file?.url && (VIDEO_RE.test(extra.file.url) || /^video\//.test(extra.file.type || ''))) {
        return extra.file.url;
    }
    return null;
}

function loadVideo(url) {
    return new Promise((resolve, reject) => {
        const v = document.createElement('video');
        v.crossOrigin = 'anonymous';
        v.preload = 'auto';
        v.muted = true;
        v.playsInline = true;
        v.onloadedmetadata = () => resolve(v);
        v.onerror = () => reject(new Error('Could not load video'));
        v.src = url;
    });
}

function seek(video, time) {
    return new Promise((resolve, reject) => {
        const done = () => { video.removeEventListener('seeked', done); resolve(); };
        video.addEventListener('seeked', done);
        video.onerror = () => reject(new Error('Seek failed'));
        video.currentTime = time;
    });
}

/** Returns [startDataUrl, middleDataUrl, endDataUrl] */
async function extractFrames(url, maxWidth) {
    const video = await loadVideo(url);
    const d = video.duration;
    if (!isFinite(d) || d <= 0) throw new Error('Invalid video duration');

    const scale = Math.min(1, maxWidth / video.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const g = canvas.getContext('2d');

    // Nudge off exact 0 / end — those often render black.
    const times = [Math.min(0.05, d / 2), d / 2, Math.max(d - 0.1, d / 2)];
    const frames = [];
    for (const t of times) {
        await seek(video, t);
        g.drawImage(video, 0, 0, canvas.width, canvas.height);
        frames.push(canvas.toDataURL('image/jpeg', 0.85));
    }
    video.removeAttribute('src');
    video.load();
    return frames;
}

/**
 * Caption one frame using the user's configured captioning workflow.
 * Trick: temporarily put the frame on the message as its image, then run the
 * built-in /caption command against that message.
 */
async function captionFrame(mesId, dataUrl) {
    const { chat, executeSlashCommandsWithOptions } = ctx();
    const message = chat[mesId];
    message.extra = message.extra || {};
    const prev = { image: message.extra.image, inline: message.extra.inline_image };

    message.extra.image = dataUrl;
    message.extra.inline_image = false;
    try {
        const res = await executeSlashCommandsWithOptions(`/caption quiet=true mesId=${mesId}`, {
            handleParserErrors: true,
            handleExecutionErrors: true,
        });
        return (res?.pipe || '').trim();
    } finally {
        if (prev.image === undefined) delete message.extra.image; else message.extra.image = prev.image;
        if (prev.inline === undefined) delete message.extra.inline_image; else message.extra.inline_image = prev.inline;
    }
}

async function onMessageSent(mesId) {
    const { s } = getSettings();
    if (!s.enabled) return;

    const { chat, updateMessageBlock, saveChat } = ctx();
    const message = chat[mesId];
    if (!message?.is_user || message.extra?.video_captions) return;

    const url = findVideoUrl(message);
    if (!url) {
        console.debug(`[${MODULE}] no video found on message; extra keys:`, Object.keys(message?.extra || {}));
        return;
    }

    try {
        toastr.info('Captioning video frames…', 'Video Frame Caption');
        const frames = await extractFrames(url, s.maxWidth);

        const captions = [];
        for (const f of frames) captions.push((await captionFrame(mesId, f)) || '(no caption)');

        const [start, middle, end] = captions;
        message.extra.video_captions = { start, middle, end };
        message.mes += s.template
            .replace('{start}', start)
            .replace('{middle}', middle)
            .replace('{end}', end);

        updateMessageBlock(mesId, message);
        await saveChat();
        toastr.success('Video captioned', 'Video Frame Caption');
    } catch (err) {
        console.error(`[${MODULE}]`, err);
        toastr.error(err.message, 'Video Frame Caption');
    }
}

function addSettingsUi() {
    const { s, save } = getSettings();
    const html = `
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Video Frame Caption</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <label class="checkbox_label">
                <input id="vfc_enabled" type="checkbox" ${s.enabled ? 'checked' : ''} />
                <span>Auto-caption start / middle / end frame of sent videos</span>
            </label>
            <label for="vfc_template">Message template ({start} {middle} {end})</label>
            <textarea id="vfc_template" class="text_pole textarea_compact" rows="3"></textarea>
        </div>
    </div>`;
    $('#extensions_settings2').append(html);
    $('#vfc_template').val(s.template).on('input', function () { s.template = String($(this).val()); save(); });
    $('#vfc_enabled').on('change', function () { s.enabled = $(this).prop('checked'); save(); });
}

jQuery(() => {
    const { eventSource, event_types } = ctx();
    addSettingsUi();
    eventSource.on(event_types.MESSAGE_SENT, onMessageSent);
});
