/* =========================================================
   Pulse - التطبيق اللامركزي
   الإصدار: Voice Rooms + Nostr Realtime + Optimistic UI

   ملاحظات:
   - لا توجد أدوات Build.
   - يعمل مباشرة من GitHub Pages.
   - Nostr Tools 2.x.
   - PeerJS 1.5.x.
   - المفتاح السري محفوظ كـ Hex String.
   - finalizeEvent يستخدم Hex String مباشرة.
========================================================= */

const RELAYS = [
    'wss://relay.damus.io',
    'wss://relay.primal.net',
    'wss://nos.lol'
];

const APP_TAG = 'pulse-platform';
const ROOM_TAG = 'pulse-room-v2';

/*
 * خوادم ICE:
 * Google STUN يساعد على اكتشاف الـPublic IP.
 * OpenRelay TURN خدمة عامة، وقد تتغير صلاحيتها أو تكون مزدحمة.
 *
 * للإنتاج الحقيقي يفضل لاحقاً استخدام TURN خاص بك.
 */
const ICE_SERVERS = [
    {
        urls: [
            'stun:stun.l.google.com:19302',
            'stun:stun1.l.google.com:19302',
            'stun:stun2.l.google.com:19302'
        ]
    },

    {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelay',
        credential: 'openrelay'
    },

    {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelay',
        credential: 'openrelay'
    },

    {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelay',
        credential: 'openrelay'
    }
];

const PEER_CONFIG = {
    iceServers: ICE_SERVERS,
    sdpSemantics: 'unified-plan'
};


/* =========================================================
   الحالة العامة
========================================================= */

let secretKeyHex = null;
let pk = null;
let npub = null;

let pool = null;

const storageKey = 'pulse_nsec_hex';
const activeRoomStorageKey = 'pulse_active_voice_room';
const activeVoiceStorageKey = 'pulse_voice_was_active';

const seenEvents = new Set();
const seenInteractionEvents = new Set();

let interactionSub = null;

const postStats = new Map();

/* =========================================================
   حالة غرف الصوت
========================================================= */

let peer = null;
let localStream = null;

let currentRoom = null;
let currentPeerId = null;

let roomPresenceSub = null;
let roomListSub = null;

let presenceTimer = null;
let roomHeartbeatTimer = null;

let isInRoom = false;
let isMuted = false;

const activeCalls = new Map();
const knownRoomPeers = new Map();

let audioContext = null;
let backgroundAudioContext = null;
let silentAudioElement = null;
let wakeLock = null;


/* =========================================================
   أدوات عامة
========================================================= */

function log(...args) {
    console.log('[PULSE]', ...args);
}

function voiceLog(...args) {
    console.log('[VOICE]', ...args);
}

function voiceError(...args) {
    console.error('[VOICE ERROR]', ...args);
}

function normalizeRoomName(room) {
    return String(room || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9\u0600-\u06ff_-]/gi, '')
        .slice(0, 60);
}

function getRoomDisplayName(room) {
    return String(room || '').replace(/-/g, ' ');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text ?? '');
    return div.innerHTML;
}

function getTag(event, name) {
    const tag = (event.tags || []).find(item => item[0] === name);
    return tag ? tag[1] : null;
}

function getTags(event, name) {
    return (event.tags || [])
        .filter(item => item[0] === name)
        .map(item => item[1])
        .filter(Boolean);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


/* =========================================================
   Toast
========================================================= */

function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    const icon = document.getElementById('toast-icon');
    const text = document.getElementById('toast-msg');

    if (!toast || !icon || !text) {
        console.log('[TOAST]', message);
        return;
    }

    text.textContent = message;

    if (type === 'error') {
        icon.className = 'fas fa-exclamation-circle text-red-400';
    } else if (type === 'info') {
        icon.className = 'fas fa-info-circle text-blue-400';
    } else {
        icon.className = 'fas fa-check-circle text-green-400';
    }

    toast.classList.remove('hidden');

    clearTimeout(toast._timer);

    toast._timer = setTimeout(() => {
        toast.classList.add('hidden');
    }, 3500);
}


/* =========================================================
   الهوية Nostr
========================================================= */

function bytesToHex(bytes) {
    return Array.from(bytes)
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
}

function initIdentity() {
    try {
        let savedKey = localStorage.getItem(storageKey);

        const valid =
            typeof savedKey === 'string' &&
            savedKey.length === 64 &&
            /^[0-9a-fA-F]{64}$/.test(savedKey);

        if (!valid) {
            log('لا يوجد مفتاح Nostr صالح، سيتم إنشاء هوية جديدة.');

            const newKey = NostrTools.generateSecretKey();

            savedKey = bytesToHex(newKey);

            localStorage.setItem(storageKey, savedKey);
        }

        /*
         * مهم:
         * نحتفظ بالمفتاح كـ Hex String.
         * لا نحوله إلى Uint8Array قبل finalizeEvent.
         */
        secretKeyHex = savedKey;

        pk = NostrTools.getPublicKey(secretKeyHex);
        npub = NostrTools.nip19.npubEncode(pk);

        const display = document.getElementById('npub-display');

        if (display) {
            display.textContent =
                npub.slice(0, 10) + '...' + npub.slice(-6);
        }

        log('تم تحميل الهوية:', npub);

    } catch (error) {
        console.error('[IDENTITY ERROR]', error);

        localStorage.removeItem(storageKey);

        showToast(
            'حدث خطأ أثناء تهيئة الهوية. سيتم المحاولة مرة أخرى.',
            'error'
        );

        throw error;
    }
}


/* =========================================================
   تهيئة Nostr
========================================================= */

function initNostr() {
    pool = new NostrTools.SimplePool();

    log('Nostr Pool جاهز.');
}


/* =========================================================
   نشر Event عبر Nostr
========================================================= */

async function publishEvent(eventTemplate, successMessage = null) {
    if (!pool) {
        throw new Error('Nostr Pool غير جاهز.');
    }

    if (!secretKeyHex) {
        throw new Error('الهوية غير جاهزة.');
    }

    const signedEvent =
        NostrTools.finalizeEvent(eventTemplate, secretKeyHex);

    log(
        'نشر Event:',
        signedEvent.kind,
        signedEvent.id
    );

    const publishPromises = pool.publish(
        RELAYS,
        signedEvent
    );

    /*
     * يكفي نجاح Relay واحد على الأقل.
     */
    try {
        await Promise.any(publishPromises);

        if (successMessage) {
            showToast(successMessage, 'success');
        }

        return signedEvent;

    } catch (error) {
        console.error(
            '[NOSTR PUBLISH ERROR]',
            signedEvent,
            error
        );

        throw error;
    }
}


/* =========================================================
   المنشورات
========================================================= */

function startFeed() {
    const loader = document.getElementById('loading-feed');

    if (loader) {
        loader.classList.remove('hidden');
    }

    pool.subscribeMany(
        RELAYS,
        [
            {
                kinds: [1],
                '#t': [APP_TAG],
                limit: 50
            }
        ],
        {
            onevent(event) {
                if (seenEvents.has(event.id)) {
                    return;
                }

                seenEvents.add(event.id);

                renderPost(event);
            },

            oneose() {
                if (loader) {
                    loader.classList.add('hidden');
                }

                /*
                 * بعد ظهور المنشورات نبدأ الاشتراك
                 * في الإعجابات والردود الخاصة بها.
                 */
                refreshInteractionSubscription();
            },

            onclose() {
                log('تم إغلاق اشتراك المنشورات.');
            }
        }
    );
}


/* =========================================================
   إنشاء حالة المنشور
========================================================= */

function ensurePostStats(event) {
    if (!postStats.has(event.id)) {
        postStats.set(event.id, {
            id: event.id,
            pubkey: event.pubkey,
            likes: 0,
            replies: 0,
            likedByMe: false,
            likedEventIds: new Set(),
            replyEventIds: new Set()
        });
    }

    return postStats.get(event.id);
}


/* =========================================================
   Render Post
========================================================= */

function renderPost(event) {
    const container = document.getElementById('feed-container');

    if (!container) {
        return;
    }

    /*
     * منع تكرار نفس المنشور.
     */
    if (document.querySelector(`[data-post-id="${event.id}"]`)) {
        return;
    }

    const stats = ensurePostStats(event);

    const shortPubkey =
        event.pubkey.slice(0, 8) + '...';

    const time = new Date(
        event.created_at * 1000
    ).toLocaleString('ar-EG', {
        dateStyle: 'short',
        timeStyle: 'short'
    });

    const card = document.createElement('article');

    card.className =
        'post-card bg-white dark:bg-surface rounded-2xl p-4 shadow-sm border border-gray-100 dark:border-gray-800 fade-in';

    card.dataset.postId = event.id;

    card.innerHTML = `
        <div class="flex justify-between items-start mb-3">
            <div class="flex items-center gap-3">
                <div class="avatar w-10 h-10 bg-indigo-500 text-sm">
                    ${escapeHtml(event.pubkey.slice(0, 2))}
                </div>

                <div>
                    <div class="font-bold text-sm dark:text-white">
                        ${escapeHtml(shortPubkey)}
                    </div>

                    <div class="text-xs text-gray-400">
                        ${escapeHtml(time)}
                    </div>
                </div>
            </div>
        </div>

        <p class="post-content text-gray-800 dark:text-gray-200 leading-relaxed mb-4 whitespace-pre-wrap text-sm md:text-base">
            ${escapeHtml(event.content)}
        </p>

        <div class="flex items-center gap-5 text-gray-400 text-sm border-t border-gray-100 dark:border-gray-800 pt-3">

            <button
                type="button"
                class="like-btn flex items-center gap-2 hover:text-red-500 transition"
                onclick="likePost('${event.id}', '${event.pubkey}')"
            >
                <i class="far fa-heart"></i>

                <span class="like-label">
                    إعجاب
                </span>

                <span
                    class="like-count font-bold"
                    data-like-count="${event.id}"
                >
                    0
                </span>
            </button>

            <button
                type="button"
                class="reply-btn flex items-center gap-2 hover:text-blue-500 transition"
                onclick="replyToPost('${event.id}', '${event.pubkey}')"
            >
                <i class="far fa-comment"></i>

                <span>
                    رد
                </span>

                <span
                    class="reply-count font-bold"
                    data-reply-count="${event.id}"
                >
                    0
                </span>
            </button>
        </div>

        <div
            class="replies-container mt-3 space-y-2"
            data-replies="${event.id}"
        ></div>
    `;

    container.prepend(card);

    updatePostUI(event.id);

    /*
     * لأن قائمة المنشورات المعروضة تغيرت،
     * نعيد إنشاء subscription الخاص بالتفاعلات.
     */
    refreshInteractionSubscription();
}


/* =========================================================
   تحديث UI للمنشور
========================================================= */

function updatePostUI(postId) {
    const stats = postStats.get(postId);

    if (!stats) {
        return;
    }

    const card =
        document.querySelector(
            `[data-post-id="${postId}"]`
        );

    if (!card) {
        return;
    }

    const likeCount =
        card.querySelector('.like-count');

    const replyCount =
        card.querySelector('.reply-count');

    const likeButton =
        card.querySelector('.like-btn');

    const icon =
        likeButton?.querySelector('i');

    if (likeCount) {
        likeCount.textContent =
            stats.likes > 0 ? stats.likes : '0';
    }

    if (replyCount) {
        replyCount.textContent =
            stats.replies > 0 ? stats.replies : '0';
    }

    if (stats.likedByMe) {
        likeButton?.classList.add(
            'text-red-500'
        );

        likeButton?.classList.remove(
            'text-gray-400'
        );

        if (icon) {
            icon.className =
                'fas fa-heart text-red-500';
        }
    } else {
        likeButton?.classList.remove(
            'text-red-500'
        );

        if (icon) {
            icon.className =
                'far fa-heart';
        }
    }
}


/* =========================================================
   نشر منشور
========================================================= */

async function publishPost() {
    const input =
        document.getElementById('post-input');

    const content =
        input?.value.trim();

    if (!content) {
        return;
    }

    try {
        showToast(
            'جاري نشر المنشور...',
            'info'
        );

        const event = await publishEvent({
            kind: 1,
            created_at:
                Math.floor(Date.now() / 1000),
            tags: [
                ['t', APP_TAG]
            ],
            content
        });

        input.value = '';

        /*
         * Optimistic rendering:
         * لا ننتظر Relay لكي يرى المستخدم منشوره.
         */
        if (!seenEvents.has(event.id)) {
            seenEvents.add(event.id);
            renderPost(event);
        }

        showToast(
            'تم نشر المنشور بنجاح',
            'success'
        );

    } catch (error) {
        console.error(
            '[POST ERROR]',
            error
        );

        showToast(
            'فشل نشر المنشور: ' +
            (error?.message || 'خطأ غير معروف'),
            'error'
        );
    }
}


/* =========================================================
   Optimistic Like
========================================================= */

async function likePost(
    targetId,
    targetPubkey
) {
    const stats =
        postStats.get(targetId);

    if (!stats) {
        return;
    }

    /*
     * منع الضغط المتكرر.
     */
    if (stats.likedByMe) {
        showToast(
            'لقد أعجبت بهذا المنشور بالفعل',
            'info'
        );

        return;
    }

    /*
     * Optimistic UI:
     * نغير الواجهة قبل انتظار Relay.
     */
    stats.likedByMe = true;
    stats.likes += 1;

    updatePostUI(targetId);

    const button =
        document.querySelector(
            `[data-post-id="${targetId}"] .like-btn`
        );

    button?.classList.add(
        'scale-110'
    );

    setTimeout(() => {
        button?.classList.remove(
            'scale-110'
        );
    }, 180);

    try {
        const event =
            await publishEvent({
                kind: 7,
                created_at:
                    Math.floor(Date.now() / 1000),

                tags: [
                    ['e', targetId],
                    ['p', targetPubkey]
                ],

                content: '+'
            });

        stats.likedEventIds.add(
            event.id
        );

        showToast(
            'تم تسجيل الإعجاب',
            'success'
        );

    } catch (error) {

        /*
         * Relay فشل:
         * نرجع التغيير التفاؤلي.
         */
        stats.likedByMe = false;
        stats.likes = Math.max(
            0,
            stats.likes - 1
        );

        updatePostUI(targetId);

        console.error(
            '[LIKE ERROR]',
            error
        );

        showToast(
            'فشل إرسال الإعجاب، وتم إلغاء التغيير',
            'error'
        );
    }
}


/* =========================================================
   الرد على المنشور
========================================================= */

async function replyToPost(
    targetId,
    targetPubkey
) {
    const content =
        prompt('اكتب ردك:');

    if (!content?.trim()) {
        return;
    }

    const stats =
        postStats.get(targetId);

    if (!stats) {
        return;
    }

    /*
     * Optimistic reply count.
     */
    stats.replies += 1;

    updatePostUI(targetId);

    try {
        const event =
            await publishEvent({
                kind: 1,
                created_at:
                    Math.floor(Date.now() / 1000),

                tags: [
                    ['e', targetId, '', 'reply'],
                    ['p', targetPubkey],
                    ['t', APP_TAG]
                ],

                content: content.trim()
            });

        renderReply(
            targetId,
            event
        );

        showToast(
            'تم إرسال الرد',
            'success'
        );

    } catch (error) {

        stats.replies = Math.max(
            0,
            stats.replies - 1
        );

        updatePostUI(targetId);

        console.error(
            '[REPLY ERROR]',
            error
        );

        showToast(
            'فشل إرسال الرد',
            'error'
        );
    }
}


/* =========================================================
   عرض الرد
========================================================= */

function renderReply(
    targetId,
    event
) {
    const container =
        document.querySelector(
            `[data-replies="${targetId}"]`
        );

    if (!container) {
        return;
    }

    if (
        container.querySelector(
            `[data-reply-id="${event.id}"]`
        )
    ) {
        return;
    }

    const reply =
        document.createElement('div');

    reply.dataset.replyId =
        event.id;

    reply.className =
        'bg-gray-50 dark:bg-gray-800 rounded-xl p-3 text-sm fade-in';

    reply.innerHTML = `
        <div class="text-xs text-gray-400 mb-1">
            ${escapeHtml(
                event.pubkey.slice(0, 8)
            )}...
        </div>

        <div class="text-gray-700 dark:text-gray-200 whitespace-pre-wrap">
            ${escapeHtml(event.content)}
        </div>
    `;

    container.appendChild(reply);
}


/* =========================================================
   Real-time Like / Reply Subscription
========================================================= */

function refreshInteractionSubscription() {
    if (interactionSub) {
        try {
            interactionSub.close();
        } catch (_) {}
    }

    const postIds = Array.from(
        document.querySelectorAll(
            '.post-card[data-post-id]'
        )
    )
        .map(card => card.dataset.postId)
        .filter(Boolean);

    if (!postIds.length) {
        return;
    }

    /*
     * Nostr filters لا تقبل أكثر من قيمة واحدة؟
     * #e تقبل قائمة IDs، وتعمل كـ OR.
     */
    interactionSub =
        pool.subscribeMany(
            RELAYS,
            [
                {
                    kinds: [7, 1],
                    '#e': postIds,
                    limit: 500
                }
            ],
            {
                onevent(event) {
                    handleInteractionEvent(event);
                }
            }
        );
}


/* =========================================================
   معالجة الإعجاب / الرد اللحظي
========================================================= */

function handleInteractionEvent(event) {
    if (
        seenInteractionEvents.has(event.id)
    ) {
        return;
    }

    seenInteractionEvents.add(
        event.id
    );

    const targetIds =
        getTags(event, 'e');

    if (!targetIds.length) {
        return;
    }

    /*
     * نبحث عن أول منشور موجود في DOM.
     */
    const targetId =
        targetIds.find(id =>
            postStats.has(id)
        );

    if (!targetId) {
        return;
    }

    const stats =
        postStats.get(targetId);

    if (event.kind === 7) {
        /*
         * إذا كان هذا نفس إعجاب المستخدم،
         * لا نزيد العداد مرتين.
         */
        if (
            stats.likedEventIds.has(
                event.id
            )
        ) {
            return;
        }

        stats.likedEventIds.add(
            event.id
        );

        stats.likes += 1;

        if (event.pubkey === pk) {
            stats.likedByMe = true;
        }

        updatePostUI(targetId);

        return;
    }

    if (event.kind === 1) {
        /*
         * تجاهل المنشور الأصلي نفسه.
         */
        if (
            event.id === targetId
        ) {
            return;
        }

        if (
            stats.replyEventIds.has(
                event.id
            )
        ) {
            return;
        }

        stats.replyEventIds.add(
            event.id
        );

        /*
         * إذا كان ردنا منشوراً بالفعل عن طريق
         * Optimistic UI، لا نزيد العدد مرة أخرى.
         */
        if (
            event.pubkey === pk &&
            stats.replies > 0
        ) {
            renderReply(
                targetId,
                event
            );

            updatePostUI(targetId);

            return;
        }

        stats.replies += 1;

        renderReply(
            targetId,
            event
        );

        updatePostUI(targetId);
    }
}


/* =========================================================
   غرف الصوت - PeerJS
========================================================= */

function generatePeerId() {
    /*
     * Peer ID ليس هوية المستخدم.
     * هو مجرد ID مؤقت لجلسة WebRTC.
     */
    return (
        'pulse-' +
        Date.now().toString(36) +
        '-' +
        Math.random()
            .toString(36)
            .slice(2, 9)
    );
}


/* =========================================================
   الحصول على المايكروفون
========================================================= */

async function requestMicrophone() {
    if (
        !navigator.mediaDevices ||
        !navigator.mediaDevices.getUserMedia
    ) {
        throw new Error(
            'المتصفح لا يدعم getUserMedia.'
        );
    }

    voiceLog(
        'طلب صلاحية الميكروفون...'
    );

    try {
        const stream =
            await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    channelCount: 1
                },
                video: false
            });

        voiceLog(
            'تم الحصول على الميكروفون بنجاح.'
        );

        return stream;

    } catch (error) {
        voiceError(
            'فشل الميكروفون:',
            error
        );

        if (
            error.name ===
            'NotAllowedError'
        ) {
            throw new Error(
                'المتصفح رفض صلاحية الميكروفون.'
            );
        }

        if (
            error.name ===
            'NotFoundError'
        ) {
            throw new Error(
                'لم يتم العثور على ميكروفون.'
            );
        }

        if (
            error.name ===
            'NotReadableError'
        ) {
            throw new Error(
                'الميكروفون مستخدم بواسطة تطبيق آخر.'
            );
        }

        throw error;
    }
}


/* =========================================================
   إنشاء PeerJS
========================================================= */

function createPeer() {
    return new Promise(
        (resolve, reject) => {

            const peerId =
                generatePeerId();

            voiceLog(
                'إنشاء PeerJS:',
                peerId
            );

            let resolved = false;

            try {
                peer =
                    new Peer(
                        peerId,
                        {
                            host: '0.peerjs.com',
                            port: 443,
                            secure: true,

                            config:
                                PEER_CONFIG,

                            debug: 2,

                            pingInterval: 5000
                        }
                    );

                peer.on(
                    'open',
                    id => {
                        currentPeerId = id;

                        voiceLog(
                            'PeerJS متصل بالـPeerServer:',
                            id
                        );

                        resolved = true;

                        resolve(id);
                    }
                );

                peer.on(
                    'call',
                    call => {
                        voiceLog(
                            'Incoming call من:',
                            call.peer
                        );

                        handleIncomingCall(
                            call
                        );
                    }
                );

                peer.on(
                    'error',
                    error => {
                        voiceError(
                            'PeerJS error:',
                            error.type,
                            error.message
                        );

                        handlePeerError(
                            error
                        );

                        if (
                            !resolved
                        ) {
                            resolved = true;
                            reject(error);
                        }
                    }
                );

                peer.on(
                    'disconnected',
                    id => {
                        voiceError(
                            'PeerJS disconnected:',
                            id
                        );

                        if (
                            isInRoom &&
                            peer &&
                            peer.disconnected
                        ) {
                            setTimeout(
                                () => {
                                    try {
                                        if (
                                            peer &&
                                            peer.disconnected
                                        ) {
                                            voiceLog(
                                                'محاولة إعادة اتصال PeerJS...'
                                            );

                                            peer.reconnect();
                                        }
                                    } catch (
                                        reconnectError
                                    ) {
                                        voiceError(
                                            'فشل reconnect:',
                                            reconnectError
                                        );
                                    }
                                },
                                1500
                            );
                        }
                    }
                );

                peer.on(
                    'close',
                    () => {
                        voiceLog(
                            'تم إغلاق PeerJS.'
                        );
                    }
                );

            } catch (error) {
                voiceError(
                    'فشل إنشاء PeerJS:',
                    error
                );

                reject(error);
            }
        }
    );
}


/* =========================================================
   معالجة أخطاء PeerJS
========================================================= */

function handlePeerError(error) {
    const type =
        error?.type || '';

    const messages = {
        'browser-incompatible':
            'المتصفح لا يدعم WebRTC.',
        'disconnected':
            'انقطع اتصال PeerJS.',
        'network':
            'مشكلة شبكة مع PeerServer.',
        'server-error':
            'خادم PeerJS رفض الاتصال.',
        'socket-error':
            'تعذر فتح WebSocket مع PeerJS.',
        'socket-closed':
            'اتصال PeerJS أغلق.',
        'unavailable-id':
            'معرّف Peer مستخدم بالفعل.',
        'webrtc':
            'فشل اتصال WebRTC.',
        'peer-unavailable':
            'الطرف الآخر لم يعد متاحاً.'
    };

    const message =
        messages[type] ||
        `خطأ WebRTC/PeerJS: ${type || 'unknown'}`;

    voiceError(
        message,
        error
    );

    if (isInRoom) {
        showToast(
            message,
            'error'
        );
    }
}


/* =========================================================
   دخول الغرفة
========================================================= */

async function toggleRoom(forceLeave = false) {
    if (forceLeave) {
        await leaveRoom();
        return;
    }

    if (isInRoom) {
        await leaveRoom();
        return;
    }

    const input =
        document.getElementById(
            'room-input'
        );

    const room =
        normalizeRoomName(
            input?.value
        );

    if (!room) {
        showToast(
            'اكتب اسم الغرفة أولاً.',
            'error'
        );

        input?.focus();

        return;
    }

    await joinRoom(room);
}


/* =========================================================
   Join Room
========================================================= */

async function joinRoom(roomName) {
    if (isInRoom) {
        return;
    }

    const room =
        normalizeRoomName(roomName);

    if (!room) {
        return;
    }

    voiceLog(
        'بدء الدخول إلى الغرفة:',
        room
    );

    showToast(
        'جاري تشغيل الميكروفون والاتصال بالغرفة...',
        'info'
    );

    try {
        /*
         * 1. الميكروفون أولاً.
         */
        localStream =
            await requestMicrophone();

        /*
         * 2. إعداد الحالة قبل PeerJS.
         */
        currentRoom = room;
        isInRoom = true;
        isMuted = false;

        localStorage.setItem(
            activeRoomStorageKey,
            currentRoom
        );

        localStorage.setItem(
            activeVoiceStorageKey,
            '1'
        );

        updateRoomUI(true);

        /*
         * 3. تشغيل AudioContext بعد Gesture المستخدم.
         */
        await startBackgroundAudioEngine();

        /*
         * 4. Wake Lock.
         */
        await requestWakeLock();

        /*
         * 5. إنشاء Peer جديد.
         */
        await createPeer();

        /*
         * 6. بدء الاستماع قبل الإعلان.
         */
        startRoomPresenceSubscription();

        /*
         * 7. الإعلان عن Peer ID.
         */
        await announcePresence();

        /*
         * 8. الإعلان عن الغرفة نفسها.
         */
        await publishRoomActivity();

        /*
         * 9. Heartbeat.
         */
        startPresenceHeartbeat();

        /*
         * 10. VAD.
         */
        setupVoiceActivityDetection();

        showToast(
            `تم دخول غرفة "${getRoomDisplayName(room)}"`,
            'success'
        );

        voiceLog(
            'تم الدخول بنجاح:',
            room,
            currentPeerId
        );

    } catch (error) {
        voiceError(
            'Join Room Error:',
            error
        );

        showToast(
            error?.message ||
            'فشل الدخول إلى الغرفة.',
            'error'
        );

        await cleanupVoiceState(
            false
        );
    }
}


/* =========================================================
   واجهة الغرفة
========================================================= */

function updateRoomUI(active) {
    const btn =
        document.getElementById(
            'btn-join-room'
        );

    const input =
        document.getElementById(
            'room-input'
        );

    const activeUi =
        document.getElementById(
            'active-room-ui'
        );

    const roomName =
        document.getElementById(
            'current-room-name'
        );

    if (
        active
    ) {
        if (btn) {
            btn.textContent =
                'مغادرة';

            btn.classList.remove(
                'bg-white',
                'text-accent'
            );

            btn.classList.add(
                'bg-red-500',
                'text-white'
            );
        }

        if (input) {
            input.disabled = true;
            input.value =
                currentRoom || '';
        }

        if (roomName) {
            roomName.textContent =
                `غرفة: ${getRoomDisplayName(currentRoom)}`;
        }

        activeUi?.classList.remove(
            'hidden'
        );

    } else {

        if (btn) {
            btn.textContent =
                'دخول';

            btn.classList.remove(
                'bg-red-500',
                'text-white'
            );

            btn.classList.add(
                'bg-white',
                'text-accent'
            );
        }

        if (input) {
            input.disabled = false;
        }

        activeUi?.classList.add(
            'hidden'
        );
    }

    updateMuteUI();
}


/* =========================================================
   إعلان وجود Peer داخل الغرفة
========================================================= */

async function announcePresence() {
    if (
        !isInRoom ||
        !currentRoom ||
        !currentPeerId
    ) {
        return;
    }

    const roomKey =
        currentRoom;

    const eventTemplate = {
        /*
         * Ephemeral Event.
         * لا نريد تخزين Peer IDs القديمة في Relay.
         */
        kind: 20000,

        created_at:
            Math.floor(
                Date.now() / 1000
            ),

        tags: [
            ['t', ROOM_TAG],
            ['room', roomKey],
            ['peer', currentPeerId]
        ],

        content: JSON.stringify({
            version: 2,
            room: roomKey,
            peerId: currentPeerId,
            pubkey: pk,
            npub: npub
        })
    };

    try {
        await publishEvent(
            eventTemplate
        );

        voiceLog(
            'تم إعلان Peer ID:',
            currentPeerId,
            'في الغرفة:',
            roomKey
        );

    } catch (error) {
        /*
         * الإعلان فشل لا يعني أن WebRTC فشل.
         */
        voiceError(
            'فشل نشر Presence:',
            error
        );
    }
}


/* =========================================================
   الاشتراك في Peers الغرفة
========================================================= */

function startRoomPresenceSubscription() {
    if (roomPresenceSub) {
        try {
            roomPresenceSub.close();
        } catch (_) {}
    }

    if (
        !currentRoom
    ) {
        return;
    }

    voiceLog(
        'بدء الاستماع إلى Peers:',
        currentRoom
    );

    roomPresenceSub =
        pool.subscribeMany(
            RELAYS,

            [
                {
                    kinds: [20000],

                    '#t': [ROOM_TAG],

                    '#room': [
                        currentRoom
                    ],

                    limit: 100
                }
            ],

            {
                onevent(event) {
                    handlePeerPresence(
                        event
                    );
                },

                oneose() {
                    voiceLog(
                        'انتهى تحميل Presence القديم من الـRelays.'
                    );
                },

                onclose() {
                    voiceLog(
                        'تم إغلاق Presence subscription.'
                    );
                }
            }
        );
}


/* =========================================================
   معالجة Peer Presence
========================================================= */

function handlePeerPresence(event) {
    if (!isInRoom) {
        return;
    }

    if (
        event.pubkey === pk
    ) {
        return;
    }

    const room =
        getTag(
            event,
            'room'
        );

    if (
        room !== currentRoom
    ) {
        return;
    }

    let data;

    try {
        data =
            JSON.parse(
                event.content
            );
    } catch (error) {
        voiceError(
            'Presence content غير صالح:',
            event.content
        );

        return;
    }

    const targetPeerId =
        data.peerId ||
        getTag(
            event,
            'peer'
        );

    if (!targetPeerId) {
        voiceError(
            'Presence بدون Peer ID:',
            event.id
        );

        return;
    }

    if (
        targetPeerId === currentPeerId
    ) {
        return;
    }

    knownRoomPeers.set(
        targetPeerId,
        {
            peerId: targetPeerId,
            pubkey: event.pubkey,
            npub:
                data.npub ||
                event.pubkey.slice(0, 8),
            lastSeen:
                Date.now()
        }
    );

    updatePeerListUI();

    /*
     * لا نسمح باتصالين بين نفس الطرفين.
     */
    if (
        activeCalls.has(
            targetPeerId
        )
    ) {
        return;
    }

    /*
     * Deterministic caller:
     * طرف واحد فقط يبدأ الاتصال.
     *
     * هذا يمنع:
     * A -> B
     * B -> A
     * في نفس اللحظة.
     */
    const shouldCall =
        pk < event.pubkey;

    if (!shouldCall) {
        voiceLog(
            'Presence وصل، لكن الطرف الآخر هو initiator:',
            targetPeerId
        );

        return;
    }

    connectToPeer(
        targetPeerId,
        data.npub ||
            event.pubkey.slice(0, 8)
    );
}


/* =========================================================
   الاتصال بطرف آخر
========================================================= */

function connectToPeer(
    targetPeerId,
    displayName
) {
    if (
        !isInRoom ||
        !peer ||
        peer.destroyed
    ) {
        return;
    }

    if (
        !localStream
    ) {
        voiceError(
            'لا يوجد localStream.'
        );

        return;
    }

    if (
        targetPeerId === currentPeerId
    ) {
        return;
    }

    if (
        activeCalls.has(
            targetPeerId
        )
    ) {
        return;
    }

    voiceLog(
        'بدء الاتصال بـ:',
        targetPeerId
    );

    let call;

    try {
        call =
            peer.call(
                targetPeerId,
                localStream,
                {
                    metadata: {
                        room: currentRoom,
                        pubkey: pk,
                        npub: npub
                    }
                }
            );

    } catch (error) {
        voiceError(
            'peer.call فشل:',
            targetPeerId,
            error
        );

        return;
    }

    if (!call) {
        voiceError(
            'PeerJS لم يعطِ MediaConnection.'
        );

        return;
    }

    handleCall(
        call,
        displayName
    );
}


/* =========================================================
   Incoming Call
========================================================= */

function handleIncomingCall(
    call
) {
    if (
        !isInRoom ||
        !localStream
    ) {
        voiceError(
            'Incoming call بينما الغرفة غير جاهزة:',
            call.peer
        );

        try {
            call.close();
        } catch (_) {}

        return;
    }

    voiceLog(
        'الرد على Incoming Call:',
        call.peer
    );

    try {
        call.answer(
            localStream
        );

        handleCall(
            call,
            call.metadata?.npub ||
            call.peer.slice(0, 8)
        );

    } catch (error) {
        voiceError(
            'call.answer فشل:',
            error
        );

        try {
            call.close();
        } catch (_) {}
    }
}


/* =========================================================
   إدارة MediaConnection
========================================================= */

function handleCall(
    call,
    displayName
) {
    const peerId =
        call.peer;

    if (
        activeCalls.has(peerId)
    ) {
        /*
         * لو وصلنا Call ثاني من نفس الشخص،
         * نغلقه ونحتفظ بالأول.
         */
        try {
            call.close();
        } catch (_) {}

        return;
    }

    activeCalls.set(
        peerId,
        {
            call,
            displayName:
                displayName ||
                peerId.slice(0, 8)
        }
    );

    updatePeerListUI();

    voiceLog(
        'MediaConnection registered:',
        peerId
    );

    call.on(
        'stream',
        remoteStream => {
            voiceLog(
                'تم استلام Remote Stream من:',
                peerId
            );

            attachRemoteAudio(
                peerId,
                remoteStream,
                displayName
            );
        }
    );

    call.on(
        'close',
        () => {
            voiceLog(
                'Call closed:',
                peerId
            );

            removePeerCall(
                peerId
            );
        }
    );

    call.on(
        'error',
        error => {
            voiceError(
                'MediaConnection Error:',
                peerId,
                error
            );

            removePeerCall(
                peerId
            );
        }
    );

    /*
     * PeerJS 1.5.2 يمرر RTCPeerConnection
     * ويمكننا مراقبة ICE.
     */
    try {
        const connection =
            call.peerConnection;

        if (
            connection
        ) {
            connection.oniceconnectionstatechange =
                () => {

                    voiceLog(
                        'ICE state:',
                        peerId,
                        connection.iceConnectionState
                    );

                    if (
                        connection.iceConnectionState ===
                        'failed'
                    ) {
                        voiceError(
                            'ICE FAILED:',
                            peerId
                        );

                        showToast(
                            'تعذر إنشاء اتصال WebRTC مع أحد المشاركين. قد تكون الشبكة خلف NAT صعب.',
                            'error'
                        );
                    }

                    if (
                        connection.iceConnectionState ===
                        'connected' ||
                        connection.iceConnectionState ===
                        'completed'
                    ) {
                        voiceLog(
                            'WebRTC connected:',
                            peerId
                        );
                    }
                };
        }

    } catch (error) {
        voiceError(
            'ICE monitor error:',
            error
        );
    }
}


/* =========================================================
   تشغيل الصوت القادم
========================================================= */

function attachRemoteAudio(
    peerId,
    stream,
    displayName
) {
    let audio =
        document.getElementById(
            `audio-${peerId}`
        );

    if (!audio) {
        audio =
            document.createElement(
                'audio'
            );

        audio.id =
            `audio-${peerId}`;

        audio.autoplay = true;
        audio.playsInline = true;
        audio.controls = false;

        /*
         * لا نضع volume = 0.
         */
        audio.volume = 1;

        audio.className =
            'hidden';

        document.body.appendChild(
            audio
        );
    }

    audio.srcObject =
        stream;

    /*
     * play() مهم لأن بعض المتصفحات لا تشغل
     * MediaStream تلقائياً دائماً.
     */
    const playPromise =
        audio.play();

    if (
        playPromise &&
        typeof playPromise.then ===
        'function'
    ) {
        playPromise
            .then(() => {
                voiceLog(
                    'Remote audio بدأ التشغيل:',
                    peerId
                );

                enableMediaSession();
            })
            .catch(error => {
                voiceError(
                    'المتصفح منع تشغيل الصوت:',
                    peerId,
                    error
                );

                showToast(
                    'تم الاتصال لكن المتصفح منع تشغيل الصوت. اضغط مرة داخل الصفحة ثم أعد المحاولة.',
                    'error'
                );

                /*
                 * محاولة إضافية عند أول Gesture.
                 */
                const retry = () => {
                    audio.play()
                        .catch(() => {});

                    window.removeEventListener(
                        'click',
                        retry
                    );

                    window.removeEventListener(
                        'touchstart',
                        retry
                    );
                };

                window.addEventListener(
                    'click',
                    retry,
                    {
                        once: true
                    }
                );

                window.addEventListener(
                    'touchstart',
                    retry,
                    {
                        once: true
                    }
                );
            });
    }

    updatePeerListUI();
}


/* =========================================================
   إزالة Call
========================================================= */

function removePeerCall(
    peerId
) {
    const item =
        activeCalls.get(
            peerId
        );

    if (item) {
        try {
            item.call.close();
        } catch (_) {}
    }

    activeCalls.delete(
        peerId
    );

    const audio =
        document.getElementById(
            `audio-${peerId}`
        );

    if (audio) {
        audio.srcObject = null;
        audio.remove();
    }

    updatePeerListUI();
}


/* =========================================================
   قائمة المشاركين
========================================================= */

function updatePeerListUI() {
    const list =
        document.getElementById(
            'peers-list'
        );

    if (!list) {
        return;
    }

    list.innerHTML = '';

    /*
     * أنا
     */
    if (isInRoom) {
        const me =
            document.createElement(
                'div'
            );

        me.className =
            'flex items-center justify-between bg-orange-50 dark:bg-gray-800 p-2 rounded-lg';

        me.innerHTML = `
            <div class="flex items-center gap-2">
                <div class="w-2 h-2 bg-accent rounded-full"></div>
                <span>أنت</span>
            </div>

            <span class="text-xs text-gray-400">
                ${isMuted ? 'مكتوم' : 'متحدث'}
            </span>
        `;

        list.appendChild(
            me
        );
    }

    const rendered =
        new Set();

    activeCalls.forEach(
        (item, peerId) => {
            rendered.add(
                peerId
            );

            const div =
                document.createElement(
                    'div'
                );

            div.className =
                'flex items-center justify-between bg-gray-50 dark:bg-gray-800 p-2 rounded-lg';

            div.innerHTML = `
                <div class="flex items-center gap-2">
                    <div class="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                    <span>
                        ${escapeHtml(
                            item.displayName ||
                            peerId.slice(0, 8)
                        )}
                    </span>
                </div>

                <span class="text-xs text-green-500">
                    متصل
                </span>
            `;

            list.appendChild(
                div
            );
        }
    );

    /*
     * Participants discovered لكن لم يكتمل اتصال WebRTC بعد.
     */
    knownRoomPeers.forEach(
        (item, peerId) => {
            if (
                rendered.has(peerId)
            ) {
                return;
            }

            if (
                Date.now() -
                item.lastSeen >
                45000
            ) {
                return;
            }

            const div =
                document.createElement(
                    'div'
                );

            div.className =
                'flex items-center justify-between bg-gray-50 dark:bg-gray-800 p-2 rounded-lg';

            div.innerHTML = `
                <div class="flex items-center gap-2">
                    <div class="w-2 h-2 bg-yellow-400 rounded-full animate-pulse"></div>
                    <span>
                        ${escapeHtml(
                            item.npub ||
                            peerId.slice(0, 8)
                        )}
                    </span>
                </div>

                <span class="text-xs text-yellow-500">
                    جاري الاتصال
                </span>
            `;

            list.appendChild(
                div
            );
        }
    );
}


/* =========================================================
   Mute
========================================================= */

function toggleMute() {
    if (!localStream) {
        showToast(
            'لا يوجد ميكروفون نشط.',
            'error'
        );

        return;
    }

    isMuted =
        !isMuted;

    localStream
        .getAudioTracks()
        .forEach(
            track => {
                track.enabled =
                    !isMuted;
            }
        );

    updateMuteUI();

    updatePeerListUI();

    showToast(
        isMuted
            ? 'تم كتم الميكروفون'
            : 'تم تشغيل الميكروفون',
        'info'
    );
}


function updateMuteUI() {
    const button =
        document.getElementById(
            'btn-mute'
        );

    if (!button) {
        return;
    }

    if (isMuted) {
        button.innerHTML =
            '<i class="fas fa-microphone-slash text-red-500"></i>';

        button.classList.add(
            'bg-red-100',
            'text-red-500'
        );

    } else {
        button.innerHTML =
            '<i class="fas fa-microphone"></i>';

        button.classList.remove(
            'bg-red-100',
            'text-red-500'
        );
    }
}


/* =========================================================
   Heartbeat للـPresence
========================================================= */

function startPresenceHeartbeat() {
    stopPresenceHeartbeat();

    presenceTimer =
        setInterval(
            () => {

                if (!isInRoom) {
                    return;
                }

                announcePresence();

                cleanupStaleRoomPeers();

                /*
                 * تحديث إعلان الغرفة.
                 */
                publishRoomActivity()
                    .catch(() => {});

            },
            15000
        );
}


function stopPresenceHeartbeat() {
    if (presenceTimer) {
        clearInterval(
            presenceTimer
        );

        presenceTimer = null;
    }
}


function cleanupStaleRoomPeers() {
    const now =
        Date.now();

    knownRoomPeers.forEach(
        (item, peerId) => {
            if (
                now -
                item.lastSeen >
                45000
            ) {
                knownRoomPeers.delete(
                    peerId
                );

                /*
                 * لو الاتصال نفسه انتهى،
                 * نحذفه.
                 */
                if (
                    activeCalls.has(
                        peerId
                    )
                ) {
                    removePeerCall(
                        peerId
                    );
                }
            }
        }
    );

    updatePeerListUI();
}


/* =========================================================
   إعلان الغرفة - NIP-53 style
========================================================= */

async function publishRoomActivity(
    status = 'live'
) {
    if (
        !currentRoom
    ) {
        return;
    }

    const now =
        Math.floor(
            Date.now() / 1000
        );

    const eventTemplate = {
        /*
         * NIP-53 Live Activity.
         */
        kind: 30311,

        created_at: now,

        tags: [
            [
                'd',
                currentRoom
            ],

            [
                'title',
                getRoomDisplayName(
                    currentRoom
                )
            ],

            [
                'summary',
                'غرفة صوتية مباشرة على Pulse'
            ],

            [
                'status',
                status
            ],

            [
                'starts',
                String(now)
            ],

            [
                'current_participants',
                String(
                    activeCalls.size + 1
                )
            ],

            [
                't',
                ROOM_TAG
            ],

            [
                't',
                currentRoom
            ],

            [
                'relays',
                ...RELAYS
            ],

            [
                'p',
                pk,
                '',
                'Participant'
            ]
        ],

        content: ''
    };

    try {
        await publishEvent(
            eventTemplate
        );

        voiceLog(
            'تم تحديث إعلان الغرفة:',
            currentRoom,
            status
        );

    } catch (error) {
        voiceError(
            'Room Activity publish error:',
            error
        );
    }
}


/* =========================================================
   اكتشاف الغرف المتاحة
========================================================= */

function startRoomDiscovery() {
    if (roomListSub) {
        try {
            roomListSub.close();
        } catch (_) {}
    }

    roomListSub =
        pool.subscribeMany(
            RELAYS,

            [
                {
                    kinds: [30311],

                    '#t': [ROOM_TAG],

                    limit: 100
                }
            ],

            {
                onevent(event) {
                    handleRoomActivity(
                        event
                    );
                },

                oneose() {
                    cleanupRoomList();
                }
            }
        );
}


/*
 * نخزن آخر إعلان لكل:
 *
 * room + pubkey
 *
 * لأن كل مستخدم يملك addressable event مستقل.
 */
const availableRooms =
    new Map();


function handleRoomActivity(
    event
) {
    const room =
        getTag(
            event,
            'd'
        );

    if (!room) {
        return;
    }

    const title =
        getTag(
            event,
            'title'
        ) ||
        getRoomDisplayName(
            room
        );

    const status =
        getTag(
            event,
            'status'
        );

    const participants =
        Number(
            getTag(
                event,
                'current_participants'
            ) || 1
        );

    /*
     * إذا كان الإعلان قديم جداً،
     * لا نعتبره غرفة حية.
     */
    const age =
        Math.floor(
            Date.now() / 1000
        ) -
        event.created_at;

    if (
        age >
        90
    ) {
        return;
    }

    if (
        status !== 'live'
    ) {
        return;
    }

    const key =
        `${room}:${event.pubkey}`;

    availableRooms.set(
        key,
        {
            room,
            title,
            participants,
            pubkey:
                event.pubkey,
            createdAt:
                event.created_at
        }
    );

    renderAvailableRooms();
}


function cleanupRoomList() {
    const now =
        Math.floor(
            Date.now() / 1000
        );

    availableRooms.forEach(
        (room, key) => {

            if (
                now -
                room.createdAt >
                90
            ) {
                availableRooms.delete(
                    key
                );
            }
        }
    );

    renderAvailableRooms();
}


function renderAvailableRooms() {
    const container =
        document.getElementById(
            'available-rooms'
        );

    if (!container) {
        return;
    }

    const now =
        Math.floor(
            Date.now() / 1000
        );

    const grouped =
        new Map();

    availableRooms.forEach(
        item => {

            if (
                now -
                item.createdAt >
                90
            ) {
                return;
            }

            if (
                !grouped.has(
                    item.room
                )
            ) {
                grouped.set(
                    item.room,
                    {
                        room:
                            item.room,
                        title:
                            item.title,
                        participants:
                            0,
                        hosts: 0
                    }
                );
            }

            const room =
                grouped.get(
                    item.room
                );

            room.participants +=
                Math.max(
                    1,
                    item.participants
                );

            room.hosts += 1;
        }
    );

    if (!grouped.size) {
        container.innerHTML = `
            <div class="text-center py-5 text-gray-400 text-sm">
                لا توجد غرف نشطة الآن.
                <br>
                كن أول من يبدأ غرفة 🎙️
            </div>
        `;

        return;
    }

    container.innerHTML = '';

    Array.from(
        grouped.values()
    )
        .sort(
            (a, b) =>
                b.participants -
                a.participants
        )
        .forEach(
            room => {

                const item =
                    document.createElement(
                        'button'
                    );

                item.type =
                    'button';

                item.className =
                    'w-full text-right bg-white dark:bg-surface rounded-2xl p-4 border border-gray-100 dark:border-gray-800 shadow-sm hover:shadow-md transition active:scale-[0.99]';

                item.onclick =
                    () => {
                        const input =
                            document.getElementById(
                                'room-input'
                            );

                        if (input) {
                            input.value =
                                room.room;
                        }

                        switchView(
                            'rooms'
                        );

                        joinRoom(
                            room.room
                        );
                    };

                item.innerHTML = `
                    <div class="flex items-center justify-between">

                        <div class="flex items-center gap-3">

                            <div class="w-11 h-11 rounded-full bg-accent/10 flex items-center justify-center">
                                <i class="fas fa-microphone-lines text-accent"></i>
                            </div>

                            <div>
                                <div class="font-black dark:text-white">
                                    ${escapeHtml(
                                        room.title
                                    )}
                                </div>

                                <div class="text-xs text-gray-400 mt-1">
                                    ${room.participants}
                                    ${room.participants === 1 ? 'شخص' : 'أشخاص'}
                                    متصلون
                                </div>
                            </div>

                        </div>

                        <span class="text-xs font-bold text-green-500">
                            مباشر
                        </span>

                    </div>
                `;

                container.appendChild(
                    item
                );
            }
        );
}


/* =========================================================
   مغادرة الغرفة
========================================================= */

async function leaveRoom(
    intentional = true
) {
    if (
        !isInRoom &&
        !peer &&
        !localStream
    ) {
        return;
    }

    voiceLog(
        'مغادرة الغرفة:',
        currentRoom
    );

    /*
     * نوقف heartbeat أولاً.
     */
    stopPresenceHeartbeat();

    /*
     * تحديث الإعلان إلى ended
     * إذا أمكن.
     */
    if (
        intentional &&
        currentRoom
    ) {
        await publishRoomActivity(
            'ended'
        ).catch(() => {});
    }

    await cleanupVoiceState(
        intentional
    );

    if (intentional) {
        showToast(
            'تمت مغادرة الغرفة',
            'info'
        );
    }
}


/* =========================================================
   تنظيف الصوت
========================================================= */

async function cleanupVoiceState(
    clearSavedRoom
) {
    isInRoom = false;

    /*
     * إغلاق Nostr Presence.
     */
    if (roomPresenceSub) {
        try {
            roomPresenceSub.close();
        } catch (_) {}

        roomPresenceSub = null;
    }

    /*
     * إغلاق المكالمات.
     */
    activeCalls.forEach(
        item => {
            try {
                item.call.close();
            } catch (_) {}
        }
    );

    activeCalls.clear();

    knownRoomPeers.clear();

    /*
     * إزالة Audio elements.
     */
    document
        .querySelectorAll(
            'audio[data-pulse-remote="1"]'
        )
        .forEach(
            audio => {
                audio.srcObject = null;
                audio.remove();
            }
        );

    /*
     * إزالة الصوت القديم المستخدم للـremote.
     */
    document
        .querySelectorAll(
            'audio[id^="audio-pulse-"]'
        )
        .forEach(
            audio => {
                audio.srcObject = null;
                audio.remove();
            }
        );

    /*
     * إيقاف المايك.
     */
    if (localStream) {
        localStream
            .getTracks()
            .forEach(
                track => {
                    track.stop();
                }
            );

        localStream = null;
    }

    /*
     * Peer.destroy مهم جداً.
     */
    if (peer) {
        try {
            peer.destroy();
        } catch (_) {}

        peer = null;
    }

    currentPeerId = null;

    /*
     * إيقاف Background Audio.
     */
    stopBackgroundAudioEngine();

    /*
     * Wake Lock.
     */
    if (wakeLock) {
        try {
            await wakeLock.release();
        } catch (_) {}

        wakeLock = null;
    }

    if (clearSavedRoom) {
        localStorage.removeItem(
            activeRoomStorageKey
        );

        localStorage.removeItem(
            activeVoiceStorageKey
        );

        currentRoom = null;
    }

    updateRoomUI(false);

    updatePeerListUI();
}


/* =========================================================
   Background Audio Engine
   مأخوذ من فكرة المشروع القديم sm
========================================================= */

async function startBackgroundAudioEngine() {
    try {
        if (
            !backgroundAudioContext
        ) {
            backgroundAudioContext =
                new (
                    window.AudioContext ||
                    window.webkitAudioContext
                )();
        }

        if (
            backgroundAudioContext.state ===
            'suspended'
        ) {
            await backgroundAudioContext.resume();
        }

        if (
            !silentAudioElement
        ) {
            const oscillator =
                backgroundAudioContext
                    .createOscillator();

            const gain =
                backgroundAudioContext
                    .createGain();

            const destination =
                backgroundAudioContext
                    .createMediaStreamDestination();

            /*
             * صوت شبه صامت.
             * الهدف إبقاء Media Session نشطة في بعض المتصفحات.
             */
            gain.gain.value =
                0.00001;

            oscillator.connect(
                gain
            );

            gain.connect(
                destination
            );

            oscillator.start();

            silentAudioElement =
                document.createElement(
                    'audio'
                );

            silentAudioElement.id =
                'pulse-keep-alive';

            silentAudioElement.srcObject =
                destination.stream;

            silentAudioElement.autoplay =
                true;

            silentAudioElement.playsInline =
                true;

            silentAudioElement.volume =
                0.01;

            silentAudioElement.style.display =
                'none';

            document.body.appendChild(
                silentAudioElement
            );

            await silentAudioElement
                .play()
                .catch(
                    error => {
                        voiceError(
                            'Background audio play blocked:',
                            error
                        );
                    }
                );
        } else {
            await silentAudioElement
                .play()
                .catch(() => {});
        }

        enableMediaSession();

    } catch (error) {
        /*
         * عدم نجاح هذا الجزء لا يمنع WebRTC.
         */
        voiceError(
            'Background Audio Engine Error:',
            error
        );
    }
}


function stopBackgroundAudioEngine() {
    if (
        silentAudioElement
    ) {
        try {
            silentAudioElement.pause();
        } catch (_) {}

        silentAudioElement.srcObject =
            null;

        silentAudioElement.remove();

        silentAudioElement =
            null;
    }

    if (
        backgroundAudioContext
    ) {
        try {
            backgroundAudioContext.close();
        } catch (_) {}

        backgroundAudioContext =
            null;
    }
}


/* =========================================================
   Media Session
========================================================= */

function enableMediaSession() {
    if (
        !('mediaSession' in navigator)
    ) {
        return;
    }

    try {
        navigator.mediaSession.metadata =
            new MediaMetadata({
                title:
                    currentRoom
                        ? `Pulse - ${getRoomDisplayName(currentRoom)}`
                        : 'Pulse Live Voice',

                artist:
                    'غرفة صوتية مباشرة',

                album:
                    'Pulse'
            });

        navigator.mediaSession.playbackState =
            'playing';

        try {
            navigator.mediaSession.setActionHandler(
                'play',
                () => {
                    if (
                        backgroundAudioContext &&
                        backgroundAudioContext.state ===
                        'suspended'
                    ) {
                        backgroundAudioContext
                            .resume();
                    }

                    if (
                        silentAudioElement
                    ) {
                        silentAudioElement
                            .play()
                            .catch(() => {});
                    }

                    document
                        .querySelectorAll(
                            'audio[id^="audio-"]'
                        )
                        .forEach(
                            audio => {
                                audio
                                    .play()
                                    .catch(() => {});
                            }
                        );
                }
            );
        } catch (_) {}

        try {
            navigator.mediaSession.setActionHandler(
                'pause',
                () => {
                    /*
                     * لا نفعل شيئاً.
                     * لا نريد Media Session أن توقف الغرفة.
                     */
                }
            );
        } catch (_) {}

    } catch (error) {
        voiceError(
            'MediaSession Error:',
            error
        );
    }
}


/* =========================================================
   Wake Lock
========================================================= */

async function requestWakeLock() {
    if (
        !('wakeLock' in navigator)
    ) {
        voiceLog(
            'Wake Lock غير مدعوم.'
        );

        return;
    }

    try {
        wakeLock =
            await navigator.wakeLock.request(
                'screen'
            );

        voiceLog(
            'Wake Lock enabled.'
        );

        wakeLock.addEventListener(
            'release',
            () => {
                voiceLog(
                    'Wake Lock released.'
                );
            }
        );

    } catch (error) {
        /*
         * اختياري، ولا يمنع الصوت.
         */
        voiceError(
            'Wake Lock Error:',
            error
        );
    }
}


/* =========================================================
   Voice Activity Detection
========================================================= */

let vadTimer = null;

function setupVoiceActivityDetection() {
    if (
        !localStream
    ) {
        return;
    }

    try {
        if (!audioContext) {
            audioContext =
                new (
                    window.AudioContext ||
                    window.webkitAudioContext
                )();
        }

        if (
            audioContext.state ===
            'suspended'
        ) {
            audioContext.resume()
                .catch(() => {});
        }

        const source =
            audioContext
                .createMediaStreamSource(
                    localStream
                );

        const analyser =
            audioContext
                .createAnalyser();

        analyser.fftSize =
            256;

        source.connect(
            analyser
        );

        const data =
            new Uint8Array(
                analyser.frequencyBinCount
            );

        if (vadTimer) {
            clearInterval(
                vadTimer
            );
        }

        vadTimer =
            setInterval(
                () => {

                    if (!isInRoom) {
                        clearInterval(
                            vadTimer
                        );

                        vadTimer =
                            null;

                        return;
                    }

                    if (isMuted) {
                        return;
                    }

                    analyser.getByteFrequencyData(
                        data
                    );

                    let total = 0;

                    for (
                        let i = 0;
                        i < data.length;
                        i++
                    ) {
                        total +=
                            data[i];
                    }

                    const volume =
                        total /
                        data.length;

                    /*
                     * يمكن لاحقاً ربط هذا
                     * animation بالـUI.
                     */
                    if (
                        volume > 12
                    ) {
                        document
                            .getElementById(
                                'current-room-name'
                            )
                            ?.classList.add(
                                'text-accent'
                            );
                    } else {
                        document
                            .getElementById(
                                'current-room-name'
                            )
                            ?.classList.remove(
                                'text-accent'
                            );
                    }

                },
                200
            );

    } catch (error) {
        voiceError(
            'VAD Error:',
            error
        );
    }
}


/* =========================================================
   Refresh / Rejoin
========================================================= */

async function tryRestoreVoiceRoom() {
    const savedRoom =
        localStorage.getItem(
            activeRoomStorageKey
        );

    const wasActive =
        localStorage.getItem(
            activeVoiceStorageKey
        );

    if (
        !savedRoom ||
        wasActive !== '1'
    ) {
        return;
    }

    const input =
        document.getElementById(
            'room-input'
        );

    if (input) {
        input.value =
            savedRoom;
    }

    /*
     * مهم:
     * لا نستخدم toggleRoom() هنا.
     *
     * الكود القديم كان يضع currentRoom
     * ثم يستدعي toggleRoom، فيفهم الحالة
     * كأن المستخدم داخل الغرفة ويخرج منها.
     */
    setTimeout(
        async () => {

            if (isInRoom) {
                return;
            }

            voiceLog(
                'محاولة استعادة الغرفة بعد Refresh:',
                savedRoom
            );

            try {
                await joinRoom(
                    savedRoom
                );

            } catch (error) {
                voiceError(
                    'Auto Rejoin failed:',
                    error
                );

                showToast(
                    'احتفظنا بالغرفة السابقة، اضغط دخول لإعادة الاتصال.',
                    'info'
                );
            }

        },
        1200
    );
}


/* =========================================================
   تغيير الـViews
========================================================= */

function switchView(viewName) {
    document
        .querySelectorAll(
            '.view-section'
        )
        .forEach(
            section => {
                section.classList.add(
                    'hidden'
                );
            }
        );

    const target =
        document.getElementById(
            `view-${viewName}`
        );

    if (target) {
        target.classList.remove(
            'hidden'
        );
    }

    document
        .querySelectorAll(
            '.nav-btn'
        )
        .forEach(
            button => {
                button.classList.remove(
                    'text-accent',
                    'active'
                );

                button.classList.add(
                    'text-gray-400'
                );
            }
        );

    const activeButton =
        document.getElementById(
            `nav-${viewName}`
        );

    if (activeButton) {
        activeButton.classList.add(
            'text-accent',
            'active'
        );

        activeButton.classList.remove(
            'text-gray-400'
        );
    }
}


/* =========================================================
   Theme
========================================================= */

function toggleTheme() {
    document.documentElement
        .classList.toggle(
            'dark'
        );

    localStorage.setItem(
        'theme',
        document.documentElement
            .classList.contains('dark')
            ? 'dark'
            : 'light'
    );
}


/* =========================================================
   تنظيف عند إغلاق الصفحة
========================================================= */

window.addEventListener(
    'beforeunload',
    () => {

        /*
         * لا نحذف activeRoom من localStorage.
         *
         * السبب:
         * Refresh ≠ Leave.
         *
         * نريد أن يعرف التطبيق أن المستخدم
         * كان داخل غرفة حتى يعيد الاتصال.
         */

        stopPresenceHeartbeat();

        if (
            roomPresenceSub
        ) {
            try {
                roomPresenceSub.close();
            } catch (_) {}
        }

        /*
         * لا نستطيع الاعتماد على async هنا.
         * نترك PeerJS والمتصفح يغلقان الاتصال.
         */
    }
);


/* =========================================================
   إعادة Wake Lock عند العودة للصفحة
========================================================= */

document.addEventListener(
    'visibilitychange',
    async () => {

        if (
            document.visibilityState ===
            'visible' &&
            isInRoom
        ) {
            if (
                backgroundAudioContext &&
                backgroundAudioContext.state ===
                'suspended'
            ) {
                backgroundAudioContext
                    .resume()
                    .catch(() => {});
            }

            document
                .querySelectorAll(
                    'audio[id^="audio-"]'
                )
                .forEach(
                    audio => {
                        audio
                            .play()
                            .catch(() => {});
                    }
                );

            if (!wakeLock) {
                await requestWakeLock();
            }

            /*
             * إعادة إعلان وجودنا.
             */
            announcePresence();
        }
    }
);


/* =========================================================
   Service Worker
========================================================= */

if (
    'serviceWorker' in navigator
) {
    window.addEventListener(
        'load',
        () => {
            navigator.serviceWorker
                .register('./sw.js')
                .then(
                    () => {
                        log(
                            'Service Worker Registered.'
                        );
                    }
                )
                .catch(
                    error => {
                        console.error(
                            'SW Registration Error:',
                            error
                        );
                    }
                );
        }
    );
}


/* =========================================================
   Boot
========================================================= */

document.addEventListener(
    'DOMContentLoaded',
    async () => {

        log(
            'Pulse booting...'
        );

        /*
         * Theme.
         */
        if (
            localStorage.getItem(
                'theme'
            ) === 'dark' ||

            (
                !localStorage.getItem(
                    'theme'
                ) &&
                window.matchMedia(
                    '(prefers-color-scheme: dark)'
                ).matches
            )
        ) {
            document.documentElement
                .classList.add(
                    'dark'
                );
        }

        /*
         * Nostr identity.
         */
        try {
            initIdentity();
            initNostr();

        } catch (error) {
            console.error(
                'Boot identity error:',
                error
            );

            return;
        }

        /*
         * Feed.
         */
        startFeed();

        /*
         * Discover rooms.
         */
        startRoomDiscovery();

        /*
         * تنظيف قائمة الغرف دورياً.
         */
        setInterval(
            cleanupRoomList,
            30000
        );

        /*
         * إصلاح مشكلة Refresh:
         * نعيد الاتصال بالغرفة السابقة بدلاً من
         * استدعاء toggleRoom بشكل خاطئ.
         */
        await tryRestoreVoiceRoom();

        log(
            'Pulse boot completed.'
        );
    }
);


/* =========================================================
   تصدير الدوال المطلوبة من HTML
========================================================= */

window.publishPost =
    publishPost;

window.likePost =
    likePost;

window.replyToPost =
    replyToPost;

window.toggleRoom =
    toggleRoom;

window.joinRoom =
    joinRoom;

window.leaveRoom =
    leaveRoom;

window.toggleMute =
    toggleMute;

window.switchView =
    switchView;

window.toggleTheme =
    toggleTheme;
